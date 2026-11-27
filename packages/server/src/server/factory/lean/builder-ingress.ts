import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { isAbsolute, join } from "node:path";
import { projectFactoryClaimBranch } from "@getpaseo/server/factory-project";

import {
  BUILDER_UPLOAD_WIRE_LIMIT_BYTES,
  BuilderGitRefusal,
  builderPublishInput,
  createBuilderGit,
  type BuilderGitDependencies,
  type BuilderPublishReceipt,
} from "./builder-git.js";
import {
  builderGitInputSchemas,
  builderGitMethods,
  invokeBuilderGit,
} from "./builder-git-tools.js";
import {
  builderUploadRequest,
  type BuilderUploadRequest,
  type BuilderUploadSession,
} from "./builder-upload.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import { LEAN_PROTOCOL_MAJOR, type LeanLedger, type LeanStateStore } from "./types.js";
import type { BuilderWorkspacePublication } from "./runner-workspaces.js";

const UPLOAD_TIMEOUT_MS = 15_000;

export interface BuilderIngressRegistration {
  agentId: string;
  projectId: string;
  issue: number;
  workspaceId: string;
  cwd: string;
}

export interface BuilderIngressBinding extends BuilderIngressRegistration {
  /** Current daemon-verified lease epoch. */
  epoch: number;
  planId: string;
  approvedPaths: readonly string[];
}

type BuilderMethod = (typeof builderGitMethods)[keyof typeof builderGitMethods];
type Received = ReturnType<typeof builderPublishInput.parse>;

export interface BuilderIngressDependencies {
  /** Trusted short root for private socket directories. No workspace or guest mount. */
  socketRoot: string;
  /** Authenticate the current local Builder, its active lease, workspace and intake authority. */
  currentBinding(agentId: string): Promise<BuilderIngressBinding | null>;
  runUploader(input: BuilderUploadSession): Promise<void>;
  invokeGit(request: {
    binding: BuilderIngressBinding;
    method: BuilderMethod;
    input: unknown;
    /** Include this check in BuilderGitDependencies.allowWrites at the real write boundary. */
    isCurrent(): Promise<boolean>;
  }): Promise<unknown>;
}

interface Registered {
  scope: BuilderIngressRegistration;
  active: AbortController | null;
}

export function createBuilderIngress(deps: BuilderIngressDependencies) {
  if (!isAbsolute(deps.socketRoot))
    throw new BuilderGitRefusal("A verified local Builder socket root is required.");
  const sessions = new Map<string, Registered>();
  let closed = false;

  function revoke(agentId: string): void {
    const existing = sessions.get(agentId);
    sessions.delete(agentId);
    existing?.active?.abort();
  }

  async function register(scope: BuilderIngressRegistration): Promise<void> {
    if (closed) throw new BuilderGitRefusal("The Builder upload bridge is closing.");
    const registered = { ...scope, cwd: await realpath(scope.cwd) };
    if (closed) throw new BuilderGitRefusal("The Builder upload bridge is closing.");
    const existing = sessions.get(scope.agentId);
    if (existing && sameScope(registered, existing.scope)) return;
    revoke(scope.agentId);
    sessions.set(scope.agentId, { scope: registered, active: null });
  }

  async function claim(callerAgentId: string) {
    const session = sessions.get(callerAgentId);
    const current = await deps.currentBinding(callerAgentId);
    if (
      !session ||
      !current ||
      !sameScope(session.scope, current) ||
      !Number.isSafeInteger(current.epoch) ||
      current.epoch < 1
    ) {
      throw new BuilderGitRefusal(
        "This caller is not the active Builder for the registered workspace.",
      );
    }
    if (session.active || sessions.get(callerAgentId) !== session) {
      throw new BuilderGitRefusal(
        "This Builder already has an active upload or its binding changed.",
      );
    }
    const controller = new AbortController();
    session.active = controller;
    return { session, binding: current, controller };
  }

  async function invoke(callerAgentId: string, method: string, raw: unknown): Promise<unknown> {
    if (!isBuilderMethod(method)) throw new BuilderGitRefusal("Unknown Builder Git operation.");
    const { session, binding, controller } = await claim(callerAgentId);
    const isCurrent = async () => {
      if (controller.signal.aborted || sessions.get(callerAgentId) !== session) return false;
      const active = await deps.currentBinding(callerAgentId);
      return (
        !controller.signal.aborted &&
        sessions.get(callerAgentId) === session &&
        active !== null &&
        sameScope(active, binding) &&
        active.epoch === binding.epoch &&
        active.planId === binding.planId
      );
    };
    try {
      const readSchema = builderGitInputSchemas[method];
      const request =
        method === builderGitMethods.publish
          ? builderUploadRequest.parse(raw)
          : readSchema.parse(raw);
      if (request.issue !== binding.issue || !(await isCurrent())) {
        throw new BuilderGitRefusal("This request is outside the current Builder issue lease.");
      }
      const input =
        method === builderGitMethods.publish
          ? await collectUpload(
              deps,
              binding,
              approvedUpload(request, binding.approvedPaths),
              controller,
            )
          : request;
      if (!(await isCurrent()))
        throw new BuilderGitRefusal("The Builder lease changed during upload.");
      return await deps.invokeGit({ binding, method, input, isCurrent });
    } finally {
      controller.abort();
      if (session.active === controller) session.active = null;
    }
  }

  return {
    register,
    revoke,
    invoke,
    close() {
      closed = true;
      for (const agentId of sessions.keys()) revoke(agentId);
    },
  };
}

function approvedUpload(raw: unknown, approvedPaths: readonly string[]): BuilderUploadRequest {
  const request = builderUploadRequest.parse(raw);
  const allowed = new Set(approvedPaths);
  if (request.files.some(({ path }) => !allowed.has(path))) {
    throw new BuilderGitRefusal(
      "The upload includes a file outside the authenticated Builder plan.",
    );
  }
  return request;
}

export type BuilderIngress = ReturnType<typeof createBuilderIngress>;

/** Keeps the captured lease epoch in the real Git boundary's repeated authority check. */
export function createBuilderGitInvocation(
  readProject: (projectId: string) => Promise<BuilderGitDependencies | null>,
): BuilderIngressDependencies["invokeGit"] {
  return async ({ binding, input, method, isCurrent }) => {
    const project = await readProject(binding.projectId);
    if (!project || project.projectId !== binding.projectId || !(await isCurrent())) {
      throw new BuilderGitRefusal("The authenticated Builder project is unavailable.");
    }
    const runtime = createBuilderGit({
      ...project,
      async allowWrites() {
        return (await isCurrent()) && (await project.allowWrites());
      },
    });
    return invokeBuilderGit(runtime, binding.agentId, method, input);
  };
}

interface BindingReaderDependencies {
  projectId: string;
  installation: string;
  state: LeanStateStore;
  agents: Pick<AgentStorage, "get">;
  workspaces: Pick<WorkspaceRegistry, "get">;
  now(): Date;
  /** Null if this installation does not currently hold active intake authority. */
  readIntakeEpoch(): Promise<number | null>;
  /** Read the daemon's current approved plan for the exact active Builder. */
  readApprovedPlan(
    agentId: string,
    issue: number,
  ): Promise<{
    planId: string;
    approvedPaths: readonly string[];
  } | null>;
}

export function createBuilderBindingReader(deps: BindingReaderDependencies) {
  return async (agentId: string): Promise<BuilderIngressBinding | null> => {
    const [ledger, stored, epoch] = await Promise.all([
      deps.state.read(deps.projectId),
      deps.agents.get(agentId),
      deps.readIntakeEpoch(),
    ]);
    const held = stored?.config?.usageLimitHold;
    if (epoch === null || !stored?.workspaceId || stored.archivedAt || (held && !held.releasedAt))
      return null;
    const assigned = activeBuilderIssue(ledger, agentId, deps.installation, +deps.now());
    if (!assigned) return null;
    const { issue, branch } = assigned;
    const workspace = await deps.workspaces.get(stored.workspaceId);
    if (
      !workspace ||
      workspace.archivedAt ||
      workspace.projectId !== deps.projectId ||
      workspace.kind !== "worktree" ||
      workspace.branch !== branch
    )
      return null;
    const plan = await deps.readApprovedPlan(agentId, issue);
    if (!plan) return null;
    return {
      agentId,
      projectId: deps.projectId,
      workspaceId: workspace.workspaceId,
      cwd: await realpath(workspace.cwd),
      issue,
      epoch,
      ...plan,
    };
  };
}

function activeBuilderIssue(
  ledger: LeanLedger,
  agentId: string,
  installation: string,
  now: number,
) {
  const runner = ledger.runners[agentId];
  if (
    runner?.agentId !== agentId ||
    runner.role !== "lead" ||
    runner.serverId !== null ||
    runner.issue === null ||
    runner.closedAt !== null
  )
    return null;
  const issue = runner.issue;
  const branch = projectFactoryClaimBranch(issue);
  const lease = ledger.leases[issue];
  if (
    lease?.issue !== issue ||
    lease.installation !== installation ||
    lease.branch !== branch ||
    lease.released ||
    lease.protocol !== LEAN_PROTOCOL_MAJOR ||
    !(Date.parse(lease.expiresAt) > now)
  )
    return null;
  return { issue, branch };
}

interface PublicationLedger extends LeanLedger {
  builderPublications?: { [key: string]: BuilderPublishReceipt };
}

/** Use only with a freshly verified remote claim head, as in the resolver and close guard. */
export function createBuilderPublicationVerifier(state: LeanStateStore, projectId: string) {
  return async (input: BuilderWorkspacePublication): Promise<boolean> => {
    const ledger: PublicationLedger = await state.read(projectId);
    const branch = projectFactoryClaimBranch(input.issue);
    const receipts = new Map<string, string>();
    for (const receipt of Object.values(ledger.builderPublications ?? {})) {
      if (
        receipt.issue === input.issue &&
        receipt.workspaceId === input.workspaceId &&
        receipt.branch === branch
      ) {
        receipts.set(receipt.head, receipt.previousHead);
      }
    }
    let current = input.remoteHead;
    const visited = new Set<string>();
    while (current !== input.workspaceHead) {
      const previous = receipts.get(current);
      if (!previous || visited.has(current)) return false;
      visited.add(current);
      current = previous;
    }
    return true;
  };
}

function isBuilderMethod(method: string): method is BuilderMethod {
  return Object.values(builderGitMethods).some((value) => value === method);
}

function sameScope(left: BuilderIngressRegistration, right: BuilderIngressRegistration): boolean {
  return (
    left.agentId === right.agentId &&
    left.projectId === right.projectId &&
    left.issue === right.issue &&
    left.workspaceId === right.workspaceId &&
    left.cwd === right.cwd
  );
}

async function collectUpload(
  deps: BuilderIngressDependencies,
  binding: BuilderIngressBinding,
  input: BuilderUploadRequest,
  controller: AbortController,
): Promise<Received> {
  const root = await realpath(deps.socketRoot);
  const directory = await mkdtemp(join(root, "bld-"));
  try {
    const dirStat = await lstat(directory);
    if (
      !dirStat.isDirectory() ||
      dirStat.uid !== process.getuid?.() ||
      (dirStat.mode & 0o077) !== 0
    ) {
      throw new BuilderGitRefusal("The private Builder socket directory could not be verified.");
    }
    const socketPath = join(directory, "upload.sock");
    if (Buffer.byteLength(socketPath) >= 104)
      throw new BuilderGitRefusal("The private Builder socket path is too long.");
    const token = randomBytes(32).toString("base64url");
    let uploaded: Received | null = null;
    const endpoint = uploadServer(
      token,
      input,
      (value) => {
        uploaded = value;
      },
      controller.signal,
    );
    endpoint.on("error", () => controller.abort());
    try {
      await listen(endpoint, socketPath);
      await chmod(socketPath, 0o600);
      const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
      try {
        await deps.runUploader({
          workspace: binding.cwd,
          socketDirectory: directory,
          socketPath,
          token,
          input,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!uploaded || controller.signal.aborted)
        throw new BuilderGitRefusal("The private Builder upload did not complete.");
      return uploaded;
    } finally {
      endpoint.closeAllConnections();
      if (endpoint.listening) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function uploadServer(
  token: string,
  input: BuilderUploadRequest,
  accept: (value: Received) => void,
  signal: AbortSignal,
): Server {
  let used = false;
  const server = createServer(
    { requestTimeout: UPLOAD_TIMEOUT_MS, headersTimeout: UPLOAD_TIMEOUT_MS },
    (request, response) => {
      const supplied = request.headers.authorization ?? "";
      if (
        used ||
        signal.aborted ||
        request.method !== "POST" ||
        request.url !== "/upload" ||
        !sameToken(supplied, `Bearer ${token}`)
      ) {
        response.writeHead(403, { connection: "close" }).end();
        return;
      }
      used = true;
      void readUpload(request, input).then(
        (value) => {
          if (signal.aborted) {
            response.writeHead(409, { connection: "close" }).end();
            return undefined;
          }
          accept(value);
          response.writeHead(204, { connection: "close" }).end();
          return undefined;
        },
        () => {
          response.writeHead(400, { connection: "close" }).end();
          return undefined;
        },
      );
    },
  );
  server.maxConnections = 2;
  return server;
}

async function readUpload(
  request: IncomingMessage,
  input: BuilderUploadRequest,
): Promise<Received> {
  const announced = Number(request.headers["content-length"]);
  if (
    !Number.isSafeInteger(announced) ||
    announced < 1 ||
    announced > BUILDER_UPLOAD_WIRE_LIMIT_BYTES
  ) {
    throw new BuilderGitRefusal("Upload body exceeds its bounded wire size.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > announced) throw new BuilderGitRefusal("Upload body exceeds its bounded wire size.");
    chunks.push(bytes);
  }
  if (size !== announced) throw new BuilderGitRefusal("The private Builder upload was incomplete.");
  const parsed = builderPublishInput.parse(
    JSON.parse(Buffer.concat(chunks, size).toString("utf8")),
  );
  const requested = input.files.map(({ path, kind }) => [path, kind]);
  const delivered = parsed.changes.map(({ path, kind }) => [path, kind]);
  if (
    parsed.issue !== input.issue ||
    parsed.expectedHead !== input.expectedHead ||
    parsed.message !== input.message ||
    JSON.stringify(requested) !== JSON.stringify(delivered)
  ) {
    throw new BuilderGitRefusal("The upload did not match the authenticated Builder request.");
  }
  return parsed;
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
