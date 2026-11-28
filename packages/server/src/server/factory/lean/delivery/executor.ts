/**
 * Deterministic delivery: a persisted daemon state machine that runs a project's release recipe
 * from the accepted commit and writes its own receipts. No agent session is held at any point,
 * including while a tracked lifecycle request waits for approval.
 *
 * A run executes an ordered plan of steps, each with its own receipt:
 *   prepare:<where>  the daemon-owned delivery checkout, detached at the commit to run
 *   install:<where>  the recipe's dependency install, only when its lockfile changed
 *   version          the recipe's version report, for a beta whose tag needs it
 *   number           the recipe's release number report, when the caller gave none
 *   gate:<name>      the recipe's gates for the run's tier; a failure stops the run
 *   milestone        a local tag on the beta's commit, when the recipe names a prefix
 *   deploy           the deploy step, bracketed by default-branch heads
 *   branch           every commit that landed during the deploy must touch only release records
 *   verify           the verify step's report decides success, never the deploy's exit code
 *   records          Factory's own fast-forward commit of the rows the release tools appended
 *
 * Safety rules this module keeps:
 * - A step that has a receipt is never launched again. A side effect whose launch was recorded
 *   but whose outcome was lost becomes `unknown`; only an explicit owner `resolve` moves it on,
 *   so a deploy or a push is never repeated automatically.
 * - The "started" receipt is written atomically immediately before the process starts or the
 *   push happens, through the adapter's or checkout's authorize callback.
 * - Release values reach commands only as VORTEO_RELEASE_* environment variables. Commands are
 *   static recipe text from the accepted commit; legacy `{version}` placeholders are refused.
 * - Host steps run only when the accepted commit's recipe names them `where: "host"` and the
 *   merge gate's record shows intake trust, the review verdict and the owner-only file gate all
 *   passed for exactly the commit the checkout holds. A missing record refuses.
 * - Raw step output never enters the ledger. Receipts carry a digest and the path of the
 *   adapter's bounded output tail. Only the small JSON reports are kept.
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { FactoryReleaseEvent, ReleaseRecipeV1 } from "@getpaseo/server/factory-lean";
import type {
  DeliveryJob,
  DeliveryLock,
  DeliveryReceipt,
  LeanLedger,
  LeanStateStore,
  OwnerApproval,
} from "../types.js";

export const RELEASE_ENV = {
  version: "VORTEO_RELEASE_VERSION",
  commit: "VORTEO_RELEASE_COMMIT",
  artifact: "VORTEO_RELEASE_ARTIFACT",
  previousVersion: "VORTEO_RELEASE_PREVIOUS_VERSION",
  targetVersion: "VORTEO_RELEASE_TARGET_VERSION",
  number: "VORTEO_RELEASE_NUMBER",
  note: "VORTEO_RELEASE_NOTE",
  notes: "VORTEO_RELEASE_NOTES",
  target: "VORTEO_RELEASE_TARGET",
  approval: "VORTEO_RELEASE_APPROVAL",
} as const;
export type ReleaseValueName = keyof typeof RELEASE_ENV;
export type ReleaseValues = Record<ReleaseValueName, string | null>;
const RELEASE_VALUE_NAMES: readonly ReleaseValueName[] = [
  "version",
  "commit",
  "artifact",
  "previousVersion",
  "targetVersion",
  "number",
  "note",
  "notes",
  "target",
  "approval",
];

export type StepWhere = "container" | "host";
const WHERES: readonly StepWhere[] = ["host", "container"];
export type DeliveryRunKind = "beta" | "promote" | "rollback";
export type DeliveryRunState =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "verifying"
  | "delivered"
  | "failed";
/** See the plan in the module comment. */
export type StepKey = string;
export type GateTier = "beta" | "stable";

export interface StepReceipt {
  key: StepKey;
  attempt: number;
  where: StepWhere | "lifecycle" | "check" | "git";
  status: "started" | "succeeded" | "failed" | "unknown";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  /** The process the adapter started; never signalled by Factory. */
  pid: number | null;
  laneEpoch: number;
  /** sha256 of the output tail the adapter returned. */
  outputDigest: string | null;
  /** The private log file holding a bounded tail of the output. */
  log: string | null;
  lifecycleRequest: string | null;
  /** A short fact the step settled: the prepared head, a lockfile blob, a tag name. */
  detail: string | null;
}

export interface DeliveryFailure {
  kind: "step-failed" | "unknown" | "refused" | "cancelled";
  /** A sentence the owner can act on. */
  reason: string;
  at: string;
}

/** What the verify step printed as its last line, validated against the run. */
export interface ReleaseReport {
  version: string;
  commit: string | null;
  artifact: string | null;
}

export interface OwnerResolution {
  action: ResolveAction;
  ownerAction: string;
  at: string;
}

export interface PlannedGate {
  name: string;
  tier: GateTier;
}

export interface BranchCommit {
  sha: string;
  paths: string[];
}

/** Default-branch heads around the deploy, and every commit that landed in between. */
export interface BranchWindow {
  before: string;
  after: string | null;
  commits: BranchCommit[];
}

export interface RecordsCommit {
  commit: string;
  parent: string;
  paths: string[];
}

export interface DeliveryRun {
  id: string;
  /** Queue order; the oldest unfinished run goes first. */
  seq: number;
  kind: DeliveryRunKind;
  state: DeliveryRunState;
  /** The accepted commit. The recipe is always read from this commit. */
  commit: string;
  values: ReleaseValues;
  contents: FactoryReleaseEvent["contents"];
  /** The recipe's gates for this run's tier, fixed when the run was queued. */
  gates: PlannedGate[];
  /** Notes supplied by the caller; null uses the batch's merged pull request titles. */
  notes: string | null;
  /** The beta being promoted, or the release being restored. */
  releaseEventId: string | null;
  approval: OwnerApproval | null;
  queuedAt: string;
  notBefore: string | null;
  noticeSentAt: string | null;
  /** Current receipts by step key, in execution order. */
  receipts: Record<StepKey, StepReceipt>;
  /** Receipts replaced by an owner resolution, oldest first. */
  history: StepReceipt[];
  /** Set by a verify-only resolution: an unknown deploy may be proven by verification. */
  acceptUnknownDeploy: boolean;
  branch: BranchWindow | null;
  records: RecordsCommit | null;
  report: ReleaseReport | null;
  failure: DeliveryFailure | null;
  resolutions: OwnerResolution[];
  /** Why the run is not moving, for the owner. */
  waitingOn: string | null;
  finishedAt: string | null;
}

/** The ledger with this module's records, until `delivery.runs` lands in types.ts. */
/** The receipt fields the spine is adding to types.ts; kept local until they land there. */
export interface DeliveredReceipt extends DeliveryReceipt {
  branch?: { before: string; after: string; commits: BranchCommit[] };
  records?: RecordsCommit | null;
}

export interface DeliveryLedger extends LeanLedger {
  delivery: Omit<LeanLedger["delivery"], "receipts"> & {
    receipts: DeliveredReceipt[];
    runs?: Record<string, DeliveryRun>;
    /** Last successful install per checkout: `<where>:<path>` to the lockfile blob. */
    installs?: Record<string, string>;
  };
}
type ReleaseHistory = Pick<LeanLedger, "releases">;

export interface StepOutput {
  exitCode: number;
  /** A bounded tail of the output; the adapter keeps the same tail in `outputPath`. */
  stdout: string;
}

/** Nothing was started: the adapter refused before launch, for this reason. */
export interface StepNotStarted {
  notStarted: string;
}

export interface DeliveryStepRequest {
  /** The commit the checkout must hold: the accepted commit, or the head prepare moved it to. */
  commit: string;
  /** Tracked files the release tools themselves write (`release.records`); changes elsewhere refuse. */
  records: string[];
  /** Recipe text, run as `/bin/sh -c <command>`. Never contains release values. */
  command: string;
  /** The only channel for release values. Merged over the adapter's own minimal environment. */
  env: Record<string, string>;
  timeoutMs: number;
  /** The recipe marked the step heavy; adapters route it through the machine's heavy queue. */
  heavy: boolean;
  /** Daemon-private file for the output; the adapter leaves only a bounded tail in it. */
  outputPath: string;
  /** Call immediately before starting the process; start nothing when it returns false. */
  authorizeLaunch(): Promise<boolean>;
  /** Call once with the started process id, before waiting for it to exit. */
  onSpawned(pid: number): Promise<void>;
}

export interface DeliveryStepAdapter {
  /** Null when the outcome is unknown: the process may or may not have run to completion. */
  run(input: DeliveryStepRequest): Promise<StepOutput | StepNotStarted | null>;
}

export interface RecordsCommitRequest {
  /** The checkout head the release tools appended rows on. */
  base: string;
  /** The verified default-branch head the commit is built on and pushed against. */
  expectedHead: string;
  records: readonly string[];
  /** Fixed: names the release version and the run. */
  message: string;
  /** Called with the built commit immediately before the push; push nothing when false. */
  authorizePush(input: { commit: string; parent: string; expectedHead: string }): Promise<boolean>;
}

/** The daemon-owned delivery checkout for one place. Nobody else moves it. */
export interface DeliveryCheckoutPort {
  /** Must equal the accepted commit's `release.checkout` for the Host. */
  readonly path: string;
  /** Creates the worktree on first use, fetches, and detaches at `commit`. */
  prepare(input: {
    commit: string;
    records: readonly string[];
  }): Promise<{ head: string } | StepNotStarted>;
  /** The blob id of a tracked file at the checkout's head, or null when absent. */
  blob(file: string): Promise<string | null>;
  /** A local tag at the head; refuses one naming another commit. Never pushes. */
  tag(name: string): Promise<{ tagged: true } | StepNotStarted>;
  /**
   * Null when no record changed; `withheld` when authorizePush said no and nothing was pushed.
   * A commit pushed before a restart is found by its message and paths and returned again.
   */
  commitRecords(request: RecordsCommitRequest): Promise<RecordsCommitResult>;
}

export type RecordsCommitResult = RecordsCommit | { refused: string } | { withheld: true } | null;

/** Verified default-branch facts from the daemon's GitHub client; never a runner's word. */
export interface BranchEvidencePort {
  head(): Promise<string>;
  /** First-parent commits after `from` through `to`, oldest first; null when not provable. */
  firstParent(from: string, to: string): Promise<BranchCommit[] | null>;
}

export interface HostGateCheck {
  passed: boolean;
  sha: string;
}
/** The merge gate's record for one commit; for a batch, every merge since the last delivery. */
export interface HostGateRecord {
  commit: string;
  trust: HostGateCheck;
  verdict: HostGateCheck;
  ownerOnly: HostGateCheck;
  /** The merge gate's own sentence when a check did not pass. */
  reason?: string;
}

export type LifecycleStatus =
  | { kind: "pending" }
  | { kind: "completed" }
  | { kind: "refused"; reason: string };

export interface LifecycleRequest {
  runId: string;
  commit: string;
  env: Record<string, string>;
}

/** The tracked installation workflow; approval happens there, never in the executor. */
export interface LifecyclePort {
  request(input: LifecycleRequest): Promise<string>;
  status(requestId: string): Promise<LifecycleStatus>;
}

/** A recipe gate naming a GitHub check that must pass on the commit. */
export interface CheckPort {
  result(commit: string, name: string): Promise<"pass" | "fail" | "pending">;
}

export interface SideEffect {
  runId: string;
  kind: "deploy" | "records-push";
  expectedHead: string | null;
}

export interface BetaNotice {
  kind: "beta-notice";
  runId: string;
  commit: string;
  notBefore: string;
}

export interface RecipeAtCommit {
  recipe: ReleaseRecipeV1 | null;
  error: string | null;
}

export interface DeliveryExecutorDeps {
  projectId: string;
  installation: string;
  state: LeanStateStore;
  adapters: Partial<Record<StepWhere, DeliveryStepAdapter>>;
  /** Places with a daemon-owned delivery checkout; others only verify the adapter's checkout. */
  deliveryCheckouts: Partial<Record<StepWhere, DeliveryCheckoutPort>>;
  branch: BranchEvidencePort;
  lifecycle: LifecyclePort | null;
  checks: CheckPort | null;
  /** The recipe in `.github/vorteo-factory.json` at exactly this commit. */
  recipeAt(commit: string): Promise<RecipeAtCommit>;
  hostGate(commit: string): Promise<HostGateRecord | null>;
  /** The delivery lane epoch this installation holds now, or null. */
  fence(): Promise<number | null>;
  /** A last live check by the composition right before a deploy or a push; false blocks it. */
  authorizeSideEffect(effect: SideEffect): Promise<boolean>;
  /** "Needs you": tells the owner a beta is about to ship. */
  notify(notice: BetaNotice): Promise<void>;
  /** Private, outside Git, such as `$PASEO_HOME/factory/lean/delivery-logs`. */
  logDir: string;
  stepTimeoutMs: number;
  now(): Date;
}

export interface BetaInput {
  commit: string;
  /** Null lets the recipe's `releaseNumber` step report it. */
  number: string | null;
  note: string | null;
  contents: FactoryReleaseEvent["contents"];
}

export interface PromoteInput {
  eventId: string;
  expectedProduction: string | null;
  approval: OwnerApproval | null;
  number: string | null;
  note: string | null;
}

export interface RollbackInput {
  targetEventId: string;
  expectedProduction: string;
  approval: OwnerApproval | null;
  /** The recipe's name for the target release, such as Mira's `release-63`. */
  target: string;
}

export interface Queued {
  runId: string;
  /** The run this one waits behind, with the sentence shown to the owner. */
  behind: string | null;
  waitingOn: string | null;
  /** Pending betas this request cancelled. */
  cancelled: string[];
}
export interface Refused {
  refused: string;
}

export type ResolveAction = "verify-only" | "rerun" | "abandon";

export interface DeliverySnapshot {
  /** A beta in its notice window; `hold` cancels it. */
  pendingBeta: DeliveryRun | null;
  /** The run holding the delivery lock now. */
  active: DeliveryRun | null;
  /** A run whose step outcome is unknown; nothing ships until the owner resolves it. */
  needsOwner: DeliveryRun | null;
  /** Every unfinished run, oldest first. */
  queued: DeliveryRun[];
}

interface StepCompletion {
  runId: string;
  key: StepKey;
  attempt: number;
  startedAt: string;
  output: StepOutput | null;
}

interface RecipeRead {
  recipe: ReleaseRecipeV1;
  extras: RecipeExtras;
}

type ResolvedStep =
  | { kind: "command"; command: string; where: StepWhere; heavy: boolean }
  | { kind: "check"; name: string }
  | { kind: "lifecycle" }
  | { kind: "refused"; reason: string };

export const DEFAULT_NOTICE_MINUTES = 10;
const PLACEHOLDER = /\{(version|commit|artifact|previousVersion|targetVersion)\}/u;
const SHA = /^[0-9a-f]{40}$/u;
const SETTINGS_FILE = ".github/vorteo-factory.json";
const STEPS = {
  beta: { deploy: "deployBeta", verify: "verifyBeta" },
  promote: { deploy: "promote", verify: "verifyStable" },
  rollback: { deploy: "rollback", verify: "verifyStable" },
} as const;
const JOB_KIND = { beta: "cut-beta", promote: "promote", rollback: "rollback" } as const;
const CHANNEL = { beta: "beta", promote: "stable", rollback: "stable" } as const;
const GATE_TIER = { beta: "beta", promote: "stable", rollback: null } as const;
const GATE_RESULT = { succeeded: "pass", failed: "fail" } as const;

function hasDotSegment(file: string): boolean {
  return file.split("/").some((segment) => segment === "." || segment === "..");
}

const RepoPathSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u)
  .refine((file) => !hasDotSegment(file) && !file.startsWith(".github/"));
const RecordPathSchema = RepoPathSchema.refine(
  (file) => file.endsWith(".tsv") && file !== SETTINGS_FILE,
);
const CommandStepSchema = z.looseObject({
  run: z.string().min(1),
  where: z.enum(["container", "host"]).optional(),
  heavy: z.boolean().optional(),
});
const InstallStepSchema = CommandStepSchema.extend({ lockfile: RepoPathSchema });
/** The delivery fields beyond the shared recipe contract; validated here before any use. */
const RecipeExtrasSchema = z.looseObject({
  checkout: z
    .string()
    .regex(/^\/(?:[^/]+\/)*[^/]+$/u)
    .refine((dir) => !hasDotSegment(dir.slice(1)) && !dir.includes("\u0000"))
    .optional(),
  records: z.array(RecordPathSchema).optional(),
  milestoneTag: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
    .optional(),
  version: CommandStepSchema.optional(),
  steps: z.looseObject({
    releaseNumber: CommandStepSchema.optional(),
    install: z.array(InstallStepSchema).optional(),
  }),
  channels: z.looseObject({
    beta: z.looseObject({ noticeMinutes: z.number().nonnegative().optional() }),
  }),
});
type RecipeExtras = z.infer<typeof RecipeExtrasSchema>;
const ReportSchema = z.object({
  version: z.string().min(1),
  commit: z.string().nullable(),
  artifact: z.string().nullable(),
});
const NumberReportSchema = z.object({ number: z.string().regex(/^[0-9]+$/u) });
const VersionLineSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

function isFinished(run: DeliveryRun): boolean {
  return run.state === "delivered" || run.state === "failed";
}

function runsOf(ledger: DeliveryLedger): Record<string, DeliveryRun> {
  ledger.delivery.runs ??= {};
  return ledger.delivery.runs;
}

function unfinished(ledger: DeliveryLedger): DeliveryRun[] {
  const runs = Object.values(ledger.delivery.runs ?? {});
  return runs.filter((run) => !isFinished(run)).sort((a, b) => a.seq - b.seq);
}

function production(ledger: ReleaseHistory): FactoryReleaseEvent | null {
  const stable = ledger.releases.filter((e) => e.kind === "promote" || e.kind === "rollback");
  return stable.at(-1) ?? null;
}

function emptyValues(commit: string): ReleaseValues {
  return {
    version: null,
    commit,
    artifact: null,
    previousVersion: null,
    targetVersion: null,
    number: null,
    note: null,
    notes: null,
    target: null,
    approval: null,
  };
}

function gatePlan(recipe: ReleaseRecipeV1, kind: DeliveryRunKind): PlannedGate[] {
  const tier = GATE_TIER[kind];
  if (tier === null) return [];
  return recipe.gates[tier].map((gate) => ({ name: gate.name, tier }));
}

function installsOf(extras: RecipeExtras): z.infer<typeof InstallStepSchema>[] {
  return extras.steps.install ?? [];
}

function wantsVersion(run: DeliveryRun, extras: RecipeExtras): boolean {
  const tagged = run.kind === "beta" && extras.milestoneTag !== undefined;
  return (
    tagged &&
    extras.version !== undefined &&
    (run.values.version === null || !!run.receipts.version)
  );
}

function wantsNumber(run: DeliveryRun, extras: RecipeExtras): boolean {
  const declared = run.kind !== "rollback" && extras.steps.releaseNumber !== undefined;
  return declared && (run.values.number === null || !!run.receipts.number);
}

/** Steps before verification, in order. Verification follows once every one succeeded. */
function planOf(run: DeliveryRun, read: RecipeRead, places: readonly StepWhere[]): StepKey[] {
  const { extras } = read;
  const keys: StepKey[] = places.map((where) => `prepare:${where}`);
  for (const install of installsOf(extras)) keys.push(`install:${install.where ?? "container"}`);
  if (wantsVersion(run, extras)) keys.push("version");
  if (wantsNumber(run, extras)) keys.push("number");
  for (const gate of run.gates) keys.push(`gate:${gate.name}`);
  if (run.kind === "beta" && extras.milestoneTag !== undefined) keys.push("milestone");
  keys.push("deploy", "branch");
  return keys;
}

function defaultNotes(contents: FactoryReleaseEvent["contents"]): string {
  if (contents.length === 0) return "No merged pull requests are recorded for this release.";
  return contents.map((item) => `- ${item.title} (#${item.pr})`).join("\n");
}

function launchValues(run: DeliveryRun): ReleaseValues {
  const notes = run.notes ?? defaultNotes(run.contents);
  const firstLine = (run.contents[0]?.title ?? notes.split("\n")[0] ?? "").slice(0, 120);
  return { ...run.values, notes, note: run.values.note ?? firstLine };
}

function releaseEnv(values: ReleaseValues): Record<string, string> | Refused {
  const env: Record<string, string> = {};
  for (const name of RELEASE_VALUE_NAMES) {
    const value = values[name];
    if (value === null) continue;
    if (value.includes("\0")) return { refused: `The release ${name} contains a NUL byte.` };
    env[RELEASE_ENV[name]] = value;
  }
  return env;
}

function commandStep(step: unknown, label: string): ResolvedStep {
  const parsed = CommandStepSchema.safeParse(step);
  if (!parsed.success) return { kind: "refused", reason: `The recipe has no runnable ${label}.` };
  if (PLACEHOLDER.test(parsed.data.run)) {
    return {
      kind: "refused",
      reason: `The ${label} uses {placeholders}; use the VORTEO_RELEASE_* variables instead.`,
    };
  }
  return {
    kind: "command",
    command: parsed.data.run,
    where: parsed.data.where ?? "container",
    heavy: parsed.data.heavy ?? false,
  };
}

function resolveStep(read: RecipeRead, run: DeliveryRun, key: StepKey): ResolvedStep {
  const { recipe, extras } = read;
  if (key === "number") return commandStep(extras.steps.releaseNumber, "releaseNumber step");
  if (key === "version") return commandStep(extras.version, "version step");
  if (key.startsWith("install:")) {
    const where = key.slice("install:".length);
    const install = installsOf(extras).find((step) => (step.where ?? "container") === where);
    return commandStep(install, `install step for ${where}`);
  }
  if (key.startsWith("gate:")) {
    const name = key.slice("gate:".length);
    const tier = GATE_TIER[run.kind];
    const gate = tier ? recipe.gates[tier].find((g) => g.name === name) : undefined;
    if (!gate) return { kind: "refused", reason: `The recipe no longer names the gate ${name}.` };
    if (gate.check && !gate.run) return { kind: "check", name: gate.check };
    return commandStep(gate, `gate ${name}`);
  }
  const name = key === "deploy" ? STEPS[run.kind].deploy : STEPS[run.kind].verify;
  const step: unknown = recipe.steps[name];
  if (z.looseObject({ lifecycle: z.literal("host-source-update") }).safeParse(step).success) {
    if (key === "verify") return { kind: "refused", reason: `${name} cannot be a lifecycle.` };
    return { kind: "lifecycle" };
  }
  return commandStep(step, `${name} step`);
}

/** Every place a command step of this run executes, Host first. */
function placesOf(read: RecipeRead, run: DeliveryRun): StepWhere[] {
  const keys: StepKey[] = ["number", "version", "deploy", "verify"];
  for (const gate of run.gates) keys.push(`gate:${gate.name}`);
  for (const install of installsOf(read.extras))
    keys.push(`install:${install.where ?? "container"}`);
  const used = new Set<StepWhere>();
  for (const key of keys) {
    const step = resolveStep(read, run, key);
    if (step.kind === "command") used.add(step.where);
  }
  return WHERES.filter((where) => used.has(where));
}

function hostGateRefusal(record: HostGateRecord | null, commit: string): string | null {
  if (record === null || record.commit !== commit) {
    return "Factory has no merge gate record for this commit, so it will not run a Host step.";
  }
  const checks = [
    ["intake trust", record.trust],
    ["review verdict", record.verdict],
    ["owner-only file gate", record.ownerOnly],
  ] as const;
  for (const [label, check] of checks) {
    if (!check.passed || check.sha !== commit) {
      return (
        record.reason ??
        `The ${label} did not pass for this exact commit, so the Host step is refused.`
      );
    }
  }
  return null;
}

const NO_APPROVAL = "This needs the owner's own approval of that exact release.";

function approvalRefusal(approval: OwnerApproval, event: FactoryReleaseEvent): string | null {
  const wordless = approval.words.trim() === "";
  if (approval.eventId !== event.id || approval.version !== event.version || wordless) {
    return `The owner's approval does not name ${event.version}; approve that exact release.`;
  }
  return null;
}

/** Promote and rollback re-check the owner's approval against the release at every launch. */
function recordedApprovalRefusal(run: DeliveryRun, ledger: ReleaseHistory): string | null {
  if (run.releaseEventId === null) return null;
  const event = ledger.releases.find((e) => e.id === run.releaseEventId);
  if (!event) return "The release this run acts on is no longer recorded.";
  return run.approval ? approvalRefusal(run.approval, event) : NO_APPROVAL;
}

function lastLine(stdout: string): string {
  return stdout.trim().split("\n").at(-1)?.trim() ?? "";
}

function lastJsonLine(stdout: string): unknown {
  try {
    return JSON.parse(lastLine(stdout));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function reportRefusal(
  run: DeliveryRun,
  report: ReleaseReport,
  ledger: ReleaseHistory,
): string | null {
  if (run.kind === "beta") {
    if (report.commit !== run.commit) {
      return `The beta record names commit ${report.commit ?? "none"}, not the accepted ${run.commit}.`;
    }
    const known = ledger.releases.some((e) => e.kind === "beta" && e.version === report.version);
    if (known) return `Beta ${report.version} was already recorded; this run shipped nothing new.`;
    return null;
  }
  const expected = run.kind === "promote" ? run.values.version : run.values.targetVersion;
  if (report.version !== expected || report.artifact !== run.values.artifact) {
    return `Production reports ${report.version}, not ${expected ?? "the expected release"}.`;
  }
  return null;
}

/** Commits that landed during the deploy may only change release records. */
function branchRefusal(commits: BranchCommit[], records: readonly string[]): string | null {
  const foreign = commits
    .map((commit) => ({
      sha: commit.sha,
      outside: commit.paths.filter((p) => !records.includes(p)),
    }))
    .filter((commit) => commit.outside.length > 0);
  if (foreign.length === 0) return null;
  const listed = foreign.map((c) => `${c.sha} (${c.outside.join(", ")})`).join("; ");
  return `The default branch moved during the deploy with changes outside the release records: ${listed}.`;
}

function gateResults(run: DeliveryRun): FactoryReleaseEvent["gates"] {
  return run.gates.map((gate) => {
    const status = run.receipts[`gate:${gate.name}`]?.status;
    const result = status === "succeeded" || status === "failed" ? GATE_RESULT[status] : "not-run";
    return { name: gate.name, tier: gate.tier, result, evidenceUrl: null };
  });
}

function releaseEvent(run: DeliveryRun, report: ReleaseReport, at: string): FactoryReleaseEvent {
  const event: FactoryReleaseEvent = {
    id: run.id,
    kind: run.kind,
    version: report.version,
    channel: CHANNEL[run.kind],
    commit: run.commit,
    artifact: run.kind === "beta" ? report.artifact : run.values.artifact,
    at,
    by: { runner: null, ownerAction: run.approval?.actionId ?? null },
    contents: run.contents,
    gates: gateResults(run),
  };
  if (run.kind === "rollback") {
    const fromVersion = run.values.previousVersion ?? "unknown";
    event.rollbackOf = { fromVersion, toVersion: report.version };
  }
  return event;
}

/** A failed beta is its own release event, so the beta trigger sees that the last beta failed. */
function failedBetaEvent(run: DeliveryRun, at: string): FactoryReleaseEvent {
  return {
    id: `${run.id}:failed:${run.resolutions.length}`,
    kind: "failed",
    version: run.report?.version ?? run.values.version ?? "unversioned",
    channel: "beta",
    commit: run.commit,
    artifact: run.report?.artifact ?? null,
    at,
    by: { runner: null, ownerAction: null },
    contents: run.contents,
    gates: gateResults(run),
  };
}

function lockFor(
  run: DeliveryRun,
  installation: string,
  epoch: number,
  now: Date,
  ttlMs: number,
): DeliveryLock {
  const job: DeliveryJob = {
    id: run.id,
    kind: JOB_KIND[run.kind],
    commits: [run.commit],
    releaseEventId: run.releaseEventId,
    ownerAction: run.approval?.actionId ?? null,
  };
  return {
    holder: { kind: "executor", installation },
    job,
    laneEpoch: epoch,
    takenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

function failRun(ledger: DeliveryLedger, run: DeliveryRun, failure: DeliveryFailure): void {
  run.state = "failed";
  run.failure = failure;
  run.finishedAt = failure.at;
  run.waitingOn = null;
  // An unknown outcome keeps the lock: the process may still be running on the target.
  const keepsLock = failure.kind === "unknown";
  if (!keepsLock && ledger.delivery.lock?.job.id === run.id) ledger.delivery.lock = null;
  // A beta that verified is live even if its records commit failed; that is not a failed beta.
  const verified = run.receipts.verify?.status === "succeeded";
  const finalBetaFailure = failure.kind === "step-failed" || failure.kind === "refused";
  if (run.kind === "beta" && finalBetaFailure && !verified) {
    ledger.releases.push(failedBetaEvent(run, failure.at));
  }
}

function cancelPendingBetas(ledger: DeliveryLedger, reason: string, at: string): string[] {
  const cancelled: string[] = [];
  for (const run of unfinished(ledger)) {
    const notStarted = Object.keys(run.receipts).length === 0;
    if (run.kind !== "beta" || run.state !== "pending" || !notStarted) continue;
    failRun(ledger, run, { kind: "cancelled", reason, at });
    cancelled.push(run.id);
  }
  return cancelled;
}

/**
 * The owner's project pause, inside the caller's own state mutation: cancels every beta that has
 * not deployed and has no step in flight, and releases its lock. Whichever write lands first wins
 * against a racing launch, because launches record their receipt in the same serialized state.
 */
export function cancelUnstartedBetas(
  ledger: DeliveryLedger,
  input: { reason: string; at: string },
): string[] {
  const cancelled: string[] = [];
  for (const run of unfinished(ledger)) {
    const receipts = Object.values(run.receipts);
    const inFlight = receipts.some((receipt) => receipt.status === "started");
    const quiet = run.state === "pending" || run.state === "running";
    if (run.kind !== "beta" || !quiet || run.receipts.deploy || inFlight) continue;
    failRun(ledger, run, { kind: "cancelled", reason: input.reason, at: input.at });
    cancelled.push(run.id);
  }
  return cancelled;
}

function logName(runId: string, key: StepKey, attempt: number): string {
  return `${runId}-${key.replace(/[^A-Za-z0-9._-]/gu, "_")}-${attempt}.log`;
}

export function createDeliveryExecutor(deps: DeliveryExecutorDeps) {
  const { projectId, state } = deps;
  let inFlight: Promise<void> | null = null;

  function mutate<T>(change: (ledger: DeliveryLedger) => T): Promise<T> {
    return state.mutate(projectId, change);
  }

  function nowIso(): string {
    return deps.now().toISOString();
  }

  async function readRecipe(commit: string): Promise<RecipeRead | Refused> {
    const { recipe, error } = await deps.recipeAt(commit);
    if (recipe === null) return { refused: error ?? "The accepted commit has no release recipe." };
    const extras = RecipeExtrasSchema.safeParse(recipe);
    if (!extras.success) {
      return {
        refused: "The release recipe's checkout, records, tag or install settings are invalid.",
      };
    }
    const host = deps.deliveryCheckouts.host;
    const { checkout, records } = extras.data;
    if (checkout !== undefined && checkout !== host?.path) {
      return { refused: `This installation has no delivery checkout at ${checkout}.` };
    }
    if ((records?.length ?? 0) > 0 && checkout === undefined) {
      return { refused: "Release records need a Factory delivery checkout (release.checkout)." };
    }
    return { recipe, extras: extras.data };
  }

  function enqueue(
    ledger: DeliveryLedger,
    run: Omit<DeliveryRun, "seq" | "id">,
    cancelled: string[],
  ): Queued {
    const runs = runsOf(ledger);
    const lockId = ledger.delivery.lock?.job.id;
    const locked = lockId ? runs[lockId] : undefined;
    const ahead = locked ?? unfinished(ledger)[0] ?? null;
    const id = randomUUID();
    let waitingOn: string | null = null;
    if (ahead?.state === "failed") {
      waitingOn = `Waits for you to settle the ${ahead.kind} whose outcome is unknown; it never runs alongside it.`;
    } else if (ahead) {
      waitingOn = `Waits for the ${ahead.kind} already in progress to finish; it never runs alongside it.`;
    }
    runs[id] = { ...run, id, seq: Object.keys(runs).length + 1, waitingOn };
    return { runId: id, behind: ahead?.id ?? null, waitingOn, cancelled };
  }

  function baseRun(kind: DeliveryRunKind, commit: string): Omit<DeliveryRun, "seq" | "id"> {
    return {
      kind,
      state: "pending",
      commit,
      values: emptyValues(commit),
      contents: [],
      gates: [],
      notes: null,
      releaseEventId: null,
      approval: null,
      queuedAt: nowIso(),
      notBefore: null,
      noticeSentAt: null,
      receipts: {},
      history: [],
      acceptUnknownDeploy: false,
      branch: null,
      records: null,
      report: null,
      failure: null,
      resolutions: [],
      waitingOn: null,
      finishedAt: null,
    };
  }

  async function queueBeta(input: BetaInput): Promise<Queued | Refused> {
    if (!SHA.test(input.commit)) return { refused: "A beta needs the full accepted commit." };
    const read = await readRecipe(input.commit);
    if ("refused" in read) return read;
    const minutes = read.extras.channels.beta.noticeMinutes ?? DEFAULT_NOTICE_MINUTES;
    return mutate((ledger) => {
      if (unfinished(ledger).length > 0) {
        return { refused: "A delivery is already queued or in progress; the next batch waits." };
      }
      const run = baseRun("beta", input.commit);
      run.values = { ...run.values, number: input.number, note: input.note };
      run.contents = input.contents;
      run.gates = gatePlan(read.recipe, "beta");
      run.notBefore = new Date(deps.now().getTime() + minutes * 60_000).toISOString();
      return enqueue(ledger, run, []);
    });
  }

  async function queuePromote(input: PromoteInput): Promise<Queued | Refused> {
    const before = await state.read(projectId);
    const beta = before.releases.find((e) => e.id === input.eventId && e.kind === "beta");
    if (!beta) return { refused: "Only a recorded beta can be promoted." };
    const read = await readRecipe(beta.commit);
    if ("refused" in read) return read;
    return mutate((ledger) => {
      const event = ledger.releases.find((e) => e.id === input.eventId && e.kind === "beta");
      if (!event) return { refused: "Only a recorded beta can be promoted." };
      if (input.approval === null) return { refused: NO_APPROVAL };
      const refusal = approvalRefusal(input.approval, event);
      if (refusal) return { refused: refusal };
      if ((production(ledger)?.id ?? null) !== input.expectedProduction) {
        return { refused: "Production changed since you looked; review the releases again." };
      }
      if (event.artifact === null) {
        return { refused: "This beta has no frozen build to promote." };
      }
      const run = baseRun("promote", event.commit);
      run.releaseEventId = event.id;
      run.approval = input.approval;
      run.contents = event.contents;
      run.gates = gatePlan(read.recipe, "promote");
      run.values = {
        ...run.values,
        version: event.version,
        artifact: event.artifact,
        previousVersion: production(ledger)?.version ?? null,
        number: input.number,
        note: input.note,
        approval: input.approval.words,
      };
      return enqueue(ledger, run, []);
    });
  }

  async function queueRollback(input: RollbackInput): Promise<Queued | Refused> {
    return mutate((ledger) => {
      const current = production(ledger);
      if (current === null || current.id !== input.expectedProduction) {
        return { refused: "Production changed since you looked; review the releases again." };
      }
      const stable = ledger.releases.filter((e) => e.kind === "promote" || e.kind === "rollback");
      const target = stable.find((e) => e.id === input.targetEventId);
      if (!target || target.id === current.id || target.version === current.version) {
        return { refused: "Choose an earlier production release to roll back to." };
      }
      if (input.approval === null) return { refused: NO_APPROVAL };
      const refusal = approvalRefusal(input.approval, target);
      if (refusal) return { refused: refusal };
      const at = nowIso();
      const cancelled = cancelPendingBetas(ledger, "Cancelled by the owner's rollback.", at);
      // The recipe comes from the release now in production, the newest accepted config.
      const run = baseRun("rollback", current.commit);
      run.releaseEventId = target.id;
      run.approval = input.approval;
      run.values = {
        ...run.values,
        version: target.version,
        artifact: target.artifact,
        previousVersion: current.version,
        targetVersion: target.version,
        target: input.target,
        approval: input.approval.words,
      };
      return enqueue(ledger, run, cancelled);
    });
  }

  /**
   * The release notes slot. A Delivery runner, or the owner, supplies the text before the deploy
   * step starts; until then the batch's merged pull request titles are used.
   */
  async function supplyNotes(runId: string, notes: string): Promise<{ recorded: true } | Refused> {
    return mutate((ledger) => {
      const run = ledger.delivery.runs?.[runId];
      if (!run || isFinished(run) || run.receipts.deploy) {
        return { refused: "Notes can only change before the release is deployed." };
      }
      run.notes = notes;
      return { recorded: true as const };
    });
  }

  /** Owner hold: cancels a beta still in its notice window. The next batch queues a new one. */
  async function hold(runId: string, ownerAction: string): Promise<{ cancelled: true } | Refused> {
    return mutate((ledger) => {
      const run = ledger.delivery.runs?.[runId];
      const notStarted = run ? Object.keys(run.receipts).length === 0 : false;
      const holdable = run?.kind === "beta" && run.state === "pending" && notStarted;
      if (!run || !holdable) return { refused: "Only a beta that has not started can be held." };
      const reason = `Held by the owner (${ownerAction}).`;
      failRun(ledger, run, { kind: "cancelled", reason, at: nowIso() });
      return { cancelled: true as const };
    });
  }

  /**
   * The owner's decision on a failed run. `verify-only` checks the target without deploying
   * and may prove an unknown deploy. `rerun` repeats the step that did not succeed. `abandon`
   * releases the lock of an unknown run after the owner confirmed nothing is still running.
   */
  async function resolve(
    runId: string,
    input: { action: ResolveAction; ownerAction: string },
  ): Promise<{ resolved: true } | Refused> {
    return mutate((ledger) => {
      const run = ledger.delivery.runs?.[runId];
      if (!run || run.state !== "failed" || run.failure?.kind === "cancelled") {
        return { refused: "Only a failed delivery can be retried." };
      }
      const at = nowIso();
      const deploy = run.receipts.deploy?.status;
      const deployProvable = deploy === "unknown" || deploy === "succeeded";
      if (input.action === "verify-only" && !deployProvable) {
        return { refused: "Verification can only settle a deploy that ran or may have run." };
      }
      run.resolutions.push({ action: input.action, ownerAction: input.ownerAction, at });
      if (input.action === "abandon") {
        if (ledger.delivery.lock?.job.id === run.id) ledger.delivery.lock = null;
        return { resolved: true as const };
      }
      if (input.action === "verify-only") run.acceptUnknownDeploy = true;
      const retried = new Set(["verify", "records"]);
      for (const [key, receipt] of Object.entries(run.receipts)) {
        const replace =
          retried.has(key) || (input.action === "rerun" && receipt.status !== "succeeded");
        if (!replace) continue;
        run.history.push(receipt);
        delete run.receipts[key];
      }
      run.state = "pending";
      run.failure = null;
      run.finishedAt = null;
      run.notBefore = null;
      return { resolved: true as const };
    });
  }

  /** On daemon start: any launch recorded without an outcome becomes unknown. Never reruns. */
  async function resume(): Promise<void> {
    await mutate((ledger) => {
      const at = nowIso();
      for (const run of unfinished(ledger)) {
        for (const receipt of Object.values(run.receipts)) {
          // A submitted lifecycle request is tracked by the workflow and stays resumable.
          if (receipt.status !== "started" || receipt.lifecycleRequest !== null) continue;
          receipt.status = "unknown";
          receipt.finishedAt = at;
          failRun(ledger, run, {
            kind: "unknown",
            reason: `The daemon restarted during the ${receipt.key} step. Check the target, then choose verify, rerun or abandon.`,
            at,
          });
        }
      }
    });
  }

  async function setWaiting(runId: string, waitingOn: string): Promise<false> {
    await mutate((ledger) => {
      const run = ledger.delivery.runs?.[runId];
      if (run) run.waitingOn = waitingOn;
    });
    return false;
  }

  async function refuse(runId: string, reason: string): Promise<true> {
    await mutate((ledger) => {
      const run = ledger.delivery.runs?.[runId];
      if (run && !isFinished(run)) failRun(ledger, run, { kind: "refused", reason, at: nowIso() });
    });
    return true;
  }

  async function stepFailed(runId: string, reason: string): Promise<true> {
    await mutate((ledger) => {
      const run = ledger.delivery.runs?.[runId];
      if (run && !isFinished(run)) {
        failRun(ledger, run, { kind: "step-failed", reason, at: nowIso() });
      }
    });
    return true;
  }

  function attemptOf(run: DeliveryRun, key: StepKey): number {
    return run.history.filter((receipt) => receipt.key === key).length + 1;
  }

  function startedReceipt(input: {
    key: StepKey;
    attempt: number;
    where: StepReceipt["where"];
    laneEpoch: number;
    startedAt: string;
  }): StepReceipt {
    return {
      ...input,
      status: "started",
      finishedAt: null,
      exitCode: null,
      pid: null,
      outputDigest: null,
      log: null,
      lifecycleRequest: null,
      detail: null,
    };
  }

  /** Records an idempotent daemon step (no process) that already succeeded. */
  async function settled(run: DeliveryRun, key: StepKey, detail: string | null): Promise<true> {
    await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      if (!current || current.state !== "running" || current.receipts[key]) return;
      const at = nowIso();
      const laneEpoch = ledger.delivery.lock?.laneEpoch ?? -1;
      const receipt = startedReceipt({
        key,
        attempt: attemptOf(current, key),
        where: "git",
        laneEpoch,
        startedAt: at,
      });
      receipt.status = "succeeded";
      receipt.finishedAt = at;
      receipt.detail = detail;
      current.receipts[key] = receipt;
    });
    return true;
  }

  /** The commit a place's checkout holds for this run: its prepared head, else the accepted commit. */
  function headFor(run: DeliveryRun, where: StepWhere): string {
    return run.receipts[`prepare:${where}`]?.detail ?? run.commit;
  }

  async function trusted(head: string, run: DeliveryRun): Promise<boolean> {
    if (head === run.commit) return true;
    return hostGateRefusal(await deps.hostGate(head), head) === null;
  }

  async function prepare(run: DeliveryRun, where: StepWhere, read: RecipeRead): Promise<true> {
    const configured = where === "container" || read.extras.checkout !== undefined;
    const port = configured ? deps.deliveryCheckouts[where] : undefined;
    if (!port) return settled(run, `prepare:${where}`, null);
    // Betas run at the accepted commit. Promote and rollback ship frozen bytes from the current
    // default branch, which must contain the accepted commit and carry its own gate record.
    const target = run.kind === "beta" ? run.commit : await deps.branch.head();
    if (where === "host" && !(await trusted(target, run))) {
      return refuse(run.id, `The default branch head ${target} has no passed merge gate record.`);
    }
    const prepared = await port.prepare({ commit: target, records: read.extras.records ?? [] });
    if ("notStarted" in prepared) return refuse(run.id, prepared.notStarted);
    return settled(run, `prepare:${where}`, prepared.head);
  }

  async function install(run: DeliveryRun, key: StepKey, read: RecipeRead): Promise<boolean> {
    const where = key.slice("install:".length);
    const declared = installsOf(read.extras).find((s) => (s.where ?? "container") === where);
    const port =
      where === "host" || where === "container" ? deps.deliveryCheckouts[where] : undefined;
    if (!declared || !port)
      return refuse(run.id, `The ${where} install needs a delivery checkout.`);
    const blob = await port.blob(declared.lockfile);
    const ledger: DeliveryLedger = await state.read(projectId);
    const last = ledger.delivery.installs?.[`${where}:${port.path}`];
    if (blob !== null && blob === last) return settled(run, key, blob);
    return launch(run, key, blob);
  }

  async function tagMilestone(run: DeliveryRun, read: RecipeRead): Promise<true> {
    const port = deps.deliveryCheckouts.host;
    const prefix = read.extras.milestoneTag;
    if (!port || prefix === undefined || run.values.version === null) {
      return refuse(run.id, "The milestone tag needs the Host delivery checkout and the version.");
    }
    const name = `${prefix}${run.values.version}`;
    const tagged = await port.tag(name);
    if ("notStarted" in tagged) return refuse(run.id, tagged.notStarted);
    return settled(run, "milestone", name);
  }

  async function checkBranch(run: DeliveryRun, read: RecipeRead): Promise<true> {
    const before = run.branch?.before;
    if (!before) return refuse(run.id, "The deploy recorded no default-branch head before it ran.");
    const after = await deps.branch.head();
    const commits = await deps.branch.firstParent(before, after);
    if (commits === null) {
      return stepFailed(
        run.id,
        `The default branch moved from ${before} to ${after} along a path Factory cannot prove.`,
      );
    }
    const refusal = branchRefusal(commits, read.extras.records ?? []);
    await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      if (current?.branch) current.branch = { before, after, commits };
    });
    if (refusal) return stepFailed(run.id, refusal);
    return settled(run, "branch", after);
  }

  async function startLifecycle(
    run: DeliveryRun,
    env: Record<string, string>,
    laneEpoch: number,
  ): Promise<boolean> {
    const lifecycle = deps.lifecycle;
    if (lifecycle === null) return refuse(run.id, "This installation has no lifecycle workflow.");
    const before = await deps.branch.head();
    if (
      !(await deps.authorizeSideEffect({ runId: run.id, kind: "deploy", expectedHead: before }))
    ) {
      return setWaiting(run.id, "Factory's composition did not allow the deploy now.");
    }
    const started = await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      if (!current || current.state !== "running" || current.receipts.deploy) return false;
      current.receipts.deploy = startedReceipt({
        key: "deploy",
        attempt: attemptOf(current, "deploy"),
        where: "lifecycle",
        laneEpoch,
        startedAt: nowIso(),
      });
      current.branch = { before, after: null, commits: [] };
      return true;
    });
    if (!started) return true;
    const requestId = await lifecycle.request({ runId: run.id, commit: run.commit, env });
    await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      const deploy = current?.receipts.deploy;
      if (!current || !deploy || deploy.status !== "started") return;
      deploy.lifecycleRequest = requestId;
      current.state = "awaiting-approval";
    });
    return true;
  }

  async function runCheck(run: DeliveryRun, key: StepKey, name: string, laneEpoch: number) {
    if (deps.checks === null)
      return refuse(run.id, `This installation cannot read the check ${name}.`);
    const result = await deps.checks.result(run.commit, name);
    if (result === "pending") return setWaiting(run.id, `Waiting for the check ${name} to finish.`);
    await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      if (!current || current.state !== "running" || current.receipts[key]) return;
      const at = nowIso();
      const receipt = startedReceipt({
        key,
        attempt: attemptOf(current, key),
        where: "check",
        laneEpoch,
        startedAt: at,
      });
      receipt.status = result === "pass" ? "succeeded" : "failed";
      receipt.finishedAt = at;
      current.receipts[key] = receipt;
      if (result === "fail") {
        const reason = `The check ${name} failed; nothing was deployed.`;
        failRun(ledger, current, { kind: "step-failed", reason, at });
      }
    });
    return true;
  }

  /** Lock, lane fence and approval, re-checked before every launch. */
  async function launchRefusal(
    run: DeliveryRun,
  ): Promise<{ refused: string } | { laneEpoch: number }> {
    const ledger: DeliveryLedger = await state.read(projectId);
    const approval = recordedApprovalRefusal(run, ledger);
    if (approval) return { refused: approval };
    const lock = ledger.delivery.lock;
    const epoch = await deps.fence();
    if (lock?.job.id !== run.id || epoch !== lock.laneEpoch) {
      return { refused: "The delivery lane moved to another holder; nothing was started." };
    }
    return { laneEpoch: lock.laneEpoch };
  }

  async function launch(
    run: DeliveryRun,
    key: StepKey,
    detail: string | null = null,
  ): Promise<boolean> {
    const read = await readRecipe(run.commit);
    if ("refused" in read) return refuse(run.id, read.refused);
    const recipeStep = resolveStep(read, run, key);
    if (recipeStep.kind === "refused") return refuse(run.id, recipeStep.reason);
    const env = releaseEnv(launchValues(run));
    if ("refused" in env) return refuse(run.id, env.refused);
    const fenced = await launchRefusal(run);
    if ("refused" in fenced) return refuse(run.id, fenced.refused);
    const { laneEpoch } = fenced;
    if (recipeStep.kind === "lifecycle") return startLifecycle(run, env, laneEpoch);
    if (recipeStep.kind === "check") return runCheck(run, key, recipeStep.name, laneEpoch);
    const { command, where, heavy } = recipeStep;
    const head = headFor(run, where);
    if (where === "host") {
      const refusal = hostGateRefusal(await deps.hostGate(head), head);
      if (refusal) return refuse(run.id, refusal);
    }
    const adapter = deps.adapters[where];
    if (!adapter) return refuse(run.id, `This installation cannot run ${where} steps.`);
    const branchBefore = key === "deploy" ? await deps.branch.head() : null;
    if (key === "deploy") {
      const allowed = await deps.authorizeSideEffect({
        runId: run.id,
        kind: "deploy",
        expectedHead: branchBefore,
      });
      if (!allowed)
        return setWaiting(run.id, "Factory's composition did not allow the deploy now.");
    }

    const attempt = attemptOf(run, key);
    const startedAt = nowIso();
    const expectedState = key === "verify" ? "verifying" : "running";
    let launched = false;
    const output = await adapter.run({
      commit: head,
      records: read.extras.records ?? [],
      command,
      env,
      timeoutMs: deps.stepTimeoutMs,
      heavy,
      outputPath: path.join(deps.logDir, logName(run.id, key, attempt)),
      async authorizeLaunch() {
        launched = await mutate((current) => {
          const target = current.delivery.runs?.[run.id];
          if (!target || target.state !== expectedState || target.receipts[key]) return false;
          const receipt = startedReceipt({ key, attempt, where, laneEpoch, startedAt });
          receipt.detail = detail;
          target.receipts[key] = receipt;
          if (branchBefore !== null)
            target.branch = { before: branchBefore, after: null, commits: [] };
          return true;
        });
        return launched;
      },
      async onSpawned(pid) {
        await mutate((current) => {
          const receipt = current.delivery.runs?.[run.id]?.receipts[key];
          if (receipt?.status === "started" && receipt.attempt === attempt) receipt.pid = pid;
        });
      },
    });
    if (output !== null && "notStarted" in output) {
      return launched ? true : refuse(run.id, output.notStarted);
    }
    if (!launched) return true;
    await complete({ runId: run.id, key, attempt, startedAt, output });
    return true;
  }

  async function complete(input: StepCompletion): Promise<void> {
    const { runId, key, attempt, startedAt, output } = input;
    const digest = output ? createHash("sha256").update(output.stdout).digest("hex") : null;
    await mutate((ledger) => {
      const run = ledger.delivery.runs?.[runId];
      const receipt = run?.receipts[key];
      // A newer attempt or a restart already settled this receipt; never overwrite it.
      const settledAlready = receipt?.status !== "started" || receipt.attempt !== attempt;
      if (!run || !receipt || settledAlready || receipt.startedAt !== startedAt) return;
      const at = nowIso();
      receipt.finishedAt = at;
      receipt.outputDigest = digest;
      receipt.log = path.join(deps.logDir, logName(runId, key, attempt));
      if (output === null) {
        receipt.status = "unknown";
        const reason = `The ${key} step's outcome is unknown. Check the target, then choose verify, rerun or abandon.`;
        failRun(ledger, run, { kind: "unknown", reason, at });
        return;
      }
      receipt.exitCode = output.exitCode;
      receipt.status = output.exitCode === 0 ? "succeeded" : "failed";
      if (output.exitCode !== 0) {
        const beforeDeploy = !run.receipts.deploy || key === "deploy";
        const note = beforeDeploy && key !== "deploy" ? " Nothing was deployed." : "";
        const reason = `The ${key} step exited with ${output.exitCode}; see its delivery log.${note}`;
        failRun(ledger, run, { kind: "step-failed", reason, at });
        return;
      }
      settleOutput({ ledger, run, receipt, stdout: output.stdout, at });
    });
  }

  function settleOutput(input: {
    ledger: DeliveryLedger;
    run: DeliveryRun;
    receipt: StepReceipt;
    stdout: string;
    at: string;
  }): void {
    const { ledger, run, receipt, stdout, at } = input;
    function fail(reason: string): void {
      receipt.status = "failed";
      failRun(ledger, run, { kind: "step-failed", reason, at });
    }
    if (receipt.key.startsWith("install:")) {
      const port = deps.deliveryCheckouts[receipt.where === "host" ? "host" : "container"];
      if (port && receipt.detail !== null) {
        ledger.delivery.installs ??= {};
        ledger.delivery.installs[`${receipt.where}:${port.path}`] = receipt.detail;
      }
      return;
    }
    if (receipt.key === "number") {
      const parsed = NumberReportSchema.safeParse(lastJsonLine(stdout));
      if (!parsed.success) return fail('The releaseNumber step printed no {"number"} report.');
      run.values.number = parsed.data.number;
      return;
    }
    if (receipt.key === "version") {
      const parsed = VersionLineSchema.safeParse(lastLine(stdout));
      if (!parsed.success) return fail("The version step printed no version on its last line.");
      run.values.version = parsed.data;
      return;
    }
    if (receipt.key !== "verify") return;
    const parsed = ReportSchema.safeParse(lastJsonLine(stdout));
    const report = parsed.success ? parsed.data : null;
    run.report = report;
    if (report === null) return fail("Verification printed no release report.");
    const refusal = reportRefusal(run, report, ledger);
    if (refusal !== null) return fail(refusal);
  }

  /** After verification: commit the appended record rows, then record the delivery. */
  async function finish(run: DeliveryRun): Promise<boolean> {
    const read = await readRecipe(run.commit);
    if ("refused" in read) return refuse(run.id, read.refused);
    const records = read.extras.records ?? [];
    const port = deps.deliveryCheckouts.host;
    const receipt = run.receipts.records;
    if (receipt && receipt.status !== "succeeded") return false;
    if (!receipt && records.length > 0 && port) return commitRecords(run, port, records);
    await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      if (current?.state === "verifying" && current.report) deliver(ledger, current, nowIso());
    });
    return true;
  }

  async function commitRecords(
    run: DeliveryRun,
    port: DeliveryCheckoutPort,
    records: readonly string[],
  ): Promise<boolean> {
    const fenced = await launchRefusal(run);
    if ("refused" in fenced) return refuse(run.id, fenced.refused);
    const expectedHead = await deps.branch.head();
    const version = run.report?.version ?? run.values.version ?? "unversioned";
    const startedAt = nowIso();
    const attempt = attemptOf(run, "records");
    const result = await port.commitRecords({
      base: headFor(run, "host"),
      expectedHead,
      records,
      message: `Record Factory release ${version} (${run.id})`,
      async authorizePush(push) {
        if (
          !(await deps.authorizeSideEffect({ runId: run.id, kind: "records-push", expectedHead }))
        ) {
          return false;
        }
        return mutate((ledger) => {
          const current = ledger.delivery.runs?.[run.id];
          if (!current || current.state !== "verifying" || current.receipts.records) return false;
          const receipt = startedReceipt({
            key: "records",
            attempt,
            where: "git",
            laneEpoch: fenced.laneEpoch,
            startedAt,
          });
          receipt.detail = push.commit;
          current.receipts.records = receipt;
          return true;
        });
      },
    });
    if (result !== null && "withheld" in result) {
      return setWaiting(run.id, "Factory's composition did not allow the records push now.");
    }
    await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      if (!current || current.state !== "verifying") return;
      const at = nowIso();
      if (result === null) {
        const receipt = startedReceipt({
          key: "records",
          attempt,
          where: "git",
          laneEpoch: fenced.laneEpoch,
          startedAt,
        });
        receipt.status = "succeeded";
        receipt.finishedAt = at;
        current.receipts.records = receipt;
        current.records = null;
        return;
      }
      const receipt = current.receipts.records;
      if ("refused" in result) {
        if (receipt?.status === "started") receipt.status = "failed";
        failRun(ledger, current, { kind: "step-failed", reason: result.refused, at });
        return;
      }
      if (!receipt || receipt.status !== "started" || receipt.detail !== result.commit) return;
      receipt.status = "succeeded";
      receipt.finishedAt = at;
      current.records = result;
    });
    return true;
  }

  function deliver(ledger: DeliveryLedger, run: DeliveryRun, at: string): void {
    const report = run.report;
    const verify = run.receipts.verify;
    if (!report || !verify) return;
    const event = releaseEvent(run, report, at);
    const branch = run.branch;
    ledger.delivery.receipts.push({
      jobId: run.id,
      kind: JOB_KIND[run.kind],
      commits: [run.commit],
      target: CHANNEL[run.kind],
      verifiedAt: at,
      verification: `The verify step reported ${event.version}.`,
      outcome: "delivered",
      laneEpoch: verify.laneEpoch,
      notesUrl: null,
      ...(branch?.after
        ? { branch: { before: branch.before, after: branch.after, commits: branch.commits } }
        : {}),
      records: run.records,
    });
    ledger.releases.push(event);
    run.state = "delivered";
    run.finishedAt = at;
    run.waitingOn = null;
    if (ledger.delivery.lock?.job.id === run.id) ledger.delivery.lock = null;
  }

  async function startRun(run: DeliveryRun): Promise<boolean> {
    if (run.kind === "beta" && run.noticeSentAt === null && run.notBefore !== null) {
      // The full notice window starts when the owner is told, not when the beta was queued.
      const windowMs = Date.parse(run.notBefore) - Date.parse(run.queuedAt);
      const notBefore = new Date(deps.now().getTime() + windowMs).toISOString();
      await deps.notify({ kind: "beta-notice", runId: run.id, commit: run.commit, notBefore });
      await mutate((ledger) => {
        const current = ledger.delivery.runs?.[run.id];
        if (!current) return;
        current.noticeSentAt = nowIso();
        current.notBefore = notBefore;
      });
      return true;
    }
    if (run.notBefore !== null && Date.parse(run.notBefore) > deps.now().getTime()) return false;
    const epoch = await deps.fence();
    if (epoch === null) return setWaiting(run.id, "This machine does not hold the delivery lane.");
    return mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      const lock = ledger.delivery.lock;
      if (!current || current.state !== "pending") return true;
      if (lock && lock.job.id !== run.id) return false;
      const ttlMs = deps.stepTimeoutMs * 2;
      ledger.delivery.lock = lockFor(current, deps.installation, epoch, deps.now(), ttlMs);
      current.state = "running";
      current.waitingOn = null;
      return true;
    });
  }

  async function pollLifecycle(run: DeliveryRun): Promise<boolean> {
    const requestId = run.receipts.deploy?.lifecycleRequest;
    if (!deps.lifecycle || !requestId) return refuse(run.id, "The lifecycle request is missing.");
    const status = await deps.lifecycle.status(requestId);
    if (status.kind === "pending") return false;
    await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      const deploy = current?.receipts.deploy;
      if (!current || !deploy || current.state !== "awaiting-approval") return;
      const at = nowIso();
      deploy.finishedAt = at;
      if (status.kind === "refused") {
        deploy.status = "failed";
        failRun(ledger, current, { kind: "step-failed", reason: status.reason, at });
        return;
      }
      deploy.status = "succeeded";
      current.state = "running";
    });
    return true;
  }

  /** Runs the next step of the plan, or moves to verification once every step succeeded. */
  async function runPlan(run: DeliveryRun): Promise<boolean> {
    const read = await readRecipe(run.commit);
    if ("refused" in read) return refuse(run.id, read.refused);
    for (const key of planOf(run, read, placesOf(read, run))) {
      const receipt = run.receipts[key];
      if (!receipt) return runStep(run, key, read);
      if (receipt.status === "succeeded") continue;
      const proven = key === "deploy" && receipt.status === "unknown" && run.acceptUnknownDeploy;
      if (!proven) return false;
    }
    await mutate((ledger) => {
      const target = ledger.delivery.runs?.[run.id];
      if (target?.state === "running") target.state = "verifying";
    });
    return true;
  }

  function runStep(run: DeliveryRun, key: StepKey, read: RecipeRead): Promise<boolean> {
    if (key.startsWith("prepare:"))
      return prepare(run, key === "prepare:host" ? "host" : "container", read);
    if (key.startsWith("install:")) return install(run, key, read);
    if (key === "milestone") return tagMilestone(run, read);
    if (key === "branch") return checkBranch(run, read);
    return launch(run, key);
  }

  async function step(): Promise<boolean> {
    const ledger: DeliveryLedger = await state.read(projectId);
    const lockId = ledger.delivery.lock?.job.id;
    const locked = lockId ? ledger.delivery.runs?.[lockId] : undefined;
    if (locked?.state === "failed") return false;
    const run = locked && !isFinished(locked) ? locked : unfinished(ledger)[0];
    if (!run) return false;
    switch (run.state) {
      case "pending":
        return startRun(run);
      case "running":
        return runPlan(run);
      case "awaiting-approval":
        return pollLifecycle(run);
      case "verifying": {
        const verify = run.receipts.verify;
        if (!verify) return launch(run, "verify");
        return verify.status === "succeeded" ? finish(run) : false;
      }
      case "delivered":
      case "failed":
        return false;
    }
  }

  /** One deterministic pass: moves the queue until it waits. Concurrent calls share one pass. */
  function advance(): Promise<void> {
    inFlight ??= (async () => {
      try {
        for (let moves = 0; moves < 64 && (await step()); moves++);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function list(): Promise<DeliveryRun[]> {
    const ledger: DeliveryLedger = await state.read(projectId);
    return Object.values(ledger.delivery.runs ?? {}).sort((a, b) => a.seq - b.seq);
  }

  /** The authoritative delivery state for status and view, read from the ledger only. */
  async function snapshot(): Promise<DeliverySnapshot> {
    const ledger: DeliveryLedger = await state.read(projectId);
    const queue = unfinished(ledger);
    const lockId = ledger.delivery.lock?.job.id;
    const locked = lockId ? (ledger.delivery.runs?.[lockId] ?? null) : null;
    const pendingBeta =
      queue.find(
        (run) =>
          run.kind === "beta" && run.state === "pending" && Object.keys(run.receipts).length === 0,
      ) ?? null;
    return {
      pendingBeta,
      active: locked && !isFinished(locked) ? locked : null,
      needsOwner: locked?.state === "failed" ? locked : null,
      queued: queue,
    };
  }

  return {
    queueBeta,
    queuePromote,
    queueRollback,
    supplyNotes,
    hold,
    resolve,
    resume,
    advance,
    list,
    snapshot,
  };
}

export type DeliveryExecutor = ReturnType<typeof createDeliveryExecutor>;
