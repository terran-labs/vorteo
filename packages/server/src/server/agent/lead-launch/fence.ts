import type { Logger } from "pino";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { WorkerLaunchRefusal, type ManagedAgent } from "../agent-manager.js";
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

type FenceAgent = Pick<ManagedAgent, "id" | "labels" | "config">;

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

/** Parent links followed upward; deeper chains are treated as ungoverned and not walked. */
const MAX_SUPERVISOR_DEPTH = 8;

/**
 * The nearest thread, starting with the caller and following parent labels, whose launch carries
 * a worker preset. Confirmed leads have no parent label, so they answer to their own preset.
 */
export function governingSupervisor(
  caller: FenceAgent,
  getAgent: (agentId: string) => FenceAgent | null | undefined,
): FenceAgent | null {
  let current: FenceAgent | null | undefined = caller;
  for (let depth = 0; current && depth <= MAX_SUPERVISOR_DEPTH; depth += 1) {
    if (current.config.profileLaunch?.worker) return current;
    const parentId: string | undefined = current.labels[PARENT_AGENT_ID_LABEL];
    current = parentId ? getAgent(parentId) : null;
  }
  return null;
}

/**
 * Why the fence would refuse, or null. Pure, so the case table can cover every path. Launches by
 * the supervisor or any thread beneath it must use the supervisor's worker preset and stay
 * attached, which keeps a builder's reviewer subagent on that preset allowed.
 */
export function presetFenceReason(
  caller: FenceAgent,
  target: FenceAgent | null,
  request: PresetFenceRequest,
  supervisor: FenceAgent | null = caller.config.profileLaunch?.worker ? caller : null,
): string | null {
  const worker = supervisor?.config.profileLaunch?.worker;
  if (!worker) return null;
  if (request.kind === "launch") {
    if (request.profileId !== worker.id) return "preset-required";
    if (request.detached) return "detached";
    return null;
  }
  if (!target || target.id === caller.id) return null;
  const governed =
    target.labels[PARENT_AGENT_ID_LABEL] === caller.id ||
    target.labels[LEAD_LAUNCH_REQUESTED_BY_LABEL] === caller.id;
  if (!governed) return null;
  if (request.labels && GOVERNANCE_LABELS.some((label) => label in request.labels!))
    return "governance-label";
  if (request.settings) return "settings-change";
  return null;
}

/**
 * Applies the fence for one agent-initiated operation. Logging never throws or replaces the
 * operation's outcome; once enforced, a refusal throws before anything changes.
 */
export function checkPresetFence(
  dependencies: { logger: Logger; getAgent: (agentId: string) => FenceAgent | null | undefined },
  path: PresetFencePath,
  callerAgentId: string | undefined,
  request: PresetFenceRequest,
): void {
  let reason: string | null = null;
  let fields: Record<string, unknown> = {};
  try {
    const caller = callerAgentId ? dependencies.getAgent(callerAgentId) : null;
    if (!caller) return;
    const target =
      request.kind === "change" ? (dependencies.getAgent(request.targetAgentId) ?? null) : null;
    const supervisor = governingSupervisor(caller, dependencies.getAgent);
    reason = presetFenceReason(caller, target, request, supervisor);
    if (!reason) return;
    fields = {
      code: PRESET_FENCE_CODE,
      path,
      reason,
      enforced: PRESET_FENCE_ENFORCED,
      callerAgentId: caller.id,
      ...(supervisor && supervisor.id !== caller.id ? { supervisorAgentId: supervisor.id } : {}),
      workerProfileId: supervisor?.config.profileLaunch?.worker?.id ?? null,
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
      reason,
    );
}
