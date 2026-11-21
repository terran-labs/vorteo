/**
 * Report-only supervisor access ceiling (#518 slice 2, #530).
 *
 * Builds the comparator's inputs in `levels.ts` from the daemon's own records of the calling agent
 * and the target, calls it, and logs what enforcing the ceiling would refuse. Nothing here refuses,
 * changes or delays an operation: callers fire `report` without awaiting it, and every failure
 * is caught and logged once with a fixed code.
 *
 * Trust contract (see `levels.ts`): every daemon-asserted input below is computed from daemon
 * state. Nothing is read from tool arguments or from anything the calling agent supplies. An
 * existing target's record is read after each change is applied, so its mode and features are
 * the values the provider reports. A target that does not exist yet (a schedule's future agent,
 * a create on a connected host) is described by the daemon's stored request: the schedule record
 * the service returned, or the validated tool input forwarded to the other host.
 *
 * Four kinds of line, all with `code: "access_ceiling_report"`:
 * - "Access ceiling would refuse" (warn): a supervisor and child comparison that is not allowed.
 * - "Access ceiling self-escalation" (warn): an agent raised its own tier or left the table.
 * - "Agent answered another agent's permission prompt" (info): every such answer, whatever the
 *   comparator says, because who answers prompts is the fact the ceiling depends on.
 * - "Access ceiling would allow" (debug) and quiet self changes (debug).
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
import { resolveRequiredProviderModel } from "../mcp-shared.js";
import {
  attendedClass,
  compareChildAccess,
  resolveSupervisorTier,
  type AccessComparisonOptions,
  type AccessDecision,
  type AccessEnvironment,
  type AccessTier,
  type DaemonAssertions,
  type RequestedChildAccess,
  type SupervisorAccess,
} from "./levels.js";

export const WOULD_REFUSE_MESSAGE = "Access ceiling would refuse";
export const ALLOWED_MESSAGE = "Access ceiling would allow";
export const SELF_ESCALATION_MESSAGE = "Access ceiling self-escalation";
export const SELF_CHANGE_MESSAGE = "Access ceiling self change";
export const PERMISSION_ANSWER_MESSAGE = "Agent answered another agent's permission prompt";
export const REPORT_FAILED_MESSAGE = "Access ceiling report failed";
export const REPORT_FAILED_CODE = "access_ceiling_report_failed";
const REPORT_CODE = "access_ceiling_report";

export type CeilingOperation =
  | "create_agent"
  | "remote_create_agent"
  | "send_agent_prompt"
  | "remote_send_agent_prompt"
  | "set_agent_mode"
  | "update_agent"
  | "respond_to_permission"
  | "switch_agent_profile"
  | "create_schedule"
  | "update_schedule"
  | "run_schedule_once"
  | "resume_schedule";

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

/** Facts about a child the daemon has from the request it stored or forwarded, not from a record. */
export interface ChildRequestFacts {
  /**
   * A connected host's server id. Its environment kind is not known here, so the child is given
   * this daemon's kind; the differing id alone makes the comparator refuse with
   * `environment:mismatch`, as the signed table requires for cross-environment launches.
   */
  environmentId?: string;
  /** The launch's `unattended` flag. The schedule service always launches with `true`. */
  unattended?: boolean;
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
  request: ChildRequestFacts = {},
): Promise<{
  supervisor: SupervisorAccess;
  child: RequestedChildAccess;
  asserted: DaemonAssertions;
  options: AccessComparisonOptions;
}> {
  const environment = daemonEnvironment(dependencies.serverId);
  const childEnvironment = request.environmentId
    ? { kind: environment.kind, id: request.environmentId }
    : environment;
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
      environment: childEnvironment,
      directory: childDirectory,
      ...(request.unattended !== undefined ? { unattended: request.unattended } : {}),
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
    code: REPORT_CODE,
    operation,
    callerAgentId: supervisor.id,
    // Empty for a target that does not exist yet; its schedule or server id is in the extras.
    targetAgentId: child.id || null,
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

/** A target that does not exist yet, as the daemon stored or forwarded it. */
export type RequestedTarget =
  | {
      /** A label for the log: the schedule id, or the remote server id. */
      label: string;
      provider: string;
      modeId?: string | null;
      featureValues?: Record<string, unknown>;
      providerOptions?: Record<string, unknown>;
      /** A path on this machine, resolved immediately before the comparison. */
      cwd?: string;
      facts: ChildRequestFacts;
      extra?: Record<string, unknown>;
    }
  | { label: string; unresolved: string; extra?: Record<string, unknown> };

/**
 * A record for a requested child. The configured mode equals the live mode by construction, so
 * mode authority follows the same provider-option rules as a created agent; an absent mode stays
 * absent and the comparator reports it unmapped.
 */
function requestedRecord(
  target: Extract<RequestedTarget, { provider: string }>,
): CeilingAgentRecord {
  return {
    id: "",
    provider: target.provider,
    cwd: target.cwd ?? "",
    currentModeId: target.modeId ?? null,
    features: [],
    config: {
      provider: target.provider,
      cwd: target.cwd ?? "",
      ...(target.modeId ? { modeId: target.modeId } : {}),
      ...(target.providerOptions ? { providerOptions: target.providerOptions } : {}),
      ...(target.featureValues ? { featureValues: target.featureValues } : {}),
    },
  };
}

const TIER_RANK: Record<AccessTier, number> = { "read-only": 0, attended: 1, unattended: 2 };

/**
 * An agent's own tier from the comparator's mode table and feature rules alone. Authority is not
 * asserted here: this only places a mode in the table, so a change can be compared with the last.
 */
function ownTier(agent: CeilingAgentRecord): { tier: AccessTier } | { unmapped: string } {
  const resolved = resolveSupervisorTier(
    {
      provider: agent.provider,
      modeId: liveModeId(agent),
      featureValues: effectiveFeatureValues(agent),
      environment: { kind: "host", id: "self" },
      directory: "/",
    },
    { supervisorModeAuthoritative: true },
  );
  return "tier" in resolved ? { tier: resolved.tier } : { unmapped: codes(resolved.unmapped) };
}

/** What a self change can alter that bears on access: provider, mode and feature values. */
function accessState(agent: CeilingAgentRecord): string {
  const features = Object.entries(effectiveFeatureValues(agent)).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify([agent.provider, liveModeId(agent), features]);
}

export type SelfChangeReason =
  | "self-escalation"
  | "self-unmapped"
  | "self-from-unmapped"
  | "self-class-escalation"
  | "self-class-change";

/**
 * The self-change rule. An agent's own prompts are not answered by a supervisor, so the
 * supervisor and child comparison does not apply. A change is logged when:
 * - the new tier is unattended and the old state was not (including from unmapped);
 * - the new state is unmapped or unresolved;
 * - the old state was unmapped or unresolved and anything bearing on access changed;
 * - the tier rises;
 * - within attended, owner-gated writes move to unprompted writes or machine review
 *   (`self-class-escalation`), or those two swap, since neither contains the other
 *   (`self-class-change`).
 * A restriction or a same-class change logs at debug only.
 */
export function selfChangeReason(
  before: CeilingAgentRecord,
  after: CeilingAgentRecord,
): SelfChangeReason | null {
  const from = ownTier(before);
  const to = ownTier(after);
  const fromTier = "tier" in from ? from.tier : null;
  const toTier = "tier" in to ? to.tier : null;
  if (toTier === "unattended" && fromTier !== "unattended") return "self-escalation";
  if (toTier === null) return "self-unmapped";
  if (fromTier === null)
    return accessState(before) === accessState(after) ? null : "self-from-unmapped";
  if (TIER_RANK[toTier] > TIER_RANK[fromTier]) return "self-escalation";
  if (fromTier !== "attended" || toTier !== "attended") return null;
  const fromClass = attendedClass({ provider: before.provider, modeId: liveModeId(before) });
  const toClass = attendedClass({ provider: after.provider, modeId: liveModeId(after) });
  if (!fromClass || !toClass || fromClass === toClass || toClass === "owner-gated-writes")
    return null;
  return fromClass === "owner-gated-writes" ? "self-class-escalation" : "self-class-change";
}

function selfChangeLine(
  operation: CeilingOperation,
  before: CeilingAgentRecord,
  after: CeilingAgentRecord,
  extra: Record<string, unknown>,
): { message: string; warn: boolean; fields: Record<string, unknown> } {
  const from = ownTier(before);
  const to = ownTier(after);
  const reason = selfChangeReason(before, after);
  const classOf = (agent: CeilingAgentRecord) =>
    attendedClass({ provider: agent.provider, modeId: liveModeId(agent) }) ?? "none";
  const fields = {
    code: REPORT_CODE,
    operation: `self_${operation}`,
    agentId: after.id,
    provider: after.provider,
    modeBefore: liveModeId(before),
    modeAfter: liveModeId(after),
    tierBefore: "tier" in from ? from.tier : "unmapped",
    tierAfter: "tier" in to ? to.tier : "unmapped",
    classBefore: classOf(before),
    classAfter: classOf(after),
    ...("unmapped" in from ? { unmappedBefore: from.unmapped } : {}),
    ...("unmapped" in to ? { unmappedAfter: to.unmapped } : {}),
    reason: reason ?? "self-no-rise",
    callerIdentity: "mcp-session-query",
    ...extra,
  };
  return reason
    ? { message: SELF_ESCALATION_MESSAGE, warn: true, fields }
    : { message: SELF_CHANGE_MESSAGE, warn: false, fields };
}

export interface CeilingEvaluation {
  /**
   * Evaluates an existing target's current record against the caller. An agent changing itself
   * gets the self-change rule instead. Never rejects; callers do not await it.
   */
  report(targetAgentId: string, extra?: Record<string, unknown>): Promise<void>;
  /** Evaluates a target that does not exist yet. Never rejects. */
  reportRequested(target: RequestedTarget): Promise<void>;
  /**
   * Records one agent's answer to another agent's permission prompt at info, with the
   * comparator's result for the pair. Never rejects.
   */
  /**
   * Snapshots a target's record now, synchronously, so a later report can say what it was
   * before the operation. Cheap: a lookup and a shallow copy. Never throws.
   */
  noteTarget(targetAgentId: string): void;
  reportPermissionAnswer(
    targetAgentId: string,
    response: {
      behavior: "allow" | "deny";
      updatedPermissions?: unknown[];
      selectedActionId?: string;
    },
  ): Promise<void>;
}

const NOOP_EVALUATION: CeilingEvaluation = {
  report: async () => {},
  reportRequested: async () => {},
  noteTarget: () => {},
  reportPermissionAnswer: async () => {},
};

/** Reports an account switch only when it happened; refusals, skips and dry runs change nothing. */
export function reportIfSwitched(
  evaluation: CeilingEvaluation,
  result: { agentId: string; outcome: string } | undefined,
): void {
  if (result?.outcome === "switched") void evaluation.report(result.agentId);
}

interface ScheduleLike {
  id: string;
  target: { type: string; config?: unknown };
}

/** The target fields that bear on access: provider, mode, features and directory. */
function scheduleTargetKey(schedule: ScheduleLike): string {
  const config = (schedule.target.config ?? {}) as Record<string, unknown>;
  const features = Object.entries((config.featureValues ?? {}) as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return JSON.stringify([
    schedule.target.type,
    config.provider,
    config.modeId,
    features,
    config.cwd,
    config.isolation,
  ]);
}

/** A schedule's future agent, from the record the schedule service returned. */
export function reportSchedule(
  evaluation: CeilingEvaluation,
  schedule: ScheduleLike,
  options: {
    /** The schedule before an update: an update that leaves the target alone logs nothing. */
    previous?: ScheduleLike;
    /** The agent ran or resumed an existing schedule rather than arranging one. */
    triggered?: boolean;
  } = {},
): void {
  if (options.previous && scheduleTargetKey(options.previous) === scheduleTargetKey(schedule))
    return;
  const config = schedule.target.config as
    | {
        provider?: string;
        modeId?: string;
        cwd?: string;
        isolation?: string;
        featureValues?: Record<string, unknown>;
        providerOptions?: Record<string, unknown>;
      }
    | undefined;
  if (schedule.target.type !== "new-agent" || !config?.provider) {
    void evaluation.reportRequested({ label: schedule.id, unresolved: "schedule-target" });
    return;
  }
  void evaluation.reportRequested({
    label: schedule.id,
    provider: config.provider,
    modeId: config.modeId ?? null,
    featureValues: config.featureValues,
    providerOptions: config.providerOptions,
    cwd: config.cwd,
    // The schedule service launches every run with `unattended: true` (schedule/service.ts).
    facts: { unattended: true },
    extra: {
      scheduleId: schedule.id,
      isolation: config.isolation ?? "local",
      // Schedule records do not store who created them. Join on scheduleId against
      // create_schedule lines to tell an agent's own schedule from one it did not arrange.
      ...(options.triggered ? { scheduleCreator: "not-recorded" } : {}),
    },
  });
}

/**
 * A successful `create_agent`, or a `send_agent_prompt` carrying `sessionMode`, forwarded to a
 * connected host. Only the validated tool input is known here. For a create, the remote
 * directory cannot be resolved on this machine, so it is passed empty. For a prompt, the
 * recipient's record lives on the other host, so the line is unmapped with a fixed reason and
 * says the mode change was requested, not that it applied.
 */
export function reportRemoteOperation(
  evaluate: (operation: CeilingOperation) => CeilingEvaluation,
  tool: string,
  destination: string | undefined,
  localServerId: string | undefined,
  input: Record<string, unknown>,
  failed: boolean | undefined,
): void {
  if (failed || !destination || destination === localServerId) return;
  if (tool === "send_agent_prompt") {
    if (typeof input.sessionMode !== "string" || !input.sessionMode) return;
    void evaluate("remote_send_agent_prompt").reportRequested({
      label: destination,
      unresolved: "remote-recipient",
      extra: { remoteServerId: destination, change: "session-mode", applied: "unknown-remote" },
    });
    return;
  }
  if (tool !== "create_agent") return;
  const settings = (input.settings ?? {}) as {
    modeId?: unknown;
    features?: unknown;
  };
  let provider: string | null = null;
  try {
    provider =
      typeof input.provider === "string"
        ? resolveRequiredProviderModel(input.provider).provider
        : null;
  } catch {
    provider = null;
  }
  const extra = { remoteServerId: destination, targetDirectory: "unresolved-remote" };
  const evaluation = evaluate("remote_create_agent");
  if (!provider) {
    void evaluation.reportRequested({ label: destination, unresolved: "remote-provider", extra });
    return;
  }
  void evaluation.reportRequested({
    label: destination,
    provider,
    modeId: typeof settings.modeId === "string" ? settings.modeId : null,
    featureValues:
      settings.features && typeof settings.features === "object"
        ? (settings.features as Record<string, unknown>)
        : undefined,
    facts: { environmentId: destination },
    extra,
  });
}

/**
 * A queued `send_agent_prompt` with `sessionMode`: the recipient's mode is set when the batch
 * dispatches, seconds later. Reports after dispatch, never awaited. A rejected or cancelled
 * dispatch logs only if the recipient's mode did change to the requested one (the mode is set
 * before the prompt starts, so a later failure can leave it applied). Without `sessionMode`
 * nothing is reported.
 */
export function reportSessionMode(
  evaluate: () => CeilingEvaluation,
  getAgent: (agentId: string) => CeilingAgentRecord | null | undefined,
  agentId: string,
  sessionMode: string | undefined,
  dispatched: Promise<unknown>,
): void {
  if (!sessionMode) return;
  let evaluation: CeilingEvaluation;
  let before: string | null = null;
  try {
    evaluation = evaluate();
    const target = getAgent(agentId);
    before = target ? liveModeId(target) : null;
  } catch {
    return;
  }
  const modeNow = (): string | null => {
    try {
      const target = getAgent(agentId);
      return target ? liveModeId(target) : null;
    } catch {
      return null;
    }
  };
  dispatched
    .then(
      () => evaluation.report(agentId, { change: "session-mode" }),
      () =>
        modeNow() === sessionMode && before !== sessionMode
          ? evaluation.report(agentId, { change: "session-mode", dispatch: "failed-after-mode" })
          : undefined,
    )
    .catch(() => undefined);
}

/**
 * Mode before and after a permission answer, from the requester's records. "unknown" when a
 * record is missing. Tier and attended class come from the same helpers as the self-change rule
 * and are added only when both modes map.
 */
function answerModeChange(
  before: CeilingAgentRecord | null,
  after: CeilingAgentRecord | null,
): Record<string, unknown> {
  const modeBefore = before ? liveModeId(before) : "unknown";
  const modeAfter = after ? liveModeId(after) : "unknown";
  const fields: Record<string, unknown> = {
    modeBefore,
    modeAfter,
    modeChanged: before !== null && after !== null && modeBefore !== modeAfter,
  };
  if (!before || !after) return fields;
  const from = ownTier(before);
  const to = ownTier(after);
  if (!("tier" in from) || !("tier" in to)) return fields;
  const classOf = (agent: CeilingAgentRecord) =>
    attendedClass({ provider: agent.provider, modeId: liveModeId(agent) }) ?? "none";
  return {
    ...fields,
    tierBefore: from.tier,
    tierAfter: to.tier,
    classBefore: classOf(before),
    classAfter: classOf(after),
  };
}

function safeAnswerModeChange(
  before: CeilingAgentRecord | null,
  after: CeilingAgentRecord | null,
): Record<string, unknown> {
  try {
    return answerModeChange(before, after);
  } catch {
    return { modeBefore: "unknown", modeAfter: "unknown", modeChanged: false };
  }
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

function logAt(
  logger: Logger,
  level: "info" | "debug",
  fields: Record<string, unknown>,
  message: string,
) {
  try {
    logger[level](boundFields(fields), message);
  } catch {
    // Never let the record replace the operation's outcome.
  }
}

/**
 * Starts one report-only evaluation and captures the calling agent when called. Callers that
 * change state call it before the change, because the caller can be the target; `create_agent`
 * calls it after creation, which does not change the caller. Returns a no-op when there is no
 * calling agent (owner or top-level sessions). Never throws.
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

  async function compare(
    supervisor: CeilingAgentRecord,
    child: CeilingAgentRecord,
    facts: ChildRequestFacts,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = await buildComparison(dependencies, supervisor, child, facts);
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
    return evaluationFields(operation, supervisor, child, decision, favourable, input.asserted, {
      ...(facts.unattended !== undefined ? { requestedUnattended: facts.unattended } : {}),
      ...extra,
    });
  }

  const noted = new Map<string, CeilingAgentRecord | null>();

  function emit(fields: Record<string, unknown>): void {
    if (fields.result === "allowed") logAt(dependencies.logger, "debug", fields, ALLOWED_MESSAGE);
    else logRefusal(dependencies.logger, WOULD_REFUSE_MESSAGE, fields);
  }

  return {
    report: async (targetAgentId, extra = {}) => {
      try {
        const target = dependencies.getAgent(targetAgentId);
        if (!caller || !target) {
          logFailure(dependencies.logger, operation, "record-missing");
          return;
        }
        const child = snapshotRecord(target);
        if (child.id === caller.id) {
          const line = selfChangeLine(operation, caller, child, extra);
          // The next step of a multi-step update compares with this one, not the first.
          caller = child;
          if (line.warn) logRefusal(dependencies.logger, line.message, line.fields);
          else logAt(dependencies.logger, "debug", line.fields, line.message);
          return;
        }
        emit(await compare(caller, child, {}, extra));
      } catch {
        logFailure(dependencies.logger, operation, "error");
      }
    },
    reportRequested: async (target) => {
      try {
        if (!caller) {
          logFailure(dependencies.logger, operation, "record-missing");
          return;
        }
        if ("unresolved" in target) {
          // Missing evidence is reported as unmapped with its reason, never guessed.
          logRefusal(dependencies.logger, WOULD_REFUSE_MESSAGE, {
            code: REPORT_CODE,
            operation,
            callerAgentId: caller.id,
            callerProvider: caller.provider,
            callerMode: liveModeId(caller),
            result: "unmapped",
            classification: "unmapped",
            childUnmapped: `target:unresolved-${target.unresolved}`,
            callerIdentity: "mcp-session-query",
            ...target.extra,
          });
          return;
        }
        emit(await compare(caller, requestedRecord(target), target.facts, target.extra ?? {}));
      } catch {
        logFailure(dependencies.logger, operation, "error");
      }
    },
    noteTarget: (targetAgentId) => {
      try {
        const target = dependencies.getAgent(targetAgentId);
        noted.set(targetAgentId, target ? snapshotRecord(target) : null);
      } catch {
        noted.set(targetAgentId, null);
      }
    },
    reportPermissionAnswer: async (targetAgentId, response) => {
      const before = noted.get(targetAgentId) ?? null;
      noted.delete(targetAgentId);
      // The after-value is the requester's record when this report starts, right after the
      // answer handler returned. A provider that applies a mode change later, after the daemon's
      // state refresh, shows as unchanged here, so modeChanged undercounts rather than guesses.
      let after: CeilingAgentRecord | null = null;
      try {
        const target = dependencies.getAgent(targetAgentId);
        after = target ? snapshotRecord(target) : null;
      } catch {
        after = null;
      }
      const base = {
        code: REPORT_CODE,
        operation,
        callerAgentId,
        targetAgentId,
        behavior: response.behavior === "allow" ? "allow" : "deny",
        // Counts only: persistent rule or mode updates and a provider action choice widen more
        // than one call. Their content is caller text and is not logged.
        permissionUpdates: Array.isArray(response.updatedPermissions)
          ? response.updatedPermissions.length
          : 0,
        selectedAction: typeof response.selectedActionId === "string",
        ...safeAnswerModeChange(before, after),
        callerIdentity: "mcp-session-query",
      };
      try {
        const target = after;
        if (!caller || !target) {
          logAt(
            dependencies.logger,
            "info",
            { ...base, result: "record-missing" },
            PERMISSION_ANSWER_MESSAGE,
          );
          return;
        }
        const fields = await compare(caller, target, {}, {});
        logAt(dependencies.logger, "info", { ...fields, ...base }, PERMISSION_ANSWER_MESSAGE);
      } catch {
        logAt(dependencies.logger, "info", { ...base, result: "error" }, PERMISSION_ANSWER_MESSAGE);
        logFailure(dependencies.logger, operation, "error");
      }
    },
  };
}
