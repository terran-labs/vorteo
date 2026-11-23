import type { Logger } from "pino";
import { PARENT_AGENT_ID_LABEL, PARENT_SERVER_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ForwardedGovernance, PresetFencePolicy } from "@getpaseo/protocol/messages";
import { effectivePresetFencePolicy, type PresetFencePath } from "./fence-policy.js";

export type { PresetFencePath } from "./fence-policy.js";
import { WorkerLaunchRefusal } from "../agent-manager.js";
import { logRefusal } from "../create-agent/create.js";
import { LEAD_LAUNCH_ID_LABEL, LEAD_LAUNCH_REQUESTED_BY_LABEL } from "./model.js";

/**
 * The preset fence (#360). A coordinator launched with a worker preset may start or reshape
 * threads only on that preset, or exactly as the owner confirmed through request_lead_launch.
 * The same holds for every thread beneath it: a worker preset never has a worker of its own, so
 * without this a coordinator could ask its worker to launch any preset. MCP `create_agent` from
 * the coordinator itself already refuses; every other agent-initiated path checks here.
 *
 * The daemon setting `presetFence` decides whether a decision is only logged ("report", the
 * default) or refused ("enforce", except paths listed in `report`). Some reasons are always
 * report-only in this slice; see ENFORCEABLE_REASONS.
 */
export const PRESET_FENCE_MESSAGE = "Preset fence would refuse";
export const PRESET_FENCE_REFUSED_MESSAGE = "Preset fence refused";
const PRESET_FENCE_CODE = "preset_fence";

/** The fields the fence reads, available from a loaded thread and from its stored record. */
export interface FenceAgent {
  id: string;
  labels: Record<string, string>;
  config?: { profileLaunch?: { worker?: { id: string } | null } | null } | null;
  /** Stored records only: the governance a Host forwarded with this thread's creation (C2). */
  forwardedGovernance?: ForwardedGovernance | null;
}

/**
 * Loaded threads first, then stored records: closing, idle release, archive and restart remove a
 * coordinator from memory but keep its record, and it still governs its workers.
 */
export interface FenceLookup {
  getAgent: (agentId: string) => FenceAgent | null | undefined;
  getStored?: (agentId: string) => Promise<FenceAgent | null | undefined>;
  /** This daemon's server ID, to tell a parent on another host from a missing one. */
  serverId?: string;
  /** Tests only. The daemon uses the policy fixed at startup (fence-policy.ts). */
  policy?: () => PresetFencePolicy | undefined;
}

/** The Factory service's role label. Only daemon code sets it; agent tools refuse it. */
export const FACTORY_ROLE_LABEL = "vorteo.factory-role";

/** Labels that record who governs a thread. A governed agent changing one is flagged. */
const GOVERNANCE_LABELS = [
  PARENT_AGENT_ID_LABEL,
  LEAD_LAUNCH_REQUESTED_BY_LABEL,
  LEAD_LAUNCH_ID_LABEL,
] as const;

/**
 * Labels only daemon code may set. Agent tool calls that set, change or clear one are refused at
 * once, not just logged. The parent label is not here: workspace splits still clear it (D6).
 * Factory's issue labels (`factory.role`, `factory.issue`) are not here either: the Foreman's
 * charter sets them through create_agent.
 */
export const RESERVED_AGENT_LABELS = [
  LEAD_LAUNCH_REQUESTED_BY_LABEL,
  LEAD_LAUNCH_ID_LABEL,
  FACTORY_ROLE_LABEL,
] as const;

/** Refuses an agent's attempt to set a reserved label on any thread. */
export function assertNoReservedLabels(labels: Record<string, unknown> | null | undefined): void {
  const reserved = RESERVED_AGENT_LABELS.find((label) => labels && label in labels);
  if (reserved)
    throw new WorkerLaunchRefusal(
      `The label ${reserved} is set only by the daemon. Leave it out.`,
      "reserved-label",
    );
}

export type PresetFenceRequest =
  | {
      /** A new thread or scheduled run. `profileId` is the preset it would launch. */
      kind: "launch";
      profileId?: string | null;
      detached?: boolean;
    }
  | {
      /** A change to an existing thread's settings, account or governing labels. */
      kind: "change";
      targetAgentId: string;
      /** Model, thinking, features or account. */
      settings?: boolean;
      /** Permission mode alone. Worker presets do not freeze the mode until #518, so report-only. */
      mode?: boolean;
      labels?: Record<string, string> | null;
    };

export type FenceUnknown = "parent-remote" | "parent-unresolved" | "cycle" | "depth-limit";

/**
 * Who governs a caller. `unknown` means a parent link could not be followed to its end. It is
 * never treated as "not governed".
 */
export type FenceGovernance =
  | { kind: "none" }
  | {
      kind: "supervisor";
      supervisor: FenceAgent;
      /** Set when the supervisor is on another daemon, known from forwarded governance (C2). */
      serverId?: string;
    }
  | { kind: "unknown"; why: FenceUnknown };

/** Parent links followed upward before the chain counts as unknown. */
const MAX_SUPERVISOR_DEPTH = 8;

/**
 * Refused when the setting enforces. The others stay report-only in this slice: mode changes
 * until #518, governance labels until the owner's split instruction changes (D6), and chains
 * this daemon cannot follow (D2). A Host parent with forwarded governance (C2) is followed, so its
 * launches get `preset-required` and `detached`, which are refused only once enforcing ships.
 */
const ENFORCEABLE_REASONS: ReadonlySet<string> = new Set([
  "preset-required",
  "detached",
  "settings-change",
  "cycle",
  "depth-limit",
]);

async function lookup(dependencies: FenceLookup, agentId: string): Promise<FenceAgent | null> {
  return dependencies.getAgent(agentId) ?? (await dependencies.getStored?.(agentId)) ?? null;
}

/**
 * The governance a Host recorded on this thread at creation. A loaded thread does not carry the
 * stored field, so it is read from the record. The record is written once by the daemon, so a
 * thread cannot shed it by editing its parent label.
 */
async function forwardedGovernance(
  agent: FenceAgent,
  dependencies: FenceLookup,
): Promise<ForwardedGovernance | null> {
  if (agent.forwardedGovernance) return agent.forwardedGovernance;
  return (await dependencies.getStored?.(agent.id))?.forwardedGovernance ?? null;
}

/**
 * The nearest thread, starting with the caller and following parent labels, whose launch carries
 * a worker preset. Confirmed leads have no parent label, so they answer to their own preset.
 * A thread created through a Host's remote create answers to the supervisor the Host recorded,
 * read before its parent label (C2).
 */
export async function governingSupervisor(
  caller: FenceAgent,
  dependencies: FenceLookup,
): Promise<FenceGovernance> {
  const visited = new Set<string>([caller.id]);
  let current = caller;
  for (let depth = 0; depth <= MAX_SUPERVISOR_DEPTH; depth += 1) {
    if (current.config?.profileLaunch?.worker) return { kind: "supervisor", supervisor: current };
    const forwarded = await forwardedGovernance(current, dependencies);
    if (forwarded)
      return {
        kind: "supervisor",
        supervisor: {
          id: forwarded.supervisorAgentId,
          labels: {},
          config: { profileLaunch: { worker: { id: forwarded.workerProfileId } } },
        },
        serverId: forwarded.serverId,
      };
    const parentId: string | undefined = current.labels[PARENT_AGENT_ID_LABEL];
    if (!parentId) return { kind: "none" };
    if (visited.has(parentId)) return { kind: "unknown", why: "cycle" };
    visited.add(parentId);
    const parent = await lookup(dependencies, parentId);
    if (!parent) {
      const parentServer = current.labels[PARENT_SERVER_ID_LABEL];
      const remote = Boolean(
        parentServer && dependencies.serverId && parentServer !== dependencies.serverId,
      );
      return { kind: "unknown", why: remote ? "parent-remote" : "parent-unresolved" };
    }
    current = parent;
  }
  return { kind: "unknown", why: "depth-limit" };
}

/**
 * What the Host forwards with a remote create (C2): the caller's governing supervisor, from this
 * daemon's own records. Nothing is sent for an ungoverned caller, an unknown chain or a failed
 * lookup; the destination then logs `parent-remote`, as before C2.
 */
export async function governanceToForward(
  callerAgentId: string | undefined,
  dependencies: FenceLookup,
): Promise<ForwardedGovernance | null> {
  try {
    const caller = callerAgentId ? await lookup(dependencies, callerAgentId) : null;
    if (!caller || !dependencies.serverId) return null;
    const governance = await governingSupervisor(caller, dependencies);
    const workerProfileId =
      governance.kind === "supervisor"
        ? governance.supervisor.config?.profileLaunch?.worker?.id
        : undefined;
    if (governance.kind !== "supervisor" || !workerProfileId) return null;
    return {
      supervisorAgentId: governance.supervisor.id,
      serverId: governance.serverId ?? dependencies.serverId,
      workerProfileId,
    };
  } catch {
    return null;
  }
}

function ownGovernance(caller: FenceAgent): FenceGovernance {
  return caller.config?.profileLaunch?.worker
    ? { kind: "supervisor", supervisor: caller }
    : { kind: "none" };
}

/**
 * Why the fence would refuse, or null. Pure, so the case table can cover every path.
 * - Launches by the supervisor or any thread beneath it must use the supervisor's worker preset
 *   and stay attached, which keeps a builder's reviewer subagent on that preset allowed.
 * - Any governed caller changing a governance label is flagged, on any thread including itself,
 *   since clearing a parent label would end the walk.
 * - Settings and mode changes are flagged on the caller's own workers and confirmed leads.
 * - An unknown chain reports why it is unknown, for whatever a known supervisor would be asked.
 */
export function presetFenceReason(
  caller: FenceAgent,
  target: FenceAgent | null,
  request: PresetFenceRequest,
  governance: FenceGovernance = ownGovernance(caller),
): string | null {
  if (governance.kind === "none") return null;
  const unknown = governance.kind === "unknown" ? governance.why : null;
  if (request.kind === "launch") {
    if (unknown) return unknown;
    return launchReason(request, governance.kind === "supervisor" ? governance.supervisor : null);
  }
  const change = changeReason(caller, target, request);
  if (!change) return null;
  return unknown ?? change;
}

function launchReason(
  request: Extract<PresetFenceRequest, { kind: "launch" }>,
  supervisor: FenceAgent | null,
): string | null {
  if (request.profileId !== supervisor?.config?.profileLaunch?.worker?.id) return "preset-required";
  return request.detached ? "detached" : null;
}

function changeReason(
  caller: FenceAgent,
  target: FenceAgent | null,
  request: Extract<PresetFenceRequest, { kind: "change" }>,
): string | null {
  const labels = request.labels;
  if (labels && GOVERNANCE_LABELS.some((label) => label in labels)) return "governance-label";
  if ((!request.settings && !request.mode) || !target || target.id === caller.id) return null;
  const governed =
    target.labels[PARENT_AGENT_ID_LABEL] === caller.id ||
    target.labels[LEAD_LAUNCH_REQUESTED_BY_LABEL] === caller.id;
  if (!governed) return null;
  return request.settings ? "settings-change" : "mode-change";
}

/** The Factory role a governed chain runs under, unverified: C1b checks the Factory record. */
function factoryRole(caller: FenceAgent, governance: FenceGovernance): string | null {
  const supervisor = governance.kind === "supervisor" ? governance.supervisor : null;
  return caller.labels[FACTORY_ROLE_LABEL] ?? supervisor?.labels[FACTORY_ROLE_LABEL] ?? null;
}

function shouldEnforce(
  policy: PresetFencePolicy | undefined,
  path: PresetFencePath,
  reason: string,
): boolean {
  if (policy?.mode !== "enforce" || policy.report?.includes(path)) return false;
  // The Factory role label is never an exemption: an unverified label must not be better than
  // none, so it only tags the log line. C1b may allow verified Factory launches, checked against
  // the Factory service's own role record.
  return ENFORCEABLE_REASONS.has(reason);
}

/**
 * Applies the fence for one agent-initiated operation. A failure to decide never throws or
 * replaces the operation's outcome; an enforced refusal throws before anything changes.
 */
export async function checkPresetFence(
  dependencies: FenceLookup & { logger: Logger },
  path: PresetFencePath,
  callerAgentId: string | undefined,
  request: PresetFenceRequest,
): Promise<void> {
  let reason: string | null = null;
  let enforce = false;
  let fields: Record<string, unknown> = {};
  let workerProfileId: string | null = null;
  try {
    const caller = callerAgentId ? await lookup(dependencies, callerAgentId) : null;
    if (!caller) return;
    const target =
      request.kind === "change" ? await lookup(dependencies, request.targetAgentId) : null;
    const governance = await governingSupervisor(caller, dependencies);
    reason = presetFenceReason(caller, target, request, governance);
    if (!reason) return;
    const supervisor = governance.kind === "supervisor" ? governance.supervisor : null;
    const role = factoryRole(caller, governance);
    workerProfileId = supervisor?.config?.profileLaunch?.worker?.id ?? null;
    enforce = shouldEnforce((dependencies.policy ?? effectivePresetFencePolicy)(), path, reason);
    fields = fenceFields({ path, reason, enforce, caller, supervisor, governance, role, request });
  } catch {
    return;
  }
  logRefusal(
    dependencies.logger,
    enforce ? PRESET_FENCE_REFUSED_MESSAGE : PRESET_FENCE_MESSAGE,
    fields,
  );
  if (enforce)
    throw new WorkerLaunchRefusal(
      `${refusalText(reason, workerProfileId)} To start a thread on another preset, call request_lead_launch; the owner confirms it. Retrying this call will be refused again.`,
      reason ?? PRESET_FENCE_CODE,
    );
}

function fenceFields(input: {
  path: PresetFencePath;
  reason: string;
  enforce: boolean;
  caller: FenceAgent;
  supervisor: FenceAgent | null;
  governance: FenceGovernance;
  role: string | null;
  request: PresetFenceRequest;
}): Record<string, unknown> {
  const { caller, supervisor, governance, role, request } = input;
  return {
    code: PRESET_FENCE_CODE,
    path: input.path,
    reason: input.reason,
    enforced: input.enforce,
    callerAgentId: caller.id,
    ...(supervisor && supervisor.id !== caller.id ? { supervisorAgentId: supervisor.id } : {}),
    // `forwarded`: the supervisor is on another daemon, known from the Host's record (C2).
    // `supervisorUnknown` says why a chain could not be followed: `parent-remote` (on another
    // daemon, nothing forwarded), `parent-unresolved`, `cycle` or `depth-limit`.
    ...(governance.kind === "supervisor" && governance.serverId
      ? { supervisorServerId: governance.serverId, governance: "forwarded" }
      : {}),
    ...(governance.kind === "unknown" ? { supervisorUnknown: governance.why } : {}),
    ...(role ? { factoryRole: role, factoryRoleStatus: "factory-role-unverified" } : {}),
    workerProfileId: supervisor?.config?.profileLaunch?.worker?.id ?? null,
    ...(request.kind === "launch"
      ? { requestedProfileId: request.profileId ?? null, detached: request.detached ?? false }
      : { targetAgentId: request.targetAgentId }),
  };
}

function refusalText(reason: string | null, workerProfileId: string | null): string {
  const preset = workerProfileId ? `worker preset ${workerProfileId}` : "its worker preset";
  if (reason === "detached") return `Threads in this team stay attached and use ${preset}.`;
  if (reason === "settings-change")
    return `This thread's model, thinking, features and account stay on ${preset}.`;
  if (reason === "cycle" || reason === "depth-limit")
    return "This thread's parent links cannot be followed, so it cannot launch or reshape threads.";
  return `This thread is held to ${preset}.`;
}

export type ForwardedGovernanceAdmission =
  | { admitted: ForwardedGovernance }
  | {
      refused:
        | "not-host-link"
        | "agent-caller"
        | "own-server"
        | "producer-mismatch"
        | "parent-mismatch"
        | "malformed";
    };

/**
 * Whether a create may store the governance it carries (C2). Only a daemon's remote create sends
 * it, over a host-link channel, and it describes the parent on that daemon. A forged or refused
 * value is never better than none: it is dropped and logged, the create proceeds, and the thread
 * stays `parent-remote`, which no slice refuses. A stored value only adds a supervisor.
 *
 * What this proves is limited (#525). A host-link channel is any session that arrived through
 * `hosts.link.open.request` on a connection holding this daemon's owner credentials; on Dev the
 * local credential sits in the guest home, which Dev agents can read. So a Dev agent can open a
 * link to its own daemon and claim any producer server. The checks below keep that from
 * shadowing a local chain: the parent must name another server, which leaves the fence only
 * `parent-remote` to replace.
 */
export function admitForwardedGovernance(input: {
  governance: ForwardedGovernance | undefined;
  /** Set only for a session admitted through a host-link channel; the producer is claimed. */
  hostLink: { producerServerId: string | null } | null;
  callerAgentId: string | undefined;
  labels: Record<string, string> | undefined;
  serverId: string | undefined;
}): ForwardedGovernanceAdmission | null {
  const { governance, hostLink } = input;
  if (!governance) return null;
  if (!hostLink) return { refused: "not-host-link" };
  if (input.callerAgentId) return { refused: "agent-caller" };
  if (!governance.supervisorAgentId || !governance.serverId || !governance.workerProfileId)
    return { refused: "malformed" };
  if (!input.serverId || governance.serverId === input.serverId) return { refused: "own-server" };
  if (hostLink.producerServerId !== governance.serverId) return { refused: "producer-mismatch" };
  if (
    input.labels?.[PARENT_SERVER_ID_LABEL] !== governance.serverId ||
    !input.labels[PARENT_AGENT_ID_LABEL]
  )
    return { refused: "parent-mismatch" };
  return { admitted: { ...governance } };
}

/**
 * An owner app session (`mobile` or `browser`). Only these may save the `presetFence` setting or
 * write reserved labels through session requests. The daemon has no unforgeable caller identity
 * yet (#525): a client declares its own type, and a CLI's calling agent comes from
 * PASEO_AGENT_ID. Admitting Builds by its thread ID would let any agent that knows the ID (it is
 * in the installed skill) switch the fence off.
 */
export function isOwnerAppClient(clientType: string | undefined): boolean {
  return clientType === "mobile" || clientType === "browser";
}
