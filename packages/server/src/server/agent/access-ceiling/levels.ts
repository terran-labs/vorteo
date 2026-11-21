/**
 * Supervisor access ceiling: the access table and a pure comparator (#518 slice 1, #528).
 *
 * Answers one question: may an agent (the supervisor) start a child agent with the requested
 * access, given the supervisor's own live access? Nothing calls this yet. Enforcement and
 * report-only wiring are later slices; until then this module changes no behaviour.
 *
 * Three tiers, per the independent security review on PR #535: read-only, attended, unattended.
 * A finer ordering of the attended modes is not defensible as a ceiling, because a child's real
 * access depends on who answers its prompts and on configuration it loads, not on its mode name.
 *
 * Purity: no I/O and no imports from the agent manager or providers. Malformed input returns
 * `refused` with `input:invalid`; it never throws. Unknown values are never allowed: they are
 * refused or reported as unmapped, which callers treat as refused.
 *
 * Trust contract. The daemon-asserted inputs (`DaemonAssertions`: who answers the child's
 * prompts, whether it loads supervisor-writable configuration, whether each mode is authoritative)
 * must be computed by the daemon from its own state. Never take them from `create_agent`
 * arguments, from a request object or from the calling agent. They are a separate parameter so a
 * request cannot be spread into them, and the request types do not carry them. `"owner"` cannot
 * be asserted truthfully until `respond_to_permission` is gated by caller.
 *
 * What this module does NOT know. Callers must supply or enforce each of these:
 * - Who answers the child's permission prompts (`childPromptsAnsweredBy`). Absent means the
 *   supervisor, and then every child mode that can prompt is unattended in effect.
 * - Whether the child's provider loads settings, hooks, allow rules or servers from a directory
 *   the supervisor can write (`childLoadsSupervisorWritableConfig`). Absent means yes, for every
 *   provider: Claude loads user, project and local settings, OpenCode its project config, and
 *   Codex project configuration for trusted projects.
 * - Whether each mode id is authoritative (`supervisorModeAuthoritative`,
 *   `childModeAuthoritative`): the preset was actually applied and no provider option overrides
 *   its boundary (Codex `sandbox_mode`, `approval_policy`, custom config or a governed permission
 *   profile; Claude allowed tools, additional directories, sandbox, settings permissions or extra
 *   arguments). Absent means not authoritative.
 * - Real paths resolved immediately before launch. This module cannot see symlinks and refuses,
 *   rather than resolves, a non-canonical path; the race between resolving and launching is the
 *   caller's.
 * - Gates on later changes. `respond_to_permission`, `set_agent_mode` and `update_agent` accept any
 *   agent id today, and `update_agent` can turn on `auto_accept`; a check at launch bounds none
 *   of them.
 * Also outside this module: credentials and account choice, MCP servers and tools handed to the
 * child, network access, and caller identity (#525).
 */

export type AccessTier = "read-only" | "attended" | "unattended";

const TIER_RANK: Record<AccessTier, number> = { "read-only": 0, attended: 1, unattended: 2 };

interface ModeRow {
  provider: string;
  mode: string;
  /** "unresolved" rows are fail-closed: they report unmapped until a reviewer assigns a tier. */
  tier: AccessTier | "unresolved";
}

const COPILOT_AGENT = "https://agentclientprotocol.com/protocol/session-modes#agent";
const COPILOT_PLAN = "https://agentclientprotocol.com/protocol/session-modes#plan";
const COPILOT_AUTOPILOT = "https://agentclientprotocol.com/protocol/session-modes#autopilot";

/**
 * The permission-mode table, as signed by the security review. Mode ids come from the provider
 * implementations. A row's tier is the mode's nominal boundary; the comparator raises a child to
 * unattended when prompts, configuration or mode authority undercut it.
 */
// prettier-ignore
export const PERMISSION_MODE_TABLE: readonly ModeRow[] = [
  // Claude: Agent SDK permission modes, passed through unchanged (providers/claude/agent.ts).
  { provider: "claude", mode: "plan", tier: "read-only" },               // No edits or commands until someone answers plan exit.
  { provider: "claude", mode: "default", tier: "attended" },             // Prompts before tools.
  { provider: "claude", mode: "acceptEdits", tier: "attended" },         // Edits automatic, commands prompt.
  { provider: "claude", mode: "auto", tier: "attended" },                // A classifier answers prompts; see the machine-reviewed rule.
  { provider: "claude", mode: "bypassPermissions", tier: "unattended" }, // No prompts.
  // Codex: MODE_PRESETS in providers/codex-app-server-agent.ts.
  { provider: "codex", mode: "read-only", tier: "read-only" },           // Runs commands unprompted in a sandbox that reads the whole disk; see codex read-scope rule. Not in the manifest.
  { provider: "codex", mode: "auto", tier: "attended" },                 // workspace-write sandbox; leaving it prompts. See codex read-scope rule.
  { provider: "codex", mode: "auto-review", tier: "attended" },          // Same sandbox; the auto-reviewer answers. See both rules.
  { provider: "codex", mode: "full-access", tier: "unattended" },        // approval never, danger-full-access.
  // Copilot: ACP session modes (providers/copilot-acp-agent.ts).
  { provider: "copilot", mode: COPILOT_PLAN, tier: "unresolved" },       // Enforced by Copilot; not verifiable from our code.
  { provider: "copilot", mode: COPILOT_AGENT, tier: "unresolved" },      // Copilot decides which tools prompt.
  { provider: "copilot", mode: "allow-all", tier: "unattended" },        // Sets Copilot's allow_all: every request approved.
  { provider: "copilot", mode: COPILOT_AUTOPILOT, tier: "unattended" },  // Legacy id; written as allow-all.
  // OpenCode: modes are user-redefinable agents with permissions from the user's OpenCode config.
  { provider: "opencode", mode: "plan", tier: "unresolved" },            // Read-only only in OpenCode's default config.
  { provider: "opencode", mode: "build", tier: "unresolved" },           // Prompting depends on user config.
  { provider: "opencode", mode: "full-access", tier: "unattended" },     // Legacy id; resolves to build with auto_accept on.
  // Oh My Pi: --approval-mode flags (providers/omp/provider-config.ts).
  { provider: "omp", mode: "ask", tier: "attended" },                    // always-ask: write and exec prompt.
  { provider: "omp", mode: "write", tier: "unresolved" },                // "writes require approval"; exec behaviour unverified.
  { provider: "omp", mode: "full", tier: "unattended" },                 // yolo.
];

/**
 * Providers deliberately left out of the table: every mode they have reports unmapped. Pi has
 * no modes; mock providers are development-only. Generic ACP, other ACP wrappers, plugin and
 * custom providers are absent too: their modes are reported at runtime.
 */
export const DELIBERATELY_UNMAPPED_PROVIDERS: readonly string[] = ["pi", "mock", "mock-slow"];

/**
 * Providers whose runtime honours `auto_accept` (opencode-agent.ts and acp-agent.ts). Owner-defined
 * ACP providers can have any id; they have no table rows, so they are unmapped either way.
 */
const AUTO_ACCEPT_PROVIDERS: ReadonlySet<string> = new Set([
  "opencode",
  "copilot",
  "cursor",
  "kimi",
  "kiro",
  "traecli",
  "acp",
]);

type FeatureRule =
  /** Boolean. `true` makes an agent unattended on AUTO_ACCEPT_PROVIDERS. */
  | "unattended-when-true"
  /** Boolean. Only the owner may turn it on: an agent-requested child with `true` is refused. */
  | "owner-only-when-true"
  /** Has no bearing on permissions; any value. */
  | "neutral";

/**
 * Feature ids that bear on access. Any other feature id with a value is unmapped, so a new
 * provider feature cannot widen access silently. Access features must be boolean on both sides;
 * any other value is unmapped. Absent (`undefined` or `null`) values are ignored.
 */
export const FEATURE_TABLE: Readonly<Record<string, FeatureRule>> = {
  auto_accept: "unattended-when-true", // OpenCode and ACP: approves every tool permission prompt.
  chrome: "owner-only-when-true", // Claude and Codex: hands the agent the owner's logged-in browser.
  fast_mode: "neutral", // Claude and OMP: model speed only.
  service_tier: "neutral", // Codex: billing tier only.
  plan_mode: "neutral", // Codex: planning collaboration mode; sandbox and approvals unchanged.
};

export interface AccessEnvironment {
  kind: "host" | "container";
  /** Identifies the environment instance. Absent or empty refuses. */
  id: string;
}

export interface SupervisorAccess {
  provider: string;
  /** Live mode; `null` or `undefined` when the runtime reports none. */
  modeId: string | null | undefined;
  /** Live, effective feature values. */
  featureValues?: Readonly<Record<string, unknown>>;
  environment: AccessEnvironment;
  /** Resolved real path of the supervisor's working directory. */
  directory: string;
}

export type ToolAccessChange = "unchanged" | "set" | "clear";

export interface RequestedChildAccess {
  provider: string;
  /** Resolved mode after inheritance; `null` or `undefined` means the provider default. */
  modeId: string | null | undefined;
  featureValues?: Readonly<Record<string, unknown>>;
  /** The create request's `unattended` flag. */
  unattended?: boolean;
  environment: AccessEnvironment;
  /** Resolved real path of the requested working directory. */
  directory: string;
  /** Whether the request sets or clears tool access. Agents may do neither. */
  toolAccess?: ToolAccessChange;
}

/**
 * Facts only the daemon can establish, from its own state. Never derive these from
 * `create_agent` arguments, a request object or the calling agent. Every absent or unexpected
 * value fails closed.
 */
export interface DaemonAssertions {
  /** True only when the supervisor's mode preset is applied and no provider option overrides it. Otherwise the supervisor is unmapped. */
  supervisorModeAuthoritative?: boolean;
  /** True only when the child's mode preset will be applied and nothing overrides it. Otherwise the child is unattended. */
  childModeAuthoritative?: boolean;
  /**
   * Who answers the child's permission prompts. Anything but "owner" means the supervisor, which
   * makes the child unattended. "owner" cannot be truthful until `respond_to_permission` is
   * gated by caller.
   */
  childPromptsAnsweredBy?: "owner" | "supervisor";
  /** `false` only when the child's provider loads no configuration the supervisor can write. Otherwise the child is unattended. */
  childLoadsSupervisorWritableConfig?: boolean;
}

export interface AccessComparisonOptions {
  /** Resolved real paths of worktrees the daemon creates for this call. */
  daemonCreatedWorktrees?: readonly string[];
  /** Resolved real path every daemon-created worktree must sit under. Required with worktrees. */
  worktreesRoot?: string;
}

export type RefusalReason =
  | "input:invalid"
  | "permission:exceeds-supervisor"
  | "permission:codex-read-scope"
  | "permission:machine-reviewed"
  | "permission:unprompted-writes"
  | "feature:owner-only"
  | "environment:container-to-host"
  | "environment:mismatch"
  | "environment:missing-id"
  | "directory:not-canonical"
  | "directory:root-scope"
  | "directory:worktree-outside-root"
  | "directory:outside-scope"
  | "tool-access:agent-change";

export type UnmappedReason =
  | "permission:provider-unmapped"
  | "permission:mode-absent"
  | "permission:mode-unmapped"
  | "permission:mode-unresolved"
  | "permission:mode-not-authoritative"
  | "feature:unmapped"
  | "feature:invalid-value";

/** Why a child's effective tier is above its mode's tier. */
export type ChildEscalation =
  | "prompts-answered-by-supervisor"
  | "supervisor-writable-config"
  | "mode-not-authoritative"
  | "auto-accept"
  | "unattended-flag";

export type AccessDecision =
  | {
      kind: "allowed";
      supervisorTier: AccessTier;
      childTier: AccessTier;
      childEscalations: ChildEscalation[];
    }
  | { kind: "refused"; reasons: RefusalReason[]; childEscalations: ChildEscalation[] }
  | { kind: "unmapped"; supervisor: UnmappedReason[]; child: UnmappedReason[] }
  /**
   * Owner-confirmed exception: an unattended supervisor may launch a child with no mapping.
   * Distinct from `allowed` so callers can audit it; this module does not decide to apply it.
   * Unreachable for an unmapped or non-authoritative supervisor.
   */
  | { kind: "unmapped-under-unattended-supervisor"; child: UnmappedReason[] };

type Resolved =
  | { tier: AccessTier; escalations: ChildEscalation[] }
  | { unmapped: UnmappedReason[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isValidSubject(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    isOptionalString(value.modeId) &&
    (value.featureValues === undefined || isRecord(value.featureValues)) &&
    isRecord(value.environment) &&
    typeof value.directory === "string"
  );
}

function isValidInput(
  supervisor: unknown,
  child: unknown,
  asserted: unknown,
  options: unknown,
): boolean {
  if (!isValidSubject(supervisor) || !isValidSubject(child) || !isRecord(asserted)) return false;
  if (child.unattended !== undefined && typeof child.unattended !== "boolean") return false;
  if (child.toolAccess !== undefined && typeof child.toolAccess !== "string") return false;
  if (!isRecord(options)) return false;
  const worktrees = options.daemonCreatedWorktrees;
  if (worktrees !== undefined) {
    if (!Array.isArray(worktrees) || !worktrees.every((item) => typeof item === "string"))
      return false;
  }
  return options.worktreesRoot === undefined || typeof options.worktreesRoot === "string";
}

function lookupMode(
  provider: string,
  modeId: string | null | undefined,
): { tier: AccessTier } | { unmapped: UnmappedReason } {
  const rows = PERMISSION_MODE_TABLE.filter((row) => row.provider === provider);
  if (rows.length === 0) return { unmapped: "permission:provider-unmapped" };
  if (modeId === null || modeId === undefined) return { unmapped: "permission:mode-absent" };
  const row = rows.find((candidate) => candidate.mode === modeId);
  if (!row) return { unmapped: "permission:mode-unmapped" };
  if (row.tier === "unresolved") return { unmapped: "permission:mode-unresolved" };
  return { tier: row.tier };
}

function presentFeatures(values: Readonly<Record<string, unknown>> | undefined) {
  return Object.entries(values ?? {}).filter(([, value]) => value !== undefined && value !== null);
}

/** Mode and features, shared by both sides. Returns whether `auto_accept` applies. */
function resolveBase(subject: {
  provider: string;
  modeId: string | null | undefined;
  featureValues?: Readonly<Record<string, unknown>>;
}): { tier: AccessTier; autoAccept: boolean } | { unmapped: UnmappedReason[] } {
  const unmapped: UnmappedReason[] = [];
  const mode = lookupMode(subject.provider, subject.modeId);
  if ("unmapped" in mode) unmapped.push(mode.unmapped);
  let autoAccept = false;
  for (const [id, value] of presentFeatures(subject.featureValues)) {
    const rule = Object.hasOwn(FEATURE_TABLE, id) ? FEATURE_TABLE[id] : undefined;
    if (rule === undefined) {
      if (!unmapped.includes("feature:unmapped")) unmapped.push("feature:unmapped");
    } else if (rule !== "neutral" && typeof value !== "boolean") {
      if (!unmapped.includes("feature:invalid-value")) unmapped.push("feature:invalid-value");
    } else if (rule === "unattended-when-true" && value === true) {
      autoAccept = AUTO_ACCEPT_PROVIDERS.has(subject.provider);
    }
  }
  if (unmapped.length > 0 || "unmapped" in mode) return { unmapped };
  return { tier: autoAccept ? "unattended" : mode.tier, autoAccept };
}

/** The supervisor is credited only for what is certain: never raised, never defaulted. */
export function resolveSupervisorTier(
  supervisor: SupervisorAccess,
  asserted: DaemonAssertions,
): Resolved {
  const base = resolveBase(supervisor);
  const unmapped = "unmapped" in base ? [...base.unmapped] : [];
  if (asserted.supervisorModeAuthoritative !== true)
    unmapped.push("permission:mode-not-authoritative");
  if (unmapped.length > 0 || "unmapped" in base) return { unmapped };
  return { tier: base.tier, escalations: [] };
}

/** The child is charged for everything that could raise it, with the reasons. */
export function resolveChildTier(
  child: RequestedChildAccess,
  asserted: DaemonAssertions,
): Resolved {
  const base = resolveBase(child);
  if ("unmapped" in base) return base;
  const escalations: ChildEscalation[] = [];
  if (base.autoAccept) escalations.push("auto-accept");
  if (child.unattended === true) escalations.push("unattended-flag");
  // Every read-only and attended row can prompt; whoever answers holds the real boundary.
  if (base.tier !== "unattended" && asserted.childPromptsAnsweredBy !== "owner")
    escalations.push("prompts-answered-by-supervisor");
  if (asserted.childLoadsSupervisorWritableConfig !== false)
    escalations.push("supervisor-writable-config");
  if (asserted.childModeAuthoritative !== true) escalations.push("mode-not-authoritative");
  return { tier: escalations.length > 0 ? "unattended" : base.tier, escalations };
}

const CODEX_SANDBOXED_MODES: ReadonlySet<string> = new Set(["read-only", "auto", "auto-review"]);

/**
 * Codex read-scope rule. Codex `read-only`, `auto` and `auto-review` run commands without
 * prompting inside a sandbox that can read the whole disk by default. A non-Codex supervisor
 * below unattended cannot do that, so the child would exceed it. Refused until the owner accepts
 * that read-scope gap; relax here if they do.
 */
function isCodexReadScopeGap(
  supervisor: SupervisorAccess,
  supervisorTier: AccessTier,
  child: RequestedChildAccess,
): boolean {
  return (
    supervisorTier !== "unattended" &&
    supervisor.provider !== "codex" &&
    child.provider === "codex" &&
    typeof child.modeId === "string" &&
    CODEX_SANDBOXED_MODES.has(child.modeId)
  );
}

/** Claude `auto` and Codex `auto-review`: a model, not a person, answers the prompts. */
function isMachineReviewed(subject: { provider: string; modeId: string | null | undefined }) {
  return (
    (subject.provider === "claude" && subject.modeId === "auto") ||
    (subject.provider === "codex" && subject.modeId === "auto-review")
  );
}

/**
 * Machine-reviewed rule. In a machine-reviewed child a classifier answers the prompts, so the
 * owner is not the one gating the child; it would do without the owner what an owner-gated
 * supervisor of the same tier needs the owner for. Refused unless the supervisor is unattended
 * or in the same machine-reviewed mode of the same provider. Same provider only: a Codex
 * `auto-review` supervisor keeps its sandbox behind the classifier, while the Claude classifier
 * has no sandbox behind it. Deliberately conservative; relax here to any machine-reviewed
 * supervisor if the owner accepts that.
 */
function isMachineReviewedGap(
  supervisor: SupervisorAccess,
  supervisorTier: AccessTier,
  child: RequestedChildAccess,
): boolean {
  if (!isMachineReviewed(child) || supervisorTier === "unattended") return false;
  return !(supervisor.provider === child.provider && supervisor.modeId === child.modeId);
}

/** Supervisor modes in which every file write prompts the owner. */
function hasPromptedWrites(subject: { provider: string; modeId: string | null | undefined }) {
  return (
    (subject.provider === "claude" && subject.modeId === "default") ||
    (subject.provider === "omp" && subject.modeId === "ask")
  );
}

/** The signed table's attended classes. */
export type AttendedClass = "owner-gated-writes" | "unprompted-writes" | "machine-reviewed";

/**
 * The attended class of a mode, from the same predicates the refusal rules use, or null for a
 * mode in no class. Additive export for report-only self-change logging (#530); the comparator
 * does not call it.
 */
export function attendedClass(subject: {
  provider: string;
  modeId: string | null | undefined;
}): AttendedClass | null {
  if (hasPromptedWrites(subject)) return "owner-gated-writes";
  if (isMachineReviewed(subject)) return "machine-reviewed";
  if (
    (subject.provider === "claude" && subject.modeId === "acceptEdits") ||
    (subject.provider === "codex" && subject.modeId === "auto")
  )
    return "unprompted-writes";
  return null;
}

/**
 * Unprompted-writes rule. A Claude `acceptEdits` child writes files without asking, in a
 * directory holding Git hooks, package scripts and other agents' configuration that later run
 * unsandboxed. A supervisor whose own writes prompt the owner (Claude `default`, OMP `ask`)
 * cannot do that, so the child is refused unless that supervisor is unattended. A Codex `auto`
 * child under those supervisors is already refused by the Codex read-scope rule, so this rule
 * does not repeat it.
 */
function isUnpromptedWritesGap(
  supervisor: SupervisorAccess,
  supervisorTier: AccessTier,
  child: RequestedChildAccess,
): boolean {
  return (
    supervisorTier !== "unattended" &&
    hasPromptedWrites(supervisor) &&
    child.provider === "claude" &&
    child.modeId === "acceptEdits"
  );
}

/** Canonical absolute POSIX path: no empty, `.` or `..` segments and no trailing slash. */
function isCanonicalPath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0")) return false;
  if (path === "/") return true;
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** True when `path` is `base` or below it. `/a/bc` is not below `/a/b`. */
function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

function directoryRefusal(
  supervisor: SupervisorAccess,
  child: RequestedChildAccess,
  options: AccessComparisonOptions,
): RefusalReason | null {
  const worktrees = options.daemonCreatedWorktrees ?? [];
  const root = options.worktreesRoot;
  const paths = [supervisor.directory, child.directory, ...worktrees];
  if (root !== undefined) paths.push(root);
  if (!paths.every(isCanonicalPath)) return "directory:not-canonical";
  if (supervisor.directory === "/" || worktrees.includes("/") || root === "/")
    return "directory:root-scope";
  if (
    worktrees.some(
      (worktree) => root === undefined || worktree === root || !isWithin(worktree, root),
    )
  )
    return "directory:worktree-outside-root";
  if (isWithin(child.directory, supervisor.directory)) return null;
  if (worktrees.some((worktree) => isWithin(child.directory, worktree))) return null;
  return "directory:outside-scope";
}

function environmentRefusal(supervisor: AccessEnvironment, child: AccessEnvironment) {
  const known = (kind: unknown) => kind === "host" || kind === "container";
  if (!known(supervisor.kind) || !known(child.kind)) return "input:invalid";
  const hasId = (id: unknown) => typeof id === "string" && id.length > 0;
  if (!hasId(supervisor.id) || !hasId(child.id)) return "environment:missing-id";
  if (supervisor.kind === "container" && child.kind === "host")
    return "environment:container-to-host";
  if (supervisor.kind !== child.kind || supervisor.id !== child.id) return "environment:mismatch";
  return null;
}

/** Refusals from the dimensions other than permission tier. */
function scopeRefusals(
  supervisor: SupervisorAccess,
  child: RequestedChildAccess,
  options: AccessComparisonOptions,
): RefusalReason[] {
  const refusals: RefusalReason[] = [];
  const ownerOnlyOn = presentFeatures(child.featureValues).some(
    ([id, value]) => FEATURE_TABLE[id] === "owner-only-when-true" && value !== false,
  );
  if (ownerOnlyOn) refusals.push("feature:owner-only");
  const environment = environmentRefusal(supervisor.environment, child.environment);
  if (environment) refusals.push(environment);
  const directory = directoryRefusal(supervisor, child, options);
  if (directory) refusals.push(directory);
  if (child.toolAccess !== undefined && child.toolAccess !== "unchanged")
    refusals.push("tool-access:agent-change");
  return refusals;
}

/**
 * Compares a supervisor's live access with a requested child. Refusals win over unmapped
 * results, and every refusal found is reported.
 */
export function compareChildAccess(
  supervisor: SupervisorAccess,
  child: RequestedChildAccess,
  asserted: DaemonAssertions = {},
  options: AccessComparisonOptions = {},
): AccessDecision {
  if (!isValidInput(supervisor, child, asserted, options))
    return { kind: "refused", reasons: ["input:invalid"], childEscalations: [] };

  const refusals = scopeRefusals(supervisor, child, options);
  const supervisorTier = resolveSupervisorTier(supervisor, asserted);
  const childTier = resolveChildTier(child, asserted);
  const escalations = "tier" in childTier ? childTier.escalations : [];
  if ("tier" in supervisorTier && "tier" in childTier) {
    if (TIER_RANK[childTier.tier] > TIER_RANK[supervisorTier.tier])
      refusals.push("permission:exceeds-supervisor");
    if (isCodexReadScopeGap(supervisor, supervisorTier.tier, child))
      refusals.push("permission:codex-read-scope");
    if (isMachineReviewedGap(supervisor, supervisorTier.tier, child))
      refusals.push("permission:machine-reviewed");
    if (isUnpromptedWritesGap(supervisor, supervisorTier.tier, child))
      refusals.push("permission:unprompted-writes");
  }
  if (refusals.length > 0)
    return { kind: "refused", reasons: refusals, childEscalations: escalations };

  if ("unmapped" in childTier && "tier" in supervisorTier && supervisorTier.tier === "unattended")
    return { kind: "unmapped-under-unattended-supervisor", child: childTier.unmapped };
  if ("unmapped" in supervisorTier || "unmapped" in childTier) {
    return {
      kind: "unmapped",
      supervisor: "unmapped" in supervisorTier ? supervisorTier.unmapped : [],
      child: "unmapped" in childTier ? childTier.unmapped : [],
    };
  }
  return {
    kind: "allowed",
    supervisorTier: supervisorTier.tier,
    childTier: childTier.tier,
    childEscalations: escalations,
  };
}
