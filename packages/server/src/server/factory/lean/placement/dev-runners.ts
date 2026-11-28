import { createHash } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { isDeepStrictEqual } from "node:util";
import type { AgentSnapshotPayload, CreationSnapshot } from "@getpaseo/protocol/messages";
import { projectFactoryClaimBranch } from "@getpaseo/server/factory-project";
import type { ToolHosts } from "../../../agent/host-operations/index.js";
import { devHostState, NO_DEV_HOST } from "../../project/issue-agent-host.js";
import type { RunnerDependencies } from "../runners.js";
import { readDevCheckout, type DevCheckoutClient } from "./dev-placement.js";
import {
  LEAN_PROTOCOL_MAJOR,
  type LeanLedger,
  type LeanStateStore,
  type RunnerOpenInput,
  type RunnerRef,
  type RunnerStatus,
} from "../types.js";

type Role = "lead" | "reviewer";
export type DevRunnerClient = Pick<
  DaemonClient,
  | "getLastServerInfoMessage"
  | "listProjects"
  | "createWorkspace"
  | "fetchWorkspaces"
  | "fetchAgent"
  | "createAgent"
  | "archiveAgent"
  | "sendMessage"
  | "waitForFinish"
> &
  DevCheckoutClient;
type Create = Omit<Parameters<DevRunnerClient["createAgent"]>[0], "onEvent">;
type CreationReceipt = Pick<
  CreationSnapshot,
  "kind" | "phase" | "idempotencyKey" | "agentId" | "workspaceId" | "revision"
>;

export interface DevRunnerPlacement {
  repository: string;
  generation: string;
  claimInstallation: string;
  remoteProjectId: string;
  workspaceId: string;
  cwd: string;
  branch: string;
  checkoutBranch: string;
  /** For a Builder: observed workspace HEAD. For a Reviewer: the exact authorized PR head. */
  headSha: string;
  /** Exact branch head from authenticated GitHub evidence. */
  pushedHeadSha: string;
  clean: boolean;
  issueTitle?: string;
  planRevision: string | null;
  approvedPaths: readonly string[];
}

export interface DevRunnerAssignment extends Omit<
  DevRunnerPlacement,
  "clean" | "pushedHeadSha" | "issueTitle"
> {
  projectId: string;
  issue: number;
  installation: string;
  installationId: string;
  role: Role;
  serverId: string;
  creationKey: string;
  agentId: string;
  provider: string;
  checkoutHeadSha: string;
  profileId: string | null;
}

type Entry =
  | { assignment: DevRunnerAssignment; request: Create; receipt?: never }
  | { assignment: DevRunnerAssignment; receipt: CreationReceipt; request?: never };
interface DevLedger extends LeanLedger {
  devRunnerAssignments?: Record<string, Entry>;
  devRunnerMessages?: Record<string, string>;
}

export async function readDevRunnerAssignment(
  state: LeanStateStore,
  projectId: string,
  agentId: string,
): Promise<DevRunnerAssignment | null> {
  const ledger: DevLedger = await state.read(projectId);
  const entry = ledger.devRunnerAssignments?.[agentId];
  return entry?.receipt &&
    matchesReceipt(entry.receipt, entry.assignment) &&
    entry.assignment.projectId === projectId &&
    entry.assignment.agentId === agentId
    ? entry.assignment
    : null;
}

export interface BoundDevInstallation {
  installationId: string;
  hostServerId: string;
  devServerId: string;
}

export interface DevRunnerOptions {
  hosts: Pick<ToolHosts, "directory"> & {
    use<T>(
      serverId: string,
      action: (client: DevRunnerClient) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T>;
  };
  projectId: string;
  installation: string;
  devServerId: string;
  repository: string;
  state: LeanStateStore;
  now(): Date;
  readBoundInstallation(): Promise<BoundDevInstallation | null>;
  /** Verify trusted issue generation and plan, then the destination's saved branch/workspace. */
  verifyPlacement(input: {
    client: DevRunnerClient;
    serverId: string;
    issue: number;
    role: Role;
    launch?: RunnerOpenInput;
    saved?: DevRunnerAssignment;
  }): Promise<DevRunnerPlacement | null>;
  /** Fresh proof authorized by the configured primary for this exact foreign review assignment. */
  authorizeForeignReview?(assignment: DevRunnerAssignment): Promise<boolean>;
  statusIntervalMs?: number;
}

type RemoteMethods = Pick<
  Required<RunnerDependencies>,
  | "place"
  | "createAgent"
  | "discoverAgent"
  | "subscribe"
  | "prompt"
  | "lastReply"
  | "archiveAgent"
  | "readUsage"
  | "checkLeadBranch"
  | "verifyQuotaRecovery"
>;
interface RemoteTarget {
  agentId: string;
  serverId: string | null;
}
const devOid = /^[a-f0-9]{40}$/u;

function sameWorkspace(found: DevRunnerPlacement, saved: DevRunnerAssignment): boolean {
  return (
    found.workspaceId === saved.workspaceId &&
    found.remoteProjectId === saved.remoteProjectId &&
    found.cwd === saved.cwd &&
    found.checkoutBranch === saved.checkoutBranch &&
    found.generation === saved.generation &&
    found.claimInstallation === saved.claimInstallation
  );
}

function matchesReceipt(receipt: CreationReceipt, assignment: DevRunnerAssignment): boolean {
  return (
    receipt.kind === "agent" &&
    receipt.phase === "completed" &&
    receipt.idempotencyKey === assignment.creationKey &&
    receipt.agentId === assignment.agentId &&
    receipt.workspaceId === assignment.workspaceId
  );
}

export class DevRunnerUnavailable extends Error {}

function issueRole(role: string): role is Role {
  return role === "lead" || role === "reviewer";
}

function statusOf(agent: AgentSnapshotPayload): RunnerStatus {
  if (agent.usageLimitHold && !agent.usageLimitHold.releasedAt) {
    return {
      kind: "quota",
      accountDefinition: null,
      resetsAt: agent.usageLimitHold.resetsAt ?? null,
    };
  }
  if (agent.pendingPermissions.length) {
    return { kind: "permission", detail: "The Dev runner needs a permission decision." };
  }
  switch (agent.status) {
    case "idle":
      return { kind: "idle" };
    case "error":
      return { kind: "error", detail: agent.lastError ?? "The Dev runner reported an error." };
    case "closed":
      return { kind: "detached" };
    default:
      return { kind: "running" };
  }
}

export function createDevRunnerAdapter(options: DevRunnerOptions): RemoteMethods & {
  readonly devServerId: string;
  verifyAssignment(agentId: string): Promise<DevRunnerAssignment | null>;
  enqueue(
    runner: RunnerRef,
    message: string,
    clientMessageId: string,
    expectedPlanRevision: string,
  ): Promise<"sent" | "busy" | "gone">;
} {
  const { hosts, projectId, installation, devServerId, repository, state, now } = options;
  const read = (): Promise<DevLedger> => state.read(projectId);
  const interval = options.statusIntervalMs ?? 5000;

  async function boundInstallation(expectedId?: string): Promise<BoundDevInstallation> {
    const bound = await options.readBoundInstallation();
    if (
      !bound ||
      !bound.installationId ||
      bound.devServerId !== devServerId ||
      installation !== `${bound.hostServerId}/${projectId}` ||
      (expectedId !== undefined && bound.installationId !== expectedId)
    )
      throw new DevRunnerUnavailable("The saved Dev installation binding changed.");
    return bound;
  }

  async function destination() {
    await boundInstallation();
    const directory = await hosts.directory();
    if (installation !== `${directory.self.serverId}/${projectId}`)
      throw new DevRunnerUnavailable("The local daemon does not own this Factory installation.");
    return devHostState(directory) ?? NO_DEV_HOST;
  }

  async function withDevClient<T>(
    serverId: string | null,
    action: (client: DevRunnerClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const observed = await destination();
    if (serverId !== devServerId || observed.serverId !== devServerId || observed.unavailable) {
      throw new DevRunnerUnavailable(observed.unavailable ?? "The saved Dev destination changed.");
    }
    return hosts.use(
      serverId,
      async (client) => {
        const info = client.getLastServerInfoMessage();
        if (info?.serverId !== serverId || info.features?.creationLifecycle !== true) {
          throw new DevRunnerUnavailable(
            "The linked Dev daemon did not prove its identity and durable creation support.",
          );
        }
        return action(client);
      },
      signal,
    );
  }

  async function held(issue: number): Promise<boolean> {
    const lease = (await read()).leases[issue];
    return (
      !!lease &&
      lease.issue === issue &&
      lease.protocol === LEAN_PROTOCOL_MAJOR &&
      lease.installation === installation &&
      lease.branch === projectFactoryClaimBranch(issue) &&
      !lease.released &&
      Date.parse(lease.expiresAt) > +now()
    );
  }

  function checkPlacement(
    value: DevRunnerPlacement | null,
    issue: number,
    role: Role,
  ): DevRunnerPlacement {
    if (
      !value ||
      value.repository !== repository ||
      !value.generation ||
      !value.claimInstallation ||
      !value.remoteProjectId ||
      !value.workspaceId ||
      !value.cwd.startsWith("/") ||
      value.branch !== projectFactoryClaimBranch(issue) ||
      !value.checkoutBranch ||
      (role === "lead"
        ? value.checkoutBranch !== value.branch
        : value.checkoutBranch === value.branch) ||
      !devOid.test(value.headSha) ||
      !devOid.test(value.pushedHeadSha) ||
      (role === "reviewer" &&
        (!value.clean || value.headSha !== value.pushedHeadSha || !value.planRevision)) ||
      (value.planRevision === null && value.approvedPaths.length > 0)
    ) {
      throw new DevRunnerUnavailable("The Dev issue placement could not be verified.");
    }
    return value;
  }

  async function confirmCheckout(
    client: DevRunnerClient,
    placement: DevRunnerPlacement,
    role: Role,
  ) {
    const checkout = await readDevCheckout(client, placement, role);
    if (!checkout || checkout.headSha !== placement.headSha || checkout.clean !== placement.clean)
      throw new DevRunnerUnavailable(
        "The linked Dev worktree changed during placement verification.",
      );
  }

  function verifyAgent(agent: AgentSnapshotPayload, assignment: DevRunnerAssignment): void {
    if (
      agent.id !== assignment.agentId ||
      agent.provider !== assignment.provider ||
      (agent.profile?.id ?? null) !== assignment.profileId ||
      agent.workspaceId !== assignment.workspaceId ||
      agent.cwd !== assignment.cwd ||
      getParentAgentIdFromLabels(agent.labels)
    ) {
      throw new DevRunnerUnavailable("The remote agent does not match its durable Dev assignment.");
    }
  }

  async function entryFor(target: RemoteTarget): Promise<Entry> {
    const entry = (await read()).devRunnerAssignments?.[target.agentId];
    const assignment = entry?.assignment;
    if (
      !entry ||
      assignment?.agentId !== target.agentId ||
      assignment.serverId !== target.serverId ||
      assignment.projectId !== projectId ||
      assignment.repository !== repository ||
      assignment.installation !== installation ||
      !assignment.installationId ||
      assignment.serverId !== devServerId ||
      assignment.creationKey !== `lean-dev:${assignment.agentId}`
    ) {
      throw new DevRunnerUnavailable("Factory has no matching durable Dev assignment.");
    }
    await boundInstallation(assignment.installationId);
    return entry;
  }

  async function currentPlacement(client: DevRunnerClient, saved: DevRunnerAssignment) {
    const found = checkPlacement(
      await options.verifyPlacement({
        client,
        serverId: saved.serverId,
        issue: saved.issue,
        role: saved.role,
        saved,
      }),
      saved.issue,
      saved.role,
    );
    if (
      !sameWorkspace(found, saved) ||
      (saved.role === "reviewer" &&
        (found.headSha !== saved.headSha ||
          found.planRevision !== saved.planRevision ||
          !isDeepStrictEqual(found.approvedPaths, saved.approvedPaths)))
    ) {
      throw new DevRunnerUnavailable(
        "The saved Dev assignment no longer matches its issue placement.",
      );
    }
    await confirmCheckout(client, found, saved.role);
    return found;
  }

  async function authorize(assignment: DevRunnerAssignment): Promise<boolean> {
    await boundInstallation(assignment.installationId);
    if (assignment.claimInstallation === installation) return held(assignment.issue);
    return (
      assignment.role === "reviewer" &&
      (await options.authorizeForeignReview?.(assignment)) === true
    );
  }

  async function persist(entry: Entry): Promise<void> {
    await state.mutate(projectId, (ledger: DevLedger) => {
      const entries = (ledger.devRunnerAssignments ??= {});
      const prior = entries[entry.assignment.agentId];
      if (prior && !isDeepStrictEqual(prior.assignment, entry.assignment))
        throw new DevRunnerUnavailable("The Dev launch reservation changed.");
      if (prior?.receipt) return;
      if (prior?.request && entry.request && !isDeepStrictEqual(prior.request, entry.request))
        throw new DevRunnerUnavailable("The saved Dev launch request changed.");
      entries[entry.assignment.agentId] = entry;
    });
  }

  async function lookup(client: DevRunnerClient, assignment: DevRunnerAssignment) {
    const agent = (await client.fetchAgent(assignment.agentId))?.agent ?? null;
    if (agent) verifyAgent(agent, assignment);
    return agent?.archivedAt ? null : agent;
  }

  async function sendCreate(client: DevRunnerClient, entry: Entry) {
    const { request, assignment } = entry;
    if (
      !request ||
      request.idempotencyKey !== assignment.creationKey ||
      request.agentId !== assignment.agentId ||
      request.workspaceId !== assignment.workspaceId
    )
      throw new DevRunnerUnavailable("Factory lost the bound Dev creation request.");
    if (!(await authorize(assignment)))
      throw new DevRunnerUnavailable("The issue authority changed before the Dev launch.");
    const existing = await lookup(client, assignment);
    const placement = await currentPlacement(client, assignment);
    if (!existing && placement.headSha !== assignment.checkoutHeadSha)
      throw new DevRunnerUnavailable("The Dev checkout moved before creation.");
    if (!(await authorize(assignment)))
      throw new DevRunnerUnavailable("The issue authority changed before the Dev launch.");
    const receipts: CreationReceipt[] = [];
    const agent = await client.createAgent({
      ...request,
      onEvent({ kind, phase, idempotencyKey, agentId, workspaceId, revision }) {
        if (phase === "completed")
          receipts.push({ kind, phase, idempotencyKey, agentId, workspaceId, revision });
      },
    });
    verifyAgent(agent, assignment);
    const receipt = receipts.at(-1);
    if (agent.archivedAt || !receipt || !matchesReceipt(receipt, assignment))
      throw new DevRunnerUnavailable(
        "The Dev daemon did not return this runner's verified creation receipt.",
      );
    await persist({ assignment, receipt });
    if (!(await authorize(assignment)))
      throw new DevRunnerUnavailable("The issue authority changed during Dev launch.");
    await currentPlacement(client, assignment);
  }

  async function verifyAssignment(agentId: string): Promise<DevRunnerAssignment | null> {
    const saved = await readDevRunnerAssignment(state, projectId, agentId);
    if (!saved) return null;
    const { assignment } = await entryFor(saved);
    return withDevClient(saved.serverId, async (client) => {
      if (!(await lookup(client, saved)) || !(await authorize(assignment))) return null;
      const current = await currentPlacement(client, assignment);
      if (!(await authorize(assignment))) return null;
      return {
        ...assignment,
        planRevision: current.planRevision,
        approvedPaths: current.approvedPaths,
      };
    });
  }

  async function withAgent<T>(
    target: RemoteTarget,
    action: (
      client: DevRunnerClient,
      assignment: DevRunnerAssignment,
      agent: AgentSnapshotPayload | null,
    ) => Promise<T>,
    allowPending = false,
  ): Promise<T> {
    const { assignment, receipt } = await entryFor(target);
    if (!allowPending && (!receipt || !matchesReceipt(receipt, assignment)))
      throw new DevRunnerUnavailable("The Dev runner has no verified launch receipt.");
    return withDevClient(assignment.serverId, async (client) => {
      const agent = await lookup(client, assignment);
      return action(client, assignment, agent);
    });
  }

  async function createAgent(launch: Parameters<RemoteMethods["createAgent"]>[0]) {
    const { input, choice, identity, serverId } = launch;
    const { issue, role } = input;
    if (
      input.projectId !== projectId ||
      issue === null ||
      !issueRole(role) ||
      !identity ||
      !choice.account ||
      serverId !== devServerId
    ) {
      throw new DevRunnerUnavailable(
        "The Dev runner needs an authorized issue, account and durable launch reservation.",
      );
    }
    const { installationId } = await boundInstallation();
    const agentId = identity.agentId;
    const saved = role === "lead" ? await priorAssignment(issue, role) : undefined;
    if (saved && saved.serverId !== serverId)
      throw new DevRunnerUnavailable(
        "The saved Dev issue workspace is on a different destination.",
      );
    return withDevClient(serverId, async (client) => {
      const placement = checkPlacement(
        await options.verifyPlacement({
          client,
          serverId,
          issue,
          role,
          launch: input,
          saved,
        }),
        issue,
        role,
      );
      if (
        input.worktree &&
        (input.worktree.serverId !== serverId || input.worktree.path !== placement.cwd)
      )
        throw new DevRunnerUnavailable(
          "The Dev workspace does not match the saved runner worktree.",
        );
      if (saved && !sameWorkspace(placement, saved)) {
        throw new DevRunnerUnavailable(
          "Factory cannot replace a Dev runner outside its preserved issue workspace.",
        );
      }
      await confirmCheckout(client, placement, role);
      const {
        workspaceId,
        cwd,
        generation,
        claimInstallation,
        remoteProjectId,
        branch,
        checkoutBranch,
        headSha: workspaceHead,
        pushedHeadSha,
        planRevision,
        approvedPaths,
      } = placement;
      const headSha = role === "lead" ? pushedHeadSha : workspaceHead;
      if (!saved && workspaceHead !== pushedHeadSha)
        throw new DevRunnerUnavailable(
          "A new Dev issue worktree must start at its authenticated head.",
        );
      const provider = choice.account!;
      const creationKey = `lean-dev:${agentId}`;
      const assignment: DevRunnerAssignment = {
        projectId,
        repository,
        installation,
        installationId,
        issue,
        role,
        serverId,
        workspaceId,
        cwd,
        generation,
        claimInstallation,
        remoteProjectId,
        branch,
        checkoutBranch,
        headSha,
        checkoutHeadSha: workspaceHead,
        creationKey,
        agentId,
        provider,
        profileId: choice.profileId ?? null,
        planRevision,
        approvedPaths,
      };
      const review =
        role === "reviewer"
          ? ({
              headSha,
              clean: true,
              daemonCreated: true,
              nonChild: true,
              freshSession: true,
            } as const)
          : undefined;
      const request: Create = {
        agentId,
        workspaceId,
        idempotencyKey: creationKey,
        labels: launch.labels,
        config: {
          cwd,
          provider,
          systemPrompt: launch.systemPrompt,
          title:
            `#${issue} ${review ? "Reviewer" : "Builder"}${placement.issueTitle ? `: ${placement.issueTitle}` : ""}`.slice(
              0,
              60,
            ),
          ...(choice.profileId ? { profileId: choice.profileId } : {}),
        },
        initialPrompt: [
          `Issue #${issue}. Claim branch: ${branch}.`,
          review
            ? `Review exactly ${headSha}.`
            : "Use this Dev workspace's Git and GitHub credentials to commit, push the issue branch, and open its pull request.",
          launch.initialPrompt,
        ].join("\n\n"),
        origin: "agent",
      };
      if (!(await authorize(assignment)))
        throw new DevRunnerUnavailable("The Dev runner has no current issue authority.");
      await identity.seal(workspaceId, review);
      const entry: Entry = { assignment, request };
      await persist(entry);
      if (!(await sendInitialCreate(client, entry))) return { quota: { resetsAt: null } };
      return { agentId, ...(review ? { review } : {}) };
    });
  }

  async function sendInitialCreate(client: DevRunnerClient, entry: Entry): Promise<boolean> {
    const { assignment } = entry;
    const { agentId } = assignment;
    try {
      await sendCreate(client, entry);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "quota_exhausted" &&
        !(await lookup(client, assignment))
      ) {
        await state.mutate(projectId, (ledger: DevLedger) => {
          if (isDeepStrictEqual(ledger.devRunnerAssignments?.[agentId], entry))
            delete ledger.devRunnerAssignments?.[agentId];
        });
        return false;
      }
      throw error;
    }
    return true;
  }

  async function priorAssignment(issue: number, role: Role) {
    const ledger = await read();
    const runner = Object.values(ledger.runners)
      .filter(
        (record) => record.issue === issue && record.role === role && record.serverId !== null,
      )
      .sort((left, right) => right.attempt - left.attempt)[0];
    const previous = runner ? ledger.devRunnerAssignments?.[runner.agentId] : undefined;
    if (runner) {
      const saved = await entryFor(runner);
      if (!saved.receipt || !matchesReceipt(saved.receipt, saved.assignment))
        throw new DevRunnerUnavailable("The previous Dev runner has no verified creation receipt.");
    }
    return previous?.assignment;
  }

  return {
    devServerId,
    verifyAssignment,
    async enqueue(target, message, clientMessageId, expectedPlanRevision) {
      if (!clientMessageId.trim())
        throw new DevRunnerUnavailable("Dev enqueue requires a durable message ID.");
      return withAgent(target, async (client, assignment, agent) => {
        if (!agent) return "gone";
        if (
          target.role !== assignment.role ||
          target.account !== assignment.provider ||
          !(await authorize(assignment))
        )
          return "busy";
        const messageId = `lean-dev:${createHash("sha256")
          .update(
            JSON.stringify([
              assignment.installationId,
              assignment.creationKey,
              assignment.generation,
              clientMessageId,
            ]),
          )
          .digest("hex")}`;
        const digest = createHash("sha256")
          .update(JSON.stringify([message, expectedPlanRevision]))
          .digest("hex");
        const prior = (await read()).devRunnerMessages?.[messageId];
        if (prior && prior !== digest)
          throw new DevRunnerUnavailable("The saved Dev message changed.");
        if (!prior && (statusOf(agent).kind !== "idle" || agent.activeTurn)) return "busy";
        if (!(await authorize(assignment))) return "busy";
        const placement = await currentPlacement(client, assignment);
        if (!expectedPlanRevision || placement.planRevision !== expectedPlanRevision) return "busy";
        if (!prior) {
          await client.sendMessage(assignment.agentId, message, {
            messageId,
            origin: "agent",
            activeTurnBehavior: "steer",
          });
          await state.mutate(projectId, (ledger: DevLedger) => {
            (ledger.devRunnerMessages ??= {})[messageId] = digest;
          });
        }
        return "sent";
      });
    },
    async place(input) {
      const dev = await destination();
      if (
        input.projectId !== projectId ||
        input.issue === null ||
        !issueRole(input.role) ||
        dev.serverId !== devServerId ||
        dev.unavailable ||
        (input.worktree && input.worktree.serverId !== dev.serverId)
      ) {
        return {
          parked: {
            kind: "dev-unavailable",
            reason: dev.unavailable ?? "The saved workspace belongs to another destination.",
          },
        };
      }
      return { serverId: dev.serverId };
    },
    createAgent,
    async discoverAgent(intent) {
      const entry = (await read()).devRunnerAssignments?.[intent.runner.agentId];
      if (!entry) return "missing"; // This adapter sends only after the sidecar is durable.
      const { assignment } = await entryFor(intent.runner);
      if (
        intent.issue !== assignment.issue ||
        intent.workspaceId !== assignment.workspaceId ||
        intent.runner.role !== assignment.role ||
        intent.runner.account !== assignment.provider ||
        (assignment.role === "reviewer" && intent.review?.headSha !== assignment.headSha)
      )
        return "unverified";
      return withDevClient(assignment.serverId, async (client) => {
        const agent = await lookup(client, assignment);
        if (!(await authorize(assignment))) {
          if (agent) return "close";
          return entry.request ? "unverified" : "missing";
        }
        await currentPlacement(client, assignment);
        if (entry.request) {
          // Re-submit the exact request/key to the destination's durable creation API.
          await sendCreate(client, entry);
          return "adopt";
        }
        return agent && entry.receipt && matchesReceipt(entry.receipt, assignment)
          ? "adopt"
          : "missing";
      });
    },
    async subscribe(target, listener) {
      const { assignment, receipt } = await entryFor(target);
      if (!receipt || !matchesReceipt(receipt, assignment))
        throw new DevRunnerUnavailable("The Dev runner has no verified launch receipt.");
      const controller = new AbortController();
      let revalidate = true;
      let last: string | undefined;
      const emit = (status: RunnerStatus) => {
        const current = JSON.stringify(status);
        if (last === current || controller.signal.aborted) return;
        last = current;
        listener(status);
      };
      const readStatus = () =>
        withDevClient(
          assignment.serverId,
          async (client) => {
            const agent = await lookup(client, assignment);
            await boundInstallation(assignment.installationId);
            if (agent && revalidate) {
              if (!(await authorize(assignment)))
                throw new DevRunnerUnavailable("The Dev runner lost issue authority.");
              await currentPlacement(client, assignment);
              revalidate = false;
            }
            return agent;
          },
          controller.signal,
        );
      const offline = () => {
        revalidate = true;
        emit({
          kind: "error",
          detail: "The linked Dev runner could not be verified. Factory will retry.",
        });
      };
      try {
        const initial = await readStatus();
        if (!initial) return null;
        emit(statusOf(initial));
      } catch {
        offline();
      }
      let reading = false;
      const stop = () => {
        clearInterval(timer);
        controller.abort();
      };
      const timer = setInterval(() => {
        if (reading) return;
        reading = true;
        void readStatus()
          .then((agent) => emit(agent ? statusOf(agent) : { kind: "detached" }), offline)
          .finally(() => {
            reading = false;
          });
      }, interval);
      timer.unref();
      return stop;
    },
    async prompt(target, message) {
      return withAgent(target, async (client, assignment, agent) => {
        if (!agent) return "gone";
        if (statusOf(agent).kind !== "idle" || agent.activeTurn || !(await authorize(assignment)))
          return "busy";
        await currentPlacement(client, assignment);
        if (!(await authorize(assignment))) return "busy";
        await client.sendMessage(assignment.agentId, message);
        return "sent";
      });
    },
    async lastReply(target) {
      return withAgent(target, async (client, assignment, agent) => {
        if (
          !agent ||
          statusOf(agent).kind !== "idle" ||
          agent.activeTurn ||
          !(await authorize(assignment))
        )
          return null;
        await currentPlacement(client, assignment);
        const finished = await client.waitForFinish(assignment.agentId, 100);
        if (
          finished.status === "timeout" ||
          !finished.final ||
          statusOf(finished.final).kind !== "idle" ||
          finished.final.archivedAt ||
          finished.final.activeTurn
        )
          return null;
        verifyAgent(finished.final, assignment);
        if (!(await authorize(assignment))) return null;
        await currentPlacement(client, assignment);
        const reply = finished.lastMessage;
        const separator = "\n\n---\n\n";
        return target.providerType === "codex" && reply?.startsWith(separator)
          ? reply.slice(separator.length)
          : reply;
      });
    },
    async archiveAgent(target) {
      await withAgent(
        target,
        async (client, assignment, agent) => {
          if (agent) {
            await boundInstallation(assignment.installationId);
            await client.archiveAgent(assignment.agentId);
          }
        },
        true,
      );
    },
    readUsage: (target) =>
      withAgent(target, async (_client, _assignment, agent) => agent?.lastUsage ?? null),
    async checkLeadBranch(target, issue) {
      return withAgent(target, async (client, assignment) => {
        if (assignment.issue !== issue || assignment.role !== "lead")
          return "The saved Dev Builder does not match this issue.";
        const placement = await currentPlacement(client, assignment);
        return placement.clean && placement.headSha === placement.pushedHeadSha
          ? null
          : "The Dev Builder's workspace head has not been pushed to its claim branch.";
      });
    },
    async verifyQuotaRecovery(target, issue) {
      return withAgent(target, async (client, assignment, agent) => {
        if (assignment.issue !== issue || !agent || statusOf(agent).kind !== "quota")
          return "The Dev runner no longer has a verified quota stop.";
        await currentPlacement(client, assignment);
        return null;
      });
    },
  };
}
