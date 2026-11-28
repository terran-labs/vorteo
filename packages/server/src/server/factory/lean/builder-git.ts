import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { projectFactoryClaimBranch } from "@getpaseo/server/factory-project";
import { z } from "zod";

import { OWNER_ONLY_FILES, type FactoryGitHub } from "../project/claims.js";
import type { ClaimSnapshot, MachineLeasePort } from "./machines/claims.js";
import { LEAN_PROTOCOL_MAJOR, type LeanLedger, type LeanStateStore } from "./types.js";

export const BUILDER_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_BASE64_CHARS = Math.ceil(BUILDER_UPLOAD_LIMIT_BYTES / 3) * 4;
/** Enforce before decoding JSON at the authenticated transport boundary. */
export const BUILDER_UPLOAD_WIRE_LIMIT_BYTES = MAX_BASE64_CHARS + 160 * 1024;
const head = z.string().regex(/^[a-f0-9]{40}$/);
const issueNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pathInput = z.string().min(1).max(512);
const reservedText =
  /<!--\s*factory-|\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+(?:#\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/github\.com\/)/i;
const change = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("delete"), path: pathInput }),
  z.strictObject({
    kind: z.literal("write"),
    path: pathInput,
    base64: z.string().max(MAX_BASE64_CHARS),
    executable: z.boolean(),
  }),
]);
export const builderPublishInput = z.strictObject({
  issue: issueNumber,
  expectedHead: head,
  message: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((value) => !value.includes("\0") && !reservedText.test(value)),
  changes: z.array(change).min(1).max(MAX_FILES),
});
export const builderOpenPullInput = z.strictObject({
  issue: issueNumber,
  expectedHead: head,
  title: z.string().trim().min(1).max(240),
  body: z
    .string()
    .trim()
    .max(16_000)
    .refine((value) => !reservedText.test(value)),
});

type PublishInput = z.infer<typeof builderPublishInput>;
type OpenPullInput = z.infer<typeof builderOpenPullInput>;
type Change = z.infer<typeof change>;

export interface BuilderGitAuthority {
  workspaceId: string;
  /** Stable identity of the daemon-approved plan revision for this Builder. */
  planId: string;
  approvedPaths: readonly string[];
  protectedPaths: readonly string[];
  baseBranch: string;
}

interface BuilderBinding {
  agentId: string;
  issue: number;
  branch: string;
  authority: BuilderGitAuthority;
  machineClaim?: BuilderClaimBinding;
}

interface BuilderClaimBinding {
  issue: number;
  generation: string;
  providerType: string;
}

export interface BuilderPublishReceipt {
  issue: number;
  builderAgentId: string;
  workspaceId: string;
  planId: string;
  branch: string;
  previousHead: string;
  head: string;
  paths: string[];
  preparedAt: string;
  pushedAt: string | null;
  claimGeneration?: string;
  builderProviderType?: string;
}

interface ReceiptLedger extends LeanLedger {
  builderPublications?: { [key: string]: BuilderPublishReceipt };
}

export interface BuilderGitDependencies {
  projectId: string;
  installation: string;
  repository: string;
  /** Daemon-owned directory outside all issue workspaces. */
  privateRoot: string;
  state: LeanStateStore;
  github: FactoryGitHub;
  now(): Date;
  /** Read local caller/workspace identity, authenticated issue facts and the recorded approved plan. */
  readAuthority(callerAgentId: string, issue: number): Promise<BuilderGitAuthority | null>;
  /** Authorize Builder writes in live/rehearsal mode and fence dry runs, foreign and paused projects. */
  allowWrites(): Promise<boolean>;
  /** Enabled only for projects using verified, signed machine claims. */
  machineClaims?: Pick<MachineLeasePort, "readClaim">;
}

interface Bytes {
  path: string;
  data: Buffer | null;
  mode: "100644" | "100755";
}

const remoteRef = z.object({ ref: z.string(), object: z.object({ sha: head }) });
const refRepo = z.object({ full_name: z.string() });
const pull = z.object({
  number: issueNumber,
  state: z.literal("open"),
  head: z.object({ sha: head, ref: z.string(), repo: refRepo }),
  base: z.object({ ref: z.string(), repo: refRepo }),
});

export class BuilderGitRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderGitRefusal";
  }
}

export function createBuilderGit(deps: BuilderGitDependencies) {
  if (
    !isAbsolute(deps.privateRoot) ||
    !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(deps.repository) ||
    /\/\.{1,2}$/.test(deps.repository)
  ) {
    throw new BuilderGitRefusal(
      "Builder Git needs a daemon-owned workspace and a configured repository.",
    );
  }
  const prefix = `repos/${deps.repository}`;
  const remote = `https://github.com/${deps.repository}.git`;
  const owner = deps.repository.split("/")[0];
  const machineClaims = deps.machineClaims;
  let tail = Promise.resolve();

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const work = tail.then(action);
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  async function bind(callerAgentId: string, issue: number): Promise<BuilderBinding> {
    if (!(await deps.allowWrites()))
      throw new BuilderGitRefusal("Factory Builder writes are disabled.");
    const [ledger, authority] = await Promise.all([
      deps.state.read(deps.projectId),
      deps.readAuthority(callerAgentId, issue),
    ]);
    const runner = ledger.runners[callerAgentId];
    const branch = projectFactoryClaimBranch(issue);
    const lease = ledger.leases[issue];
    if (
      runner?.role !== "lead" ||
      runner.agentId !== callerAgentId ||
      runner.serverId !== null ||
      runner.issue !== issue ||
      runner.closedAt !== null ||
      !authority
    ) {
      throw new BuilderGitRefusal(
        "Only the active, authenticated Builder for this issue may publish.",
      );
    }
    requireLocalLease(lease, issue, branch);
    const binding: BuilderBinding = { agentId: callerAgentId, issue, branch, authority };
    if (machineClaims) {
      if (!runner.providerType) {
        throw new BuilderGitRefusal("The authenticated Builder has no recorded provider.");
      }
      const claim = await ownMachineClaim(issue);
      const machineClaim = {
        issue,
        generation: claim.record.generation,
        providerType: runner.providerType,
      };
      const launch = ledger.hostBuilderAssignments?.[callerAgentId];
      if (
        !launch ||
        launch.issue !== issue ||
        launch.branch !== branch ||
        launch.workspaceId !== authority.workspaceId ||
        launch.account !== runner.account ||
        launch.generation !== machineClaim.generation
      ) {
        throw new BuilderGitRefusal("The Builder has no matching launch for this machine claim.");
      }
      binding.machineClaim = machineClaim;
    }
    return binding;
  }

  function requireLocalLease(
    lease: LeanLedger["leases"][string] | undefined,
    issue: number,
    branch: string,
  ): void {
    if (
      lease?.issue !== issue ||
      lease.branch !== branch ||
      lease.installation !== deps.installation ||
      lease.protocol !== LEAN_PROTOCOL_MAJOR ||
      lease.released ||
      !(Date.parse(lease.expiresAt) > +deps.now())
    ) {
      throw new BuilderGitRefusal("Factory no longer holds the issue's assigned branch.");
    }
  }

  async function ownMachineClaim(issue: number, generation?: string): Promise<ClaimSnapshot> {
    const claim = await machineClaims?.readClaim(issue);
    if (
      !claim ||
      claim.record.installation !== deps.installation ||
      claim.record.released ||
      claim.record.expiresAt * 1000 <= +deps.now() ||
      (generation !== undefined && generation !== claim.record.generation)
    ) {
      throw new BuilderGitRefusal("The Builder no longer holds its signed machine claim.");
    }
    return claim;
  }

  async function requireSame(binding: BuilderBinding, paths: string[]): Promise<void> {
    const fresh = await bind(binding.agentId, binding.issue);
    const before = binding.authority;
    const after = fresh.authority;
    if (
      before.workspaceId !== after.workspaceId ||
      before.planId !== after.planId ||
      before.baseBranch !== after.baseBranch ||
      binding.machineClaim?.generation !== fresh.machineClaim?.generation ||
      binding.machineClaim?.providerType !== fresh.machineClaim?.providerType
    ) {
      throw new BuilderGitRefusal("The Builder binding changed before publication.");
    }
    assertApproved(paths, after);
  }

  async function branchHead(branch: string): Promise<string> {
    const { status, body } = await deps.github.rest("GET", `${prefix}/git/ref/heads/${branch}`);
    const ref = remoteRef.safeParse(body);
    if (status !== 200 || !ref.success || ref.data.ref !== `refs/heads/${branch}`) {
      throw new BuilderGitRefusal("Factory could not verify the assigned remote branch.");
    }
    return ref.data.object.sha;
  }

  async function finish(
    key: string,
    receipt: BuilderPublishReceipt,
  ): Promise<BuilderPublishReceipt> {
    await deps.state.mutate(deps.projectId, (ledger: ReceiptLedger) => {
      const saved = ledger.builderPublications?.[key];
      if (
        !saved ||
        saved.head !== receipt.head ||
        saved.claimGeneration !== receipt.claimGeneration ||
        saved.builderProviderType !== receipt.builderProviderType
      )
        throw new BuilderGitRefusal("The saved publication receipt changed.");
      saved.pushedAt ??= deps.now().toISOString();
    });
    const updated: ReceiptLedger = await deps.state.read(deps.projectId);
    return updated.builderPublications?.[key] ?? receipt;
  }

  async function publish(caller: string, input: PublishInput): Promise<BuilderPublishReceipt> {
    const binding = await bind(caller, input.issue);
    const changes = unpack(input.changes);
    const paths = changes.map((entry) => entry.path);
    assertApproved(paths, binding.authority);
    const key = publicationKey(binding, input, changes);
    const saved: ReceiptLedger = await deps.state.read(deps.projectId);
    const prior = saved.builderPublications?.[key];
    const actual = await branchHead(binding.branch);
    if (prior?.head === actual) {
      await requireSame(binding, paths);
      return finish(key, prior);
    }
    if (actual !== input.expectedHead)
      throw new BuilderGitRefusal("The claim branch changed. Read its new head before retrying.");

    const ref = `refs/heads/${binding.branch}`;
    await mkdir(deps.privateRoot, { recursive: true, mode: 0o700 });
    if (!(await lstat(deps.privateRoot)).isDirectory()) {
      throw new BuilderGitRefusal("The private Builder Git directory identity changed.");
    }
    const isolated = await mkdtemp(join(await realpath(deps.privateRoot), "publish-"));
    try {
      const at = prior?.preparedAt ?? deps.now().toISOString();
      const commit = await createCommit(isolated, { ref, remote, input, changes, at });
      const receipt: BuilderPublishReceipt = {
        issue: binding.issue,
        builderAgentId: caller,
        workspaceId: binding.authority.workspaceId,
        planId: binding.authority.planId,
        branch: binding.branch,
        previousHead: input.expectedHead,
        head: commit,
        paths,
        preparedAt: at,
        pushedAt: null,
        ...(binding.machineClaim
          ? {
              claimGeneration: binding.machineClaim.generation,
              builderProviderType: binding.machineClaim.providerType,
            }
          : {}),
      };
      await requireSame(binding, paths);
      await deps.state.mutate(deps.projectId, (ledger: ReceiptLedger) => {
        const publications = (ledger.builderPublications ??= {});
        const pending = publications[key];
        if (pending && pending.head !== commit)
          throw new BuilderGitRefusal("The retried changes produce a different commit.");
        publications[key] ??= receipt;
      });
      await requireSame(binding, paths);
      await git(isolated, [
        "push",
        "--no-verify",
        `--force-with-lease=${ref}:${input.expectedHead}`,
        "--",
        remote,
        `${commit}:${ref}`,
      ]);
      if (binding.machineClaim) await requireSame(binding, paths);
      return await finish(key, receipt);
    } finally {
      await rm(isolated, { recursive: true });
    }
  }

  async function findPull(binding: BuilderBinding) {
    const query = new URLSearchParams({ state: "open", head: `${owner}:${binding.branch}` });
    const result = await deps.github.rest("GET", `${prefix}/pulls?${query}`);
    if (result.status !== 200)
      throw new BuilderGitRefusal("Factory could not check the issue branch's open pull request.");
    const matches = z.array(pull).parse(result.body);
    if (matches.length > 1)
      throw new BuilderGitRefusal("More than one pull request matches this issue branch.");
    return matches[0];
  }

  async function findRemotePublication(binding: BuilderBinding, expected: string) {
    const ledger: ReceiptLedger = await deps.state.read(deps.projectId);
    const publication = Object.entries(ledger.builderPublications ?? {}).find(
      ([, entry]) =>
        entry.issue === binding.issue &&
        entry.branch === binding.branch &&
        entry.workspaceId === binding.authority.workspaceId &&
        entry.planId === binding.authority.planId &&
        entry.head === expected &&
        matchesMachinePublication(binding, entry),
    );
    if (!publication) return null;
    const [key, receipt] = publication;
    await requireSame(binding, receipt.paths);
    return receipt.pushedAt === null ? finish(key, receipt) : receipt;
  }

  async function openPull(caller: string, input: OpenPullInput) {
    const binding = await bind(caller, input.issue);
    if ((await branchHead(binding.branch)) !== input.expectedHead) {
      throw new BuilderGitRefusal(
        "Publish the current approved Builder commit before opening its pull request.",
      );
    }
    const receipt = await findRemotePublication(binding, input.expectedHead);
    if (!receipt)
      throw new BuilderGitRefusal(
        "The exact head has no Factory publication receipt for this plan.",
      );
    const existing = await findPull(binding);
    if (existing) {
      const result = verifiedPull(existing, binding, deps.repository, input.expectedHead);
      await requireSame(binding, receipt.paths);
      return result;
    }
    const body = [
      "(AI Generated)",
      "",
      `Factory installation: ${deps.installation}`,
      `<!-- factory-claim v1 installation=${deps.installation} branch=${binding.branch} -->`,
      `Closes #${input.issue}`,
      "",
      input.body,
    ]
      .join("\n")
      .trimEnd();
    await requireSame(binding, receipt.paths);
    if ((await branchHead(binding.branch)) !== input.expectedHead) {
      throw new BuilderGitRefusal("The issue branch moved before opening its pull request.");
    }
    if (binding.machineClaim) await requireSame(binding, receipt.paths);
    const result = await deps.github.rest("POST", `${prefix}/pulls`, {
      title: input.title,
      body,
      head: binding.branch,
      base: binding.authority.baseBranch,
    });
    const opened = result.status === 201 ? pull.parse(result.body) : await findPull(binding);
    if (!opened)
      throw new BuilderGitRefusal(
        "GitHub did not open an identifiable pull request for this Builder.",
      );
    return verifiedPull(opened, binding, deps.repository, input.expectedHead);
  }

  return {
    publish(callerAgentId: string, raw: unknown) {
      const input = builderPublishInput.parse(raw);
      return serialize(() => publish(callerAgentId, input));
    },
    openPullRequest(callerAgentId: string, raw: unknown) {
      const input = builderOpenPullInput.parse(raw);
      return serialize(() => openPull(callerAgentId, input));
    },
    async publishedHead(callerAgentId: string, issue: number) {
      return serialize(async () => {
        const binding = await bind(callerAgentId, issueNumber.parse(issue));
        const current = await branchHead(binding.branch);
        return findRemotePublication(binding, current);
      });
    },
  };
}

function matchesMachinePublication(
  binding: BuilderBinding,
  receipt: BuilderPublishReceipt,
): boolean {
  const pinned = binding.machineClaim;
  return pinned === undefined
    ? receipt.claimGeneration === undefined
    : receipt.builderAgentId === binding.agentId &&
        receipt.claimGeneration === pinned.generation &&
        receipt.builderProviderType === pinned.providerType;
}

function assertApproved(paths: string[], authority: BuilderGitAuthority): void {
  const approved = new Set(authority.approvedPaths);
  const forbidden = new Set([
    ...OWNER_ONLY_FILES,
    ".github/vorteo-factory.json",
    ...authority.protectedPaths,
  ]);
  for (const path of paths) {
    if (!approved.has(path) || forbidden.has(path)) {
      throw new BuilderGitRefusal("The upload contains a path outside the approved Builder plan.");
    }
  }
}

function unpack(changes: Change[]): Bytes[] {
  const seen = new Set<string>();
  let total = 0;
  const bytes = changes.map((entry): Bytes => {
    const path = entry.path;
    if (!isBuilderPath(path)) {
      throw new BuilderGitRefusal("The upload contains an invalid repository path.");
    }
    const identity = path.normalize("NFC").toLowerCase();
    if (seen.has(identity)) throw new BuilderGitRefusal("Upload each repository path only once.");
    seen.add(identity);
    if (entry.kind === "delete") return { path, data: null, mode: "100644" };
    const data = Buffer.from(entry.base64, "base64");
    if (data.toString("base64") !== entry.base64)
      throw new BuilderGitRefusal("Upload canonical base64 bytes.");
    total += data.length;
    if (total > BUILDER_UPLOAD_LIMIT_BYTES)
      throw new BuilderGitRefusal("The total Builder upload exceeds four MiB.");
    return { path, data, mode: entry.executable ? "100755" : "100644" };
  });
  return bytes.sort((left, right) =>
    left.path < right.path ? -1 : Number(left.path > right.path),
  );
}

export function isBuilderPath(path: string): boolean {
  if (path.includes("\\")) return false;
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return path
    .split("/")
    .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function publicationKey(binding: BuilderBinding, input: PublishInput, changes: Bytes[]): string {
  const digest = createHash("sha256");
  digest.update(
    JSON.stringify([
      binding.issue,
      binding.authority.workspaceId,
      binding.authority.planId,
      input.expectedHead,
      input.message,
    ]),
  );
  if (binding.machineClaim) {
    digest.update(
      JSON.stringify([
        binding.agentId,
        binding.machineClaim.generation,
        binding.machineClaim.providerType,
      ]),
    );
  }
  for (const entry of changes) {
    const sha = entry.data && createHash("sha256").update(entry.data).digest("hex");
    digest.update(JSON.stringify([entry.path, entry.mode, sha]));
  }
  return digest.digest("hex");
}

async function createCommit(
  cwd: string,
  options: { ref: string; remote: string; input: PublishInput; changes: Bytes[]; at: string },
) {
  const { ref, remote, input, changes, at } = options;
  await git(cwd, ["init", "--bare", "--template="]);
  await git(cwd, [
    "fetch",
    "--depth=1",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-auto-maintenance",
    "--",
    remote,
    ref,
  ]);
  const fetched = await git(cwd, ["rev-parse", "FETCH_HEAD^{commit}"]);
  if (fetched !== input.expectedHead)
    throw new BuilderGitRefusal("The assigned claim branch moved before publication.");
  await git(cwd, ["read-tree", fetched]);
  const records = [];
  for (const entry of changes) {
    const record =
      entry.data === null
        ? `0 ${"0".repeat(40)}\t${entry.path}\0`
        : `${entry.mode} ${await git(cwd, ["hash-object", "--stdin", "--no-filters", "-w"], entry.data)}\t${entry.path}\0`;
    records.push(record);
  }
  await git(cwd, ["update-index", "-z", "--index-info"], Buffer.from(records.join("")));
  const tree = await git(cwd, ["write-tree"]);
  const baseTree = await git(cwd, ["rev-parse", `${fetched}^{tree}`]);
  if (tree === baseTree)
    throw new BuilderGitRefusal("The approved upload would make no change to the branch.");
  const commit = head.parse(
    await git(cwd, ["commit-tree", tree, "-p", fetched], Buffer.from(input.message), at),
  );
  const diff = await git(cwd, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    fetched,
    commit,
  ]);
  const supplied = new Set(changes.map(({ path }) => path));
  if (diff.split("\0").some((path) => path && !supplied.has(path))) {
    throw new BuilderGitRefusal(
      "The isolated commit would change paths outside the submitted file list.",
    );
  }
  return commit;
}

function verifiedPull(
  entry: z.infer<typeof pull>,
  binding: BuilderBinding,
  repository: string,
  expected: string,
) {
  if (
    entry.head.sha !== expected ||
    entry.head.ref !== binding.branch ||
    entry.base.ref !== binding.authority.baseBranch ||
    entry.head.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
    entry.base.repo.full_name.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new BuilderGitRefusal(
      "The pull request does not match the exact local issue branch and expected head.",
    );
  }
  return {
    number: entry.number,
    head: entry.head.sha,
    url: `https://github.com/${repository}/pull/${entry.number}`,
  };
}

function git(cwd: string, args: string[], input?: Buffer, at?: string): Promise<string> {
  const passthrough = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  const env = Object.fromEntries(passthrough.map((name) => [name, process.env[name]]));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_AUTHOR_NAME: "Vorteo Factory",
    GIT_AUTHOR_EMAIL: "factory@localhost",
    GIT_COMMITTER_NAME: "Vorteo Factory",
    GIT_COMMITTER_EMAIL: "factory@localhost",
    ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}),
  });
  const flags = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "core.protectHFS=true",
    "-c",
    "core.protectNTFS=true",
    "-c",
    "http.followRedirects=false",
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...flags, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 64 * 1024) child.kill();
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(new BuilderGitRefusal("The daemon could not start its isolated Git command."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else if (args[0] === "push")
        reject(
          new BuilderGitRefusal(
            "The assigned branch refused the compare-and-swap push. Verify its current head.",
          ),
        );
      else
        reject(
          new BuilderGitRefusal(
            "The daemon could not prepare the approved changes in its isolated Git repository.",
          ),
        );
    });
    child.stdin.end(input);
  });
}
