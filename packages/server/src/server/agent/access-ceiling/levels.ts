/**
 * Supervisor access ceiling: the access table and a pure comparator (#518 slice 1, #528).
 *
 * Answers one question: may an agent (the supervisor) start or move a child agent with the
 * requested access, given the supervisor's own live access? Nothing calls this yet. Enforcement
 * and report-only wiring are later slices; until then this module changes no behaviour.
 *
 * Purity: no I/O and no imports from the agent manager or providers. Callers resolve everything
 * that needs the filesystem or runtime state before calling, in particular:
 * - directories must already be resolved real paths (symlinks followed, `.`/`..` removed). This
 *   module cannot see symlinks; a non-canonical path is refused, never resolved here.
 * - the child's mode and feature values must be the resolved create config (after mode
 *   inheritance and the provider's create-config resolution), and the supervisor's must be its
 *   live, effective values.
 *
 * Unknown input is never allowed: an unknown provider, mode, feature, environment or
 * tool-access value is either refused or reported as unmapped, which callers treat as refused.
 *
 * What this does NOT cover (callers and later slices own these): credentials and account choice;
 * provider options that override a mode's boundary (Codex `sandbox_mode`, `approval_policy`
 * and named permission profiles, Claude settings allow lists, OpenCode agent permission config,
 * custom Copilot agent profiles); MCP servers and tools handed to the child; who answers the
 * child's permission prompts (answering Claude's plan-exit prompt moves a `plan` child to
 * `acceptEdits`); mode changes after launch; network access; caller identity (#525).
 */

/** Permission level. A child's level must be less than or equal to its supervisor's. */
export type AccessLevel = 0 | 1 | 2 | 3 | 4;

export const ACCESS_LEVEL_NAMES: Record<AccessLevel, string> = {
  0: "read or plan",
  1: "ask every time",
  2: "edits automatic, commands ask",
  3: "machine-reviewed",
  4: "unattended",
};

interface ModeRow {
  provider: string;
  mode: string;
  /** "unresolved" rows are fail-closed: they report unmapped until a reviewer assigns a level. */
  level: AccessLevel | "unresolved";
  /** Level proposed in #518, kept for the reviewer. Never used by the comparator. */
  proposed?: AccessLevel;
}

const COPILOT_AGENT = "https://agentclientprotocol.com/protocol/session-modes#agent";
const COPILOT_PLAN = "https://agentclientprotocol.com/protocol/session-modes#plan";
const COPILOT_AUTOPILOT = "https://agentclientprotocol.com/protocol/session-modes#autopilot";

/**
 * The permission-mode table. One row per (provider, mode id); ids are taken from the provider
 * implementations, not from the #518 proposal. Each comment says why the row sits where it does.
 */
// prettier-ignore
export const PERMISSION_MODE_TABLE: readonly ModeRow[] = [
  // Claude: Agent SDK permission modes, passed through unchanged (providers/claude/agent.ts).
  { provider: "claude", mode: "plan", level: 0 },              // SDK plan mode: no edits or commands run. Answering plan exit moves it to acceptEdits.
  { provider: "claude", mode: "default", level: 1 },           // SDK default: prompts before each tool needing permission.
  { provider: "claude", mode: "acceptEdits", level: 2 },       // File edits auto-approved; shell commands still prompt. No OS sandbox.
  { provider: "claude", mode: "auto", level: 3 },              // A model classifier answers permission prompts.
  { provider: "claude", mode: "bypassPermissions", level: 4 }, // No prompts at all; manifest marks it isUnattended.
  // Codex: MODE_PRESETS in providers/codex-app-server-agent.ts (approval policy + OS sandbox).
  { provider: "codex", mode: "read-only", level: 0 },          // read-only sandbox, on-request. Runtime preset accepted by setMode; not in the manifest.
  { provider: "codex", mode: "auto", level: 2 },               // workspace-write sandbox, on-request, user reviewer: edits and sandboxed commands run; leaving the sandbox asks.
  { provider: "codex", mode: "auto-review", level: 3 },        // Same sandbox as auto, but escalations go to the auto-review subagent.
  { provider: "codex", mode: "full-access", level: 4 },        // approval never + danger-full-access sandbox; isUnattended.
  // Copilot: ACP session modes (providers/copilot-acp-agent.ts). Copilot enforces agent and plan itself.
  { provider: "copilot", mode: COPILOT_PLAN, level: "unresolved", proposed: 0 },  // Copilot's own plan mode ("creating and executing" plans); read-only is not verifiable from our code.
  { provider: "copilot", mode: COPILOT_AGENT, level: "unresolved", proposed: 2 }, // Copilot decides which tools prompt; whether edits are automatic is not verifiable from our code.
  { provider: "copilot", mode: "allow-all", level: 4 },        // Sets Copilot's allow_all option: every tool, path and URL request approved.
  { provider: "copilot", mode: COPILOT_AUTOPILOT, level: 4 },  // Legacy request id; writeCopilotProviderMode turns it into allow-all.
  // OpenCode: modes are OpenCode agents the user can redefine, with permissions from the user's OpenCode config.
  { provider: "opencode", mode: "plan", level: "unresolved", proposed: 0 },  // Read-only only in OpenCode's default config; users can change it.
  { provider: "opencode", mode: "build", level: "unresolved", proposed: 2 }, // Prompting depends on the user's OpenCode permission config.
  { provider: "opencode", mode: "full-access", level: 4 },     // Legacy request id; resolved to build with auto_accept on.
  // Oh My Pi: --approval-mode flags (providers/omp/provider-config.ts).
  { provider: "omp", mode: "ask", level: 1 },                  // --approval-mode always-ask: write and exec tools prompt.
  { provider: "omp", mode: "write", level: "unresolved", proposed: 2 }, // --approval-mode write: "writes require approval", which contradicts L2; exec behaviour unverified.
  { provider: "omp", mode: "full", level: 4 },                 // --approval-mode yolo; isUnattended.
];

/**
 * Providers deliberately left out of the table: every mode they have reports unmapped. Pi has
 * no modes; mock providers are development-only. Generic ACP, other ACP wrappers (Cursor, Kimi,
 * Kiro), plugin and custom providers are absent too: their modes are reported at runtime.
 */
export const DELIBERATELY_UNMAPPED_PROVIDERS: readonly string[] = ["pi", "mock", "mock-slow"];

type FeatureRule =
  /** A truthy value makes the agent unattended (L4). `false` is neutral. */
  | "unattended-when-on"
  /** Only the owner may turn it on: an agent-requested child with it on is refused. */
  | "owner-only-when-on"
  /** Has no bearing on permissions. */
  | "neutral";

/**
 * Feature ids that bear on access. Any other feature id with a value is unmapped, so a new
 * provider feature cannot widen access silently. Absent (`undefined` or `null`) values are ignored.
 */
export const FEATURE_TABLE: Readonly<Record<string, FeatureRule>> = {
  auto_accept: "unattended-when-on", // OpenCode and every ACP provider: approves each tool permission prompt.
  chrome: "owner-only-when-on", // Claude and Codex: hands the agent the owner's logged-in browser.
  fast_mode: "neutral", // Claude and OMP: model speed only.
  service_tier: "neutral", // Codex: billing tier only.
  plan_mode: "neutral", // Codex: planning collaboration mode; sandbox and approvals unchanged.
};

export type EnvironmentKind = "host" | "container";

export interface AccessEnvironment {
  kind: EnvironmentKind;
  /** Identifies the environment instance, for example a container id. */
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

export interface AccessComparisonOptions {
  /** Resolved real paths of worktrees the daemon creates for this call. */
  daemonCreatedWorktrees?: readonly string[];
}

export type RefusalReason =
  | "permission:exceeds-supervisor"
  | "feature:owner-only"
  | "environment:container-to-host"
  | "environment:mismatch"
  | "environment:unknown"
  | "directory:not-canonical"
  | "directory:outside-scope"
  | "tool-access:agent-change";

export type UnmappedReason =
  | "permission:provider-unmapped"
  | "permission:mode-absent"
  | "permission:mode-unmapped"
  | "permission:mode-unresolved"
  | "feature:unmapped";

export type AccessDecision =
  | { kind: "allowed"; supervisorLevel: AccessLevel; childLevel: AccessLevel }
  | { kind: "refused"; reasons: RefusalReason[] }
  | { kind: "unmapped"; supervisor: UnmappedReason[]; child: UnmappedReason[] }
  /**
   * Owner-confirmed exception: an unattended (L4) supervisor may launch a child with no mapping.
   * Distinct from `allowed` so callers can audit it; this module does not decide to apply it.
   */
  | { kind: "unmapped-under-unattended-supervisor"; child: UnmappedReason[] };

type PermissionResult = { level: AccessLevel } | { unmapped: UnmappedReason[] };

function lookupMode(provider: string, modeId: string | null | undefined): PermissionResult {
  const rows = PERMISSION_MODE_TABLE.filter((row) => row.provider === provider);
  if (rows.length === 0) return { unmapped: ["permission:provider-unmapped"] };
  if (modeId === null || modeId === undefined) return { unmapped: ["permission:mode-absent"] };
  const row = rows.find((candidate) => candidate.mode === modeId);
  if (!row) return { unmapped: ["permission:mode-unmapped"] };
  if (row.level === "unresolved") return { unmapped: ["permission:mode-unresolved"] };
  return { level: row.level };
}

function presentFeatures(values: Readonly<Record<string, unknown>> | undefined) {
  return Object.entries(values ?? {}).filter(([, value]) => value !== undefined && value !== null);
}

/** Effective permission level from mode, features and the unattended flag. */
export function resolvePermissionLevel(subject: {
  provider: string;
  modeId: string | null | undefined;
  featureValues?: Readonly<Record<string, unknown>>;
  unattended?: boolean;
}): PermissionResult {
  const mode = lookupMode(subject.provider, subject.modeId);
  const unmapped = "unmapped" in mode ? [...mode.unmapped] : [];
  let level: AccessLevel = "level" in mode ? mode.level : 0;
  for (const [id, value] of presentFeatures(subject.featureValues)) {
    const rule = Object.hasOwn(FEATURE_TABLE, id) ? FEATURE_TABLE[id] : undefined;
    if (rule === undefined) {
      if (!unmapped.includes("feature:unmapped")) unmapped.push("feature:unmapped");
    } else if (rule === "unattended-when-on" && value !== false) {
      level = 4;
    }
  }
  if (subject.unattended === true) level = 4;
  return unmapped.length > 0 ? { unmapped } : { level };
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
  if (path === base) return true;
  return path.startsWith(base === "/" ? "/" : `${base}/`);
}

function directoryRefusal(
  supervisor: SupervisorAccess,
  child: RequestedChildAccess,
  options: AccessComparisonOptions,
): RefusalReason | null {
  const worktrees = options.daemonCreatedWorktrees ?? [];
  const paths = [supervisor.directory, child.directory, ...worktrees];
  if (!paths.every(isCanonicalPath)) return "directory:not-canonical";
  if (isWithin(child.directory, supervisor.directory)) return null;
  if (worktrees.some((worktree) => isWithin(child.directory, worktree))) return null;
  return "directory:outside-scope";
}

function environmentRefusal(supervisor: AccessEnvironment, child: AccessEnvironment) {
  const known = (kind: unknown) => kind === "host" || kind === "container";
  if (!known(supervisor.kind) || !known(child.kind)) return "environment:unknown";
  if (supervisor.kind === "container" && child.kind === "host")
    return "environment:container-to-host";
  if (supervisor.kind !== child.kind || supervisor.id !== child.id) return "environment:mismatch";
  return null;
}

/**
 * Compares a supervisor's live access with a requested child. Refusals win over unmapped
 * results, and every refusal found is reported.
 */
export function compareChildAccess(
  supervisor: SupervisorAccess,
  child: RequestedChildAccess,
  options: AccessComparisonOptions = {},
): AccessDecision {
  const refusals: RefusalReason[] = [];
  const ownerOnlyOn = presentFeatures(child.featureValues).some(
    ([id, value]) => FEATURE_TABLE[id] === "owner-only-when-on" && value !== false,
  );
  if (ownerOnlyOn) refusals.push("feature:owner-only");
  const environment = environmentRefusal(supervisor.environment, child.environment);
  if (environment) refusals.push(environment);
  const directory = directoryRefusal(supervisor, child, options);
  if (directory) refusals.push(directory);
  if (child.toolAccess !== undefined && child.toolAccess !== "unchanged")
    refusals.push("tool-access:agent-change");

  const supervisorLevel = resolvePermissionLevel(supervisor);
  const childLevel = resolvePermissionLevel(child);
  if ("level" in supervisorLevel && "level" in childLevel) {
    if (childLevel.level > supervisorLevel.level) refusals.push("permission:exceeds-supervisor");
  }
  if (refusals.length > 0) return { kind: "refused", reasons: refusals };

  if ("unmapped" in childLevel && "level" in supervisorLevel && supervisorLevel.level === 4) {
    return { kind: "unmapped-under-unattended-supervisor", child: childLevel.unmapped };
  }
  if ("unmapped" in supervisorLevel || "unmapped" in childLevel) {
    return {
      kind: "unmapped",
      supervisor: "unmapped" in supervisorLevel ? supervisorLevel.unmapped : [],
      child: "unmapped" in childLevel ? childLevel.unmapped : [],
    };
  }
  return { kind: "allowed", supervisorLevel: supervisorLevel.level, childLevel: childLevel.level };
}
