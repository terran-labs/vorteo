import type { Logger } from "pino";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { WorkerLaunchRefusal } from "../agent-manager.js";
import { logRefusal } from "../create-agent/create.js";
import { LEAD_LAUNCH_ID_LABEL, LEAD_LAUNCH_REQUESTED_BY_LABEL } from "./model.js";

/**
 * The preset fence (#360, slice B). A coordinator launched with a worker preset may start or
 * reshape threads only on that preset, or exactly as the owner confirmed through
 * request_lead_launch. The same holds for every thread beneath it: a worker preset never has a
 * worker of its own, so without this a coordinator could ask its worker to launch any preset.
 * MCP `create_agent` from the coordinator itself already refuses; every other agent-initiated
 * path checks here.
 *
 * Report-only for now: a would-refuse decision is logged and the operation proceeds, so current
 * flows can be measured before they break. Slice C sets PRESET_FENCE_ENFORCED after Builds
 * reviews a day of installed logs.
 */
export const PRESET_FENCE_ENFORCED = false;
export const PRESET_FENCE_MESSAGE = "Preset fence would refuse";
const PRESET_FENCE_CODE = "preset_fence";

export type PresetFencePath =
  | "create_agent"
  | "remote_create_agent"
  | "session_create_agent"
  | "update_agent"
  | "set_agent_mode"
  | "send_agent_prompt"
  | "switch_agent_profile"
  | "create_schedule"
  | "update_schedule"
  | "run_schedule_once"
  | "resume_schedule";

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
}

/** Labels that record who governs a thread. Agents may not set, change or clear them. */
const GOVERNANCE_LABELS = [
  PARENT_AGENT_ID_LABEL,
  LEAD_LAUNCH_REQUESTED_BY_LABEL,
  LEAD_LAUNCH_ID_LABEL,
] as const;

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
      settings?: boolean;
      labels?: Record<string, string> | null;
    };

/**
 * Who governs a caller. `unknown` means a parent link could not be followed to its end: a parent
 * this daemon has no record of (deleted, or on another host), a cycle, or too deep a chain. It is
 * never treated as "not governed".
 */
export type FenceGovernance =
  | { kind: "none" }
  | { kind: "supervisor"; supervisor: FenceAgent }
  | { kind: "unknown"; why: "parent-unresolved" | "cycle" | "depth-limit" };

/** Parent links followed upward before the chain counts as unknown. */
const MAX_SUPERVISOR_DEPTH = 8;

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
    if (!parent) return { kind: "unknown", why: "parent-unresolved" };
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
 * - Settings changes are flagged on the caller's own workers and confirmed leads.
 * - An unknown chain flags whatever a known supervisor would have been asked to allow.
 */
export function presetFenceReason(
  caller: FenceAgent,
  target: FenceAgent | null,
  request: PresetFenceRequest,
  governance: FenceGovernance = ownGovernance(caller),
): string | null {
  if (governance.kind === "none") return null;
  const unknown = governance.kind === "unknown";
  if (request.kind === "launch") {
    if (unknown) return "supervisor-unknown";
    if (request.profileId !== governance.supervisor.config?.profileLaunch?.worker?.id)
      return "preset-required";
    if (request.detached) return "detached";
    return null;
  }
  if (request.labels && GOVERNANCE_LABELS.some((label) => label in request.labels!))
    return unknown ? "supervisor-unknown" : "governance-label";
  if (!request.settings || !target || target.id === caller.id) return null;
  const governed =
    target.labels[PARENT_AGENT_ID_LABEL] === caller.id ||
    target.labels[LEAD_LAUNCH_REQUESTED_BY_LABEL] === caller.id;
  if (!governed) return null;
  return unknown ? "supervisor-unknown" : "settings-change";
}

/**
 * Applies the fence for one agent-initiated operation. Logging never throws or replaces the
 * operation's outcome; once enforced, a refusal throws before anything changes.
 */
export async function checkPresetFence(
  dependencies: FenceLookup & { logger: Logger },
  path: PresetFencePath,
  callerAgentId: string | undefined,
  request: PresetFenceRequest,
): Promise<void> {
  let reason: string | null = null;
  let fields: Record<string, unknown> = {};
  try {
    const caller = callerAgentId ? await lookup(dependencies, callerAgentId) : null;
    if (!caller) return;
    const target =
      request.kind === "change" ? await lookup(dependencies, request.targetAgentId) : null;
    const governance = await governingSupervisor(caller, dependencies);
    reason = presetFenceReason(caller, target, request, governance);
    if (!reason) return;
    const supervisor = governance.kind === "supervisor" ? governance.supervisor : null;
    fields = {
      code: PRESET_FENCE_CODE,
      path,
      reason,
      enforced: PRESET_FENCE_ENFORCED,
      callerAgentId: caller.id,
      ...(supervisor && supervisor.id !== caller.id ? { supervisorAgentId: supervisor.id } : {}),
      ...(governance.kind === "unknown" ? { supervisorUnknown: governance.why } : {}),
      workerProfileId: supervisor?.config?.profileLaunch?.worker?.id ?? null,
      ...(request.kind === "launch"
        ? { requestedProfileId: request.profileId ?? null, detached: request.detached ?? false }
        : { targetAgentId: request.targetAgentId }),
    };
  } catch {
    return;
  }
  logRefusal(dependencies.logger, PRESET_FENCE_MESSAGE, fields);
  if (PRESET_FENCE_ENFORCED)
    throw new WorkerLaunchRefusal(
      "Your worker preset does not allow this. Use your worker preset, or request_lead_launch for a lead the owner confirms.",
      reason ?? PRESET_FENCE_CODE,
    );
}
