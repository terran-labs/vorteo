import type { Logger } from "pino";
import { PARENT_AGENT_ID_LABEL, PARENT_SERVER_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { PresetFencePolicy } from "@getpaseo/protocol/messages";
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
  | { kind: "supervisor"; supervisor: FenceAgent }
  | { kind: "unknown"; why: FenceUnknown };

/** Parent links followed upward before the chain counts as unknown. */
const MAX_SUPERVISOR_DEPTH = 8;

/**
 * Refused when the setting enforces. The others stay report-only in this slice: mode changes
 * until #518, governance labels until the owner's split instruction changes (D6), and chains
 * this daemon cannot follow until cross-host governance (C2) and the D2 decision.
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
 * The nearest thread, starting with the caller and following parent labels, whose launch carries
 * a worker preset. Confirmed leads have no parent label, so they answer to their own preset.
 */
export async function governingSupervisor(
  caller: FenceAgent,
  dependencies: FenceLookup,
): Promise<FenceGovernance> {
  const visited = new Set<string>([caller.id]);
  let current = caller;
  for (let depth = 0; depth <= MAX_SUPERVISOR_DEPTH; depth += 1) {
    if (current.config?.profileLaunch?.worker) return { kind: "supervisor", supervisor: current };
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
