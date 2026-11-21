/**
 * Report-only supervisor access ceiling (#518 slice 2, #530).
 *
 * Builds the comparator's inputs in `levels.ts` from the daemon's own records of the calling agent
 * and the target, calls it, and logs what enforcing the ceiling would refuse. Nothing here refuses,
 * changes or delays an operation: callers fire `report` without awaiting it, and every failure
 * is caught and logged once with a fixed code.
 *
 * Trust contract (see `levels.ts`): every daemon-asserted input below is computed from daemon
 * state. Nothing is read from tool arguments or from anything the calling agent supplies. The
 * records are read after the operation succeeds, so the target's mode and features are the
 * values the provider actually reports, not the values requested.
 *
 * Caller identity. The caller is the `callerAgentId` the agent MCP session was opened with. Owner
 * actions from the app arrive as WebSocket session requests and never reach these tools, and a
 * top-level MCP session has no caller agent; neither is evaluated. The agent MCP endpoint takes
 * `callerAgentId` from its query string, so a caller can claim another agent's identity (#525).
 * Every line logged here inherits that weakness.
 */

import { realpath } from "node:fs/promises";
import type { Logger } from "pino";

import type { ManagedAgent } from "../agent-manager.js";
import { logRefusal } from "../create-agent/create.js";
import { isPaseoOwnedWorktreeCwd } from "../../../utils/worktree.js";
import {
  compareChildAccess,
  type AccessComparisonOptions,
  type AccessDecision,
  type AccessEnvironment,
  type DaemonAssertions,
  type RequestedChildAccess,
  type SupervisorAccess,
} from "./levels.js";

export const WOULD_REFUSE_MESSAGE = "Access ceiling would refuse";
export const ALLOWED_MESSAGE = "Access ceiling would allow";
export const REPORT_FAILED_MESSAGE = "Access ceiling report failed";
export const REPORT_FAILED_CODE = "access_ceiling_report_failed";

export type CeilingOperation =
  | "create_agent"
  | "set_agent_mode"
  | "update_agent"
  | "respond_to_permission"
  | "switch_agent_profile";

/** The parts of a managed agent the derivation reads. A snapshot, so later changes do not leak in. */
export type CeilingAgentRecord = Pick<
  ManagedAgent,
  "id" | "provider" | "cwd" | "currentModeId" | "runtimeInfo" | "config" | "features"
>;

/** Live mode, in the same order the profile switch uses. */
export function liveModeId(agent: CeilingAgentRecord): string | null {
  return agent.currentModeId ?? agent.runtimeInfo?.modeId ?? agent.config.modeId ?? null;
}

/** Stored feature values overlaid with the provider's live values, as the profile switch does. */
export function effectiveFeatureValues(agent: CeilingAgentRecord): Record<string, unknown> {
  const values: Record<string, unknown> = { ...agent.config.featureValues };
  for (const feature of agent.features ?? []) values[feature.id] = feature.value;
  return values;
}

/**
 * Who answers the child's permission prompts. Today `respond_to_permission` accepts any agent id
 * and the permission notification tells supervisors to use it, so the truthful answer is the
 * supervisor. A later slice that routes worker prompts to the owner changes this one function.
 */
export function childPromptsAnsweredBy(): "supervisor" {
  return "supervisor";
}

/**
 * Whether the child's provider loads settings, hooks, allow rules or servers from a directory the
 * supervisor can write. Nothing launches agent-requested children without project or local
 * provider configuration today, so the truthful answer is yes, for every provider. A later slice
 * that disables those sources changes this one function.
 */
export function childLoadsSupervisorWritableConfig(): true {
  return true;
}

const CODEX_PRESET_MODES: ReadonlySet<string> = new Set([
  "read-only",
  "auto",
  "auto-review",
  "full-access",
]);
/** Codex provider options that replace a preset's sandbox or approval boundary (codex/options.ts). */
const CODEX_BOUNDARY_OPTIONS = ["sandbox_mode", "approval_policy", "sandbox_workspace_write"];
/** Claude provider options that widen or replace the permission mode (claude/options.ts). */
const CLAUDE_BOUNDARY_OPTIONS = [
  "allowedTools",
  "additionalDirectories",
  "extraArgs",
  "sandbox",
  "settings",
];

export type ModeAuthorityReason =
  | "authoritative"
  | "mode-absent"
  | "mode-not-applied"
  | "provider-option-override"
  | "tool-policy-grants"
  | "controller-governed"
  | "provider-not-established";

/**
 * Whether the agent's mode id is its real boundary, from daemon state alone. Only the exact `codex`
 * and `claude` provider ids are established; every other id, including account and custom ids that
 * extend them, is not authoritative because their configuration is not visible here.
 *
 * - Both: the configured mode must equal the live mode. `setAgentMode` writes `config.modeId`, and
 *   Codex applies a preset only when a mode was configured (codex-app-server-agent.ts,
 *   `hasWorkflowModeOverride`). A controller-registered session may run under a governed
 *   permission profile the agent record does not carry.
 * - Codex: no `sandbox_mode`, `approval_policy` or `sandbox_workspace_write` provider option.
 * - Claude: no allowed tools, additional directories, extra arguments, sandbox or settings
 *   provider option, and no tool policy with preapproved grants.
 */
export function modeAuthority(agent: CeilingAgentRecord): ModeAuthorityReason {
  const live = liveModeId(agent);
  if (live === null) return "mode-absent";
  if (agent.provider !== "codex" && agent.provider !== "claude") return "provider-not-established";
  if (agent.config.controllerExecutionId !== undefined) return "controller-governed";
  if (agent.config.modeId !== live) return "mode-not-applied";
  const options = agent.config.providerOptions ?? {};
  if (agent.provider === "codex") {
    if (!CODEX_PRESET_MODES.has(live)) return "mode-not-applied";
    if (CODEX_BOUNDARY_OPTIONS.some((key) => options[key] !== undefined))
      return "provider-option-override";
    return "authoritative";
  }
  if (CLAUDE_BOUNDARY_OPTIONS.some((key) => options[key] !== undefined))
    return "provider-option-override";
  if ((agent.config.toolPolicy?.preapproved.length ?? 0) > 0) return "tool-policy-grants";
  return "authoritative";
}

/** Inputs the daemon derives for one comparison. Pure: no I/O. */
export function deriveAssertions(
  supervisor: CeilingAgentRecord,
  child: CeilingAgentRecord,
): DaemonAssertions {
  return {
    supervisorModeAuthoritative: modeAuthority(supervisor) === "authoritative",
    childModeAuthoritative: modeAuthority(child) === "authoritative",
    childPromptsAnsweredBy: childPromptsAnsweredBy(),
    childLoadsSupervisorWritableConfig: childLoadsSupervisorWritableConfig(),
  };
}

/**
 * Both sides run under this daemon, so they share its environment. The kind comes from the Dev
 * container's network mode variable; it cannot differ between the two sides, so it never decides
 * a result. A missing server id is passed as empty, which the comparator refuses.
 */
export function daemonEnvironment(serverId: string | undefined): AccessEnvironment {
  return { kind: process.env.PASEO_NETWORK_MODE ? "container" : "host", id: serverId ?? "" };
}

/** Real path now, or empty when it cannot be resolved; the comparator refuses empty paths. */
async function resolveRealPath(path: string | undefined): Promise<string> {
  if (!path) return "";
  try {
    return await realpath(path);
  } catch {
    return "";
  }
}

function isWithin(path: string, base: string): boolean {
  return path === base || base === "/" || path.startsWith(`${base}/`);
}

export interface ReporterDependencies {
  getAgent(agentId: string): ManagedAgent | null | undefined;
  logger: Logger;
  serverId?: string;
  paseoHome?: string;
  worktreesRoot?: string;
}

/**
 * Comparator inputs for one supervisor and child, with real paths resolved immediately before
 * the call. A child outside the supervisor's directory is credited to a daemon-created worktree
 * only when the daemon's own ownership check proves the worktree is Paseo's.
 */
export async function buildComparison(
  dependencies: Pick<ReporterDependencies, "serverId" | "paseoHome" | "worktreesRoot">,
  supervisor: CeilingAgentRecord,
  child: CeilingAgentRecord,
): Promise<{
  supervisor: SupervisorAccess;
  child: RequestedChildAccess;
  asserted: DaemonAssertions;
  options: AccessComparisonOptions;
}> {
  const environment = daemonEnvironment(dependencies.serverId);
  const [supervisorDirectory, childDirectory] = await Promise.all([
    resolveRealPath(supervisor.cwd),
    resolveRealPath(child.cwd),
  ]);
  const options: AccessComparisonOptions = {};
  if (childDirectory && supervisorDirectory && !isWithin(childDirectory, supervisorDirectory)) {
    const ownership = await isPaseoOwnedWorktreeCwd(child.cwd, {
      paseoHome: dependencies.paseoHome,
      worktreesRoot: dependencies.worktreesRoot,
    }).catch(() => null);
    if (ownership?.allowed && ownership.worktreePath && ownership.worktreeRoot) {
      const [worktree, root] = await Promise.all([
        resolveRealPath(ownership.worktreePath),
        resolveRealPath(ownership.worktreeRoot),
      ]);
      if (worktree && root) {
        options.daemonCreatedWorktrees = [worktree];
        options.worktreesRoot = root;
      }
    }
  }
  return {
    supervisor: {
      provider: supervisor.provider,
      modeId: liveModeId(supervisor),
      featureValues: effectiveFeatureValues(supervisor),
      environment,
      directory: supervisorDirectory,
    },
    child: {
      provider: child.provider,
      modeId: liveModeId(child),
      featureValues: effectiveFeatureValues(child),
      environment,
      directory: childDirectory,
      // Agents cannot change tool access through these operations; the comparator only needs to
      // know nothing was set or cleared.
      toolAccess: "unchanged",
    },
    asserted: deriveAssertions(supervisor, child),
    options,
  };
}

/** Whether a refusal holds even when every daemon assertion favours the child. */
export type RefusalClass = "known-violation" | "assertion-dependent" | "unmapped";

function classify(decision: AccessDecision, favourable: AccessDecision): RefusalClass | null {
  if (decision.kind === "allowed") return null;
  if (decision.kind !== "refused") return "unmapped";
  return favourable.kind === "refused" ? "known-violation" : "assertion-dependent";
}

/**
 * The best case for the child: only used to tell known violations from refusals that depend on
 * the asserted inputs. Never passed off as a truthful assertion.
 */
const FAVOURABLE_ASSERTIONS: DaemonAssertions = {
  supervisorModeAuthoritative: true,
  childModeAuthoritative: true,
  childPromptsAnsweredBy: "owner",
  childLoadsSupervisorWritableConfig: false,
};

const LOG_STRING_LIMIT = 200;

/** Every field is a primitive; cut strings to the same limit as `logRefusal`. */
function boundFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, LOG_STRING_LIMIT) : value,
    ]),
  );
}

function codes(values: readonly string[]): string {
  return values.join(",");
}

function decisionFields(decision: AccessDecision): Record<string, string> {
  switch (decision.kind) {
    case "allowed":
      return { childEscalations: codes(decision.childEscalations) };
    case "refused":
      return {
        reasons: codes(decision.reasons),
        childEscalations: codes(decision.childEscalations),
      };
    case "unmapped":
      return {
        supervisorUnmapped: codes(decision.supervisor),
        childUnmapped: codes(decision.child),
      };
    case "unmapped-under-unattended-supervisor":
      return { childUnmapped: codes(decision.child) };
  }
}

/** One record: codes, ids, provider ids and mode ids only. No paths, prompts or caller text. */
function evaluationFields(
  operation: CeilingOperation,
  supervisor: CeilingAgentRecord,
  child: CeilingAgentRecord,
  decision: AccessDecision,
  favourable: AccessDecision,
  asserted: DaemonAssertions,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    code: "access_ceiling_report",
    operation,
    callerAgentId: supervisor.id,
    targetAgentId: child.id,
    selfChange: supervisor.id === child.id,
    callerProvider: supervisor.provider,
    targetProvider: child.provider,
    callerMode: liveModeId(supervisor),
    targetMode: liveModeId(child),
    result: decision.kind,
    classification: classify(decision, favourable),
    favourableResult: favourable.kind,
    ...decisionFields(decision),
    assertedChildPromptsAnsweredBy: asserted.childPromptsAnsweredBy,
    assertedChildLoadsSupervisorWritableConfig: asserted.childLoadsSupervisorWritableConfig,
    assertedSupervisorModeAuthoritative: asserted.supervisorModeAuthoritative,
    assertedChildModeAuthoritative: asserted.childModeAuthoritative,
    callerModeAuthority: modeAuthority(supervisor),
    targetModeAuthority: modeAuthority(child),
    callerIdentity: "mcp-session-query",
    ...extra,
  };
}

/** A shallow copy, so a later change to the live agent (the caller may be the target) is not seen. */
export function snapshotRecord(agent: CeilingAgentRecord): CeilingAgentRecord {
  return {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    currentModeId: agent.currentModeId,
    runtimeInfo: agent.runtimeInfo ? { ...agent.runtimeInfo } : undefined,
    config: { ...agent.config },
    features: agent.features ? agent.features.map((feature) => ({ ...feature })) : undefined,
  };
}

export interface CeilingEvaluation {
  /**
   * Evaluates the target's current record against the caller as it was when `begin` ran. Never
   * rejects; callers do not await it.
   */
  report(targetAgentId: string, extra?: Record<string, unknown>): Promise<void>;
}

const NOOP_EVALUATION: CeilingEvaluation = { report: async () => {} };

/** Reports an account switch only when it happened; refusals, skips and dry runs change nothing. */
export function reportIfSwitched(
  evaluation: CeilingEvaluation,
  result: { agentId: string; outcome: string } | undefined,
): void {
  if (result?.outcome === "switched") void evaluation.report(result.agentId);
}

function logFailure(
  logger: Logger,
  operation: CeilingOperation,
  reason: "record-missing" | "error",
): void {
  try {
    logger.warn({ code: REPORT_FAILED_CODE, operation, reason }, REPORT_FAILED_MESSAGE);
  } catch {
    // The operation's own outcome matters more than this record.
  }
}

/**
 * Starts one report-only evaluation. Captures the calling agent before the operation runs, because
 * the caller can be the target. Returns a no-op when there is no calling agent (owner or top-level
 * sessions). Never throws.
 */
export function beginCeilingReport(
  dependencies: ReporterDependencies,
  callerAgentId: string | undefined,
  operation: CeilingOperation,
): CeilingEvaluation {
  if (!callerAgentId) return NOOP_EVALUATION;
  let caller: CeilingAgentRecord | null = null;
  try {
    const live = dependencies.getAgent(callerAgentId);
    caller = live ? snapshotRecord(live) : null;
  } catch {
    caller = null;
  }
  return {
    report: async (targetAgentId, extra = {}) => {
      try {
        const target = dependencies.getAgent(targetAgentId);
        if (!caller || !target) {
          logFailure(dependencies.logger, operation, "record-missing");
          return;
        }
        const supervisor = caller;
        const child = snapshotRecord(target);
        const input = await buildComparison(dependencies, supervisor, child);
        const decision = compareChildAccess(
          input.supervisor,
          input.child,
          input.asserted,
          input.options,
        );
        const favourable = compareChildAccess(
          input.supervisor,
          input.child,
          FAVOURABLE_ASSERTIONS,
          input.options,
        );
        const fields = evaluationFields(
          operation,
          supervisor,
          child,
          decision,
          favourable,
          input.asserted,
          extra,
        );
        if (decision.kind === "allowed") {
          try {
            dependencies.logger.debug(boundFields(fields), ALLOWED_MESSAGE);
          } catch {
            // Never let the record replace the operation's outcome.
          }
          return;
        }
        logRefusal(dependencies.logger, WOULD_REFUSE_MESSAGE, fields);
      } catch {
        logFailure(dependencies.logger, operation, "error");
      }
    },
  };
}
