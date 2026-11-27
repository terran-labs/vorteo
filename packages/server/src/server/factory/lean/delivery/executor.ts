/**
 * Deterministic delivery: a persisted daemon state machine that runs a project's release recipe
 * from the accepted commit and writes its own receipts. No agent session is held at any point,
 * including while a tracked lifecycle request waits for approval.
 *
 * Safety rules this module keeps:
 * - A step that has a receipt is never launched again. A step whose launch was recorded but
 *   whose outcome was lost (daemon restart, adapter returned null) becomes `unknown`; only an
 *   explicit owner `resolve` moves it on, so a deploy is never repeated automatically.
 * - The "started" receipt is written atomically immediately before the process starts, through
 *   the adapter's `authorizeLaunch` callback.
 * - Release values reach commands only as VORTEO_RELEASE_* environment variables. Commands are
 *   static recipe text from the accepted commit; a command with legacy `{version}` placeholders
 *   is refused.
 * - Host steps run only when the accepted commit's recipe names them `where: "host"` and the
 *   merge gate's record shows intake trust, the review verdict and the owner-only file gate all
 *   passed for exactly that commit. A missing record refuses.
 * - Raw step output never enters the ledger. Receipts carry a digest and the path of a bounded
 *   tail written to the private delivery log directory. The verify step's small release report
 *   is the one value kept.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FactoryReleaseEvent, ReleaseRecipeV1 } from "@getpaseo/server/factory-project";
import { writeFileAtomic } from "../../../atomic-file.js";
import type { DeliveryJob, DeliveryLock, LeanLedger, LeanStateStore } from "../types.js";

export const RELEASE_ENV = {
  version: "VORTEO_RELEASE_VERSION",
  commit: "VORTEO_RELEASE_COMMIT",
  artifact: "VORTEO_RELEASE_ARTIFACT",
  previousVersion: "VORTEO_RELEASE_PREVIOUS_VERSION",
  targetVersion: "VORTEO_RELEASE_TARGET_VERSION",
  number: "VORTEO_RELEASE_NUMBER",
  note: "VORTEO_RELEASE_NOTE",
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
  "target",
  "approval",
];

export type StepWhere = "container" | "host";
export type DeliveryRunKind = "beta" | "promote" | "rollback";
export type DeliveryRunState =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "verifying"
  | "delivered"
  | "failed";
export type Phase = "deploy" | "verify";

/** The owner's recorded press on one exact release. Only the owner's app produces it. */
export interface OwnerApproval {
  actionId: string;
  eventId: string;
  /** The version shown to the owner when they pressed. */
  version: string;
  /** The owner's own words, passed unchanged as VORTEO_RELEASE_APPROVAL. */
  words: string;
  at: string;
}

export interface StepReceipt {
  phase: Phase;
  attempt: number;
  where: StepWhere | "lifecycle";
  status: "started" | "succeeded" | "failed" | "unknown";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  laneEpoch: number;
  /** sha256 of the full output. */
  outputDigest: string | null;
  /** The private log file holding a bounded tail of the output. */
  log: string | null;
  lifecycleRequest: string | null;
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
  /** The beta being promoted, or the release being restored. */
  releaseEventId: string | null;
  approval: OwnerApproval | null;
  queuedAt: string;
  notBefore: string | null;
  noticeSentAt: string | null;
  deploy: StepReceipt | null;
  verify: StepReceipt | null;
  /** Receipts replaced by an owner resolution, oldest first. */
  history: StepReceipt[];
  /** Set by a verify-only resolution: an unknown deploy may be proven by verification. */
  acceptUnknownDeploy: boolean;
  report: ReleaseReport | null;
  failure: DeliveryFailure | null;
  resolutions: OwnerResolution[];
  /** Why the run is not moving, for the owner. */
  waitingOn: string | null;
  finishedAt: string | null;
}

export interface ExecutorLockHolder {
  kind: "executor";
  installation: string;
}
/** The delivery lock with the executor as holder (proposed for types.ts as an additive union). */
export interface ExecutorLock extends Omit<DeliveryLock, "holder"> {
  holder: ExecutorLockHolder;
}

/**
 * The ledger as this module writes it. A type alias because the lock holder widens the base
 * type, which an interface extension cannot do; every LeanLedger is still a DeliveryLedger.
 */
type DeliveryLedger = Omit<LeanLedger, "delivery"> & {
  delivery: Omit<LeanLedger["delivery"], "lock"> & {
    lock: DeliveryLock | ExecutorLock | null;
    runs?: Record<string, DeliveryRun>;
  };
};
type ReleaseHistory = Pick<LeanLedger, "releases">;

export interface StepOutput {
  exitCode: number;
  stdout: string;
}

export interface DeliveryStepRequest {
  /** The accepted commit; the adapter runs in a checkout of exactly this commit. */
  commit: string;
  /** Recipe text, run as `/bin/sh -c <command>`. Never contains release values. */
  command: string;
  /** The only channel for release values. Merged over the adapter's own minimal environment. */
  env: Record<string, string>;
  timeoutMs: number;
  /** Call immediately before starting the process; start nothing when it returns false. */
  authorizeLaunch(): Promise<boolean>;
}

export interface DeliveryStepAdapter {
  /** Null when the outcome is unknown: the process may or may not have run to completion. */
  run(input: DeliveryStepRequest): Promise<StepOutput | null>;
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
  lifecycle: LifecyclePort | null;
  /** The recipe in `.github/vorteo-factory.json` at exactly this commit. */
  recipeAt(commit: string): Promise<RecipeAtCommit>;
  hostGate(commit: string): Promise<HostGateRecord | null>;
  /** The delivery lane epoch this installation holds now, or null. */
  fence(): Promise<number | null>;
  /** "Needs you": tells the owner a beta is about to ship. */
  notify(notice: BetaNotice): Promise<void>;
  /** Private, outside Git, such as `$PASEO_HOME/factory/lean/delivery-logs`. */
  logDir: string;
  stepTimeoutMs: number;
  now(): Date;
}

export interface BetaInput {
  commit: string;
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
  /** The unfinished run this one waits behind, with the sentence shown to the owner. */
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
  phase: Phase;
  attempt: number;
  startedAt: string;
  output: StepOutput | null;
}

interface Delivered {
  ledger: DeliveryLedger;
  run: DeliveryRun;
  report: ReleaseReport;
  laneEpoch: number;
  at: string;
}

export const DEFAULT_NOTICE_MINUTES = 10;
const LOG_TAIL_BYTES = 16 * 1024;
const PLACEHOLDER = /\{(version|commit|artifact|previousVersion|targetVersion)\}/u;
const SHA = /^[0-9a-f]{40}$/u;
const STEPS = {
  beta: { deploy: "deployBeta", verify: "verifyBeta" },
  promote: { deploy: "promote", verify: "verifyStable" },
  rollback: { deploy: "rollback", verify: "verifyStable" },
} as const;
const JOB_KIND = {
  beta: "cut-beta",
  promote: "promote",
  rollback: "rollback",
} as const;
const CHANNEL = {
  beta: "beta",
  promote: "stable",
  rollback: "stable",
} as const;

const CommandStepSchema = z.looseObject({
  run: z.string().min(1),
  where: z.enum(["container", "host"]).optional(),
});
const LifecycleStepSchema = z.looseObject({
  lifecycle: z.literal("host-source-update"),
});
const NoticeSchema = z.looseObject({
  noticeMinutes: z.number().nonnegative().optional(),
});
const ReportSchema = z.object({
  version: z.string().min(1),
  commit: z.string().nullable(),
  artifact: z.string().nullable(),
});

type ResolvedStep =
  | { kind: "command"; command: string; where: StepWhere }
  | { kind: "lifecycle" }
  | { kind: "refused"; reason: string };

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
    target: null,
    approval: null,
  };
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

function resolveStep(recipe: ReleaseRecipeV1, kind: DeliveryRunKind, phase: Phase): ResolvedStep {
  const name = STEPS[kind][phase];
  const step: unknown = recipe.steps[name];
  if (LifecycleStepSchema.safeParse(step).success) {
    if (phase === "verify") return { kind: "refused", reason: `${name} cannot be a lifecycle.` };
    return { kind: "lifecycle" };
  }
  const parsed = CommandStepSchema.safeParse(step);
  if (!parsed.success) {
    return {
      kind: "refused",
      reason: `The recipe has no runnable ${name} step.`,
    };
  }
  if (PLACEHOLDER.test(parsed.data.run)) {
    return {
      kind: "refused",
      reason: `The ${name} step uses {placeholders}; use the VORTEO_RELEASE_* variables instead.`,
    };
  }
  return {
    kind: "command",
    command: parsed.data.run,
    where: parsed.data.where ?? "container",
  };
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
      return `The ${label} did not pass for this exact commit, so the Host step is refused.`;
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

function parseReport(stdout: string): ReleaseReport | null {
  const lines = stdout.trim().split("\n");
  const last = lines.at(-1) ?? "";
  try {
    const parsed = ReportSchema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : null;
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
      return `The beta record names commit ${
        report.commit ?? "none"
      }, not the accepted ${run.commit}.`;
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

function releaseEvent(run: DeliveryRun, report: ReleaseReport, at: string): FactoryReleaseEvent {
  const version = report.version;
  const event: FactoryReleaseEvent = {
    id: run.id,
    kind: run.kind,
    version,
    channel: CHANNEL[run.kind],
    commit: run.commit,
    artifact: run.kind === "beta" ? report.artifact : run.values.artifact,
    at,
    by: { runner: null, ownerAction: run.approval?.actionId ?? null },
    contents: run.contents,
    gates: [],
  };
  if (run.kind === "rollback") {
    event.rollbackOf = {
      fromVersion: run.values.previousVersion ?? "unknown",
      toVersion: version,
    };
  }
  return event;
}

function lockFor(
  run: DeliveryRun,
  installation: string,
  epoch: number,
  now: Date,
  ttlMs: number,
): ExecutorLock {
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
}

function cancelPendingBetas(ledger: DeliveryLedger, reason: string, at: string): string[] {
  const cancelled: string[] = [];
  for (const run of unfinished(ledger)) {
    const inNoticeWindow = run.kind === "beta" && run.state === "pending" && run.deploy === null;
    if (!inNoticeWindow) continue;
    failRun(ledger, run, { kind: "cancelled", reason, at });
    cancelled.push(run.id);
  }
  return cancelled;
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
      releaseEventId: null,
      approval: null,
      queuedAt: nowIso(),
      notBefore: null,
      noticeSentAt: null,
      deploy: null,
      verify: null,
      history: [],
      acceptUnknownDeploy: false,
      report: null,
      failure: null,
      resolutions: [],
      waitingOn: null,
      finishedAt: null,
    };
  }

  async function queueBeta(input: BetaInput): Promise<Queued | Refused> {
    if (!SHA.test(input.commit)) return { refused: "A beta needs the full accepted commit." };
    const { recipe, error } = await deps.recipeAt(input.commit);
    if (!recipe) return { refused: error ?? "The accepted commit has no release recipe." };
    const notice = NoticeSchema.safeParse(recipe.channels.beta);
    const minutes = notice.success ? notice.data.noticeMinutes : undefined;
    const delayMs = (minutes ?? DEFAULT_NOTICE_MINUTES) * 60_000;
    return mutate((ledger) => {
      if (unfinished(ledger).length > 0) {
        return {
          refused: "A delivery is already queued or in progress; the next batch waits.",
        };
      }
      const run = baseRun("beta", input.commit);
      run.values = { ...run.values, number: input.number, note: input.note };
      run.contents = input.contents;
      run.notBefore = new Date(deps.now().getTime() + delayMs).toISOString();
      return enqueue(ledger, run, []);
    });
  }

  async function queuePromote(input: PromoteInput): Promise<Queued | Refused> {
    return mutate((ledger) => {
      const event = ledger.releases.find((e) => e.id === input.eventId && e.kind === "beta");
      if (!event) return { refused: "Only a recorded beta can be promoted." };
      if (input.approval === null) return { refused: NO_APPROVAL };
      const refusal = approvalRefusal(input.approval, event);
      if (refusal) return { refused: refusal };
      if ((production(ledger)?.id ?? null) !== input.expectedProduction) {
        return {
          refused: "Production changed since you looked; review the releases again.",
        };
      }
      if (event.artifact === null) {
        return { refused: "This beta has no frozen build to promote." };
      }
      const run = baseRun("promote", event.commit);
      run.releaseEventId = event.id;
      run.approval = input.approval;
      run.contents = event.contents;
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
        return {
          refused: "Production changed since you looked; review the releases again.",
        };
      }
      const stable = ledger.releases.filter((e) => e.kind === "promote" || e.kind === "rollback");
      const target = stable.find((e) => e.id === input.targetEventId);
      if (!target || target.id === current.id || target.version === current.version) {
        return {
          refused: "Choose an earlier production release to roll back to.",
        };
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

  /** Owner hold: cancels a beta still in its notice window. The next batch queues a new one. */
  async function hold(runId: string, ownerAction: string): Promise<{ cancelled: true } | Refused> {
    return mutate((ledger) => {
      const run = ledger.delivery.runs?.[runId];
      const holdable = run?.kind === "beta" && run.state === "pending" && run.deploy === null;
      if (!run || !holdable) return { refused: "Only a beta that has not started can be held." };
      const reason = `Held by the owner (${ownerAction}).`;
      failRun(ledger, run, { kind: "cancelled", reason, at: nowIso() });
      return { cancelled: true as const };
    });
  }

  /**
   * The owner's decision on a failed run. `verify-only` checks the target without deploying
   * and may prove an unknown deploy. `rerun` repeats the failed step. `abandon` releases the
   * lock of an unknown run after the owner confirmed nothing is still running.
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
      const deployProvable = run.deploy?.status === "unknown" || run.deploy?.status === "succeeded";
      if (input.action === "verify-only" && !deployProvable) {
        return {
          refused: "Verification can only settle a deploy that ran or may have run.",
        };
      }
      run.resolutions.push({
        action: input.action,
        ownerAction: input.ownerAction,
        at,
      });
      if (input.action === "abandon") {
        if (ledger.delivery.lock?.job.id === run.id) ledger.delivery.lock = null;
        return { resolved: true as const };
      }
      const failedPhase: Phase = run.verify === null ? "deploy" : "verify";
      if (input.action === "verify-only") run.acceptUnknownDeploy = true;
      const rerunsDeploy = input.action === "rerun" && failedPhase === "deploy";
      const replaced: Phase[] = rerunsDeploy ? ["deploy", "verify"] : ["verify"];
      for (const phase of replaced) {
        const receipt = run[phase];
        if (receipt) run.history.push(receipt);
        run[phase] = null;
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
        for (const phase of ["deploy", "verify"] as const) {
          const receipt = run[phase];
          // A submitted lifecycle request is tracked by the workflow and stays resumable.
          if (!receipt || receipt.status !== "started" || receipt.lifecycleRequest !== null) {
            continue;
          }
          receipt.status = "unknown";
          receipt.finishedAt = at;
          failRun(ledger, run, {
            kind: "unknown",
            reason: `The daemon restarted during the ${phase} step. Check the target, then choose verify, rerun or abandon.`,
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

  async function writeLog(runId: string, phase: Phase, attempt: number, stdout: string) {
    await mkdir(deps.logDir, { recursive: true, mode: 0o700 });
    const file = path.join(deps.logDir, `${runId}-${phase}-${attempt}.log`);
    await writeFileAtomic(file, Buffer.from(stdout).subarray(-LOG_TAIL_BYTES));
    return file;
  }

  function attemptOf(run: DeliveryRun, phase: Phase): number {
    return run.history.filter((receipt) => receipt.phase === phase).length + 1;
  }

  async function startLifecycle(
    run: DeliveryRun,
    env: Record<string, string>,
    laneEpoch: number,
  ): Promise<true> {
    const lifecycle = deps.lifecycle;
    if (lifecycle === null) return refuse(run.id, "This installation has no lifecycle workflow.");
    const started = await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      if (!current || current.state !== "running" || current.deploy !== null) return false;
      current.deploy = {
        phase: "deploy",
        attempt: attemptOf(current, "deploy"),
        where: "lifecycle",
        status: "started",
        startedAt: nowIso(),
        finishedAt: null,
        exitCode: null,
        laneEpoch,
        outputDigest: null,
        log: null,
        lifecycleRequest: null,
      };
      return true;
    });
    if (!started) return true;
    const requestId = await lifecycle.request({
      runId: run.id,
      commit: run.commit,
      env,
    });
    await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      if (!current?.deploy || current.deploy.status !== "started") return;
      current.deploy.lifecycleRequest = requestId;
      current.state = "awaiting-approval";
    });
    return true;
  }

  async function launch(run: DeliveryRun, phase: Phase): Promise<boolean> {
    const { recipe, error } = await deps.recipeAt(run.commit);
    if (!recipe) return refuse(run.id, error ?? "The accepted commit has no release recipe.");
    const recipeStep = resolveStep(recipe, run.kind, phase);
    if (recipeStep.kind === "refused") return refuse(run.id, recipeStep.reason);
    const ledger: DeliveryLedger = await state.read(projectId);
    if (run.releaseEventId !== null) {
      const event = ledger.releases.find((e) => e.id === run.releaseEventId);
      let refusal: string | null = "The release this run acts on is no longer recorded.";
      if (event) refusal = run.approval ? approvalRefusal(run.approval, event) : NO_APPROVAL;
      if (refusal) return refuse(run.id, refusal);
    }
    const env = releaseEnv(run.values);
    if ("refused" in env) return refuse(run.id, env.refused);
    const lock = ledger.delivery.lock;
    const epoch = await deps.fence();
    if (lock?.job.id !== run.id || epoch !== lock.laneEpoch) {
      return refuse(run.id, "The delivery lane moved to another holder; nothing was started.");
    }
    const laneEpoch = lock.laneEpoch;
    if (recipeStep.kind === "lifecycle") return startLifecycle(run, env, laneEpoch);
    const { command, where } = recipeStep;
    if (where === "host") {
      const refusal = hostGateRefusal(await deps.hostGate(run.commit), run.commit);
      if (refusal) return refuse(run.id, refusal);
    }
    const adapter = deps.adapters[where];
    if (!adapter) return refuse(run.id, `This installation cannot run ${where} steps.`);

    const attempt = attemptOf(run, phase);
    const startedAt = nowIso();
    let launched = false;
    const output = await adapter.run({
      commit: run.commit,
      command,
      env,
      timeoutMs: deps.stepTimeoutMs,
      async authorizeLaunch() {
        launched = await mutate((current) => {
          const target = current.delivery.runs?.[run.id];
          const expectedState = phase === "deploy" ? "running" : "verifying";
          if (!target || target.state !== expectedState || target[phase] !== null) return false;
          target[phase] = {
            phase,
            attempt,
            where,
            status: "started",
            startedAt,
            finishedAt: null,
            exitCode: null,
            laneEpoch,
            outputDigest: null,
            log: null,
            lifecycleRequest: null,
          };
          return true;
        });
        return launched;
      },
    });
    if (!launched) return true;
    await complete({ runId: run.id, phase, attempt, startedAt, output });
    return true;
  }

  async function complete(input: StepCompletion): Promise<void> {
    const { runId, phase, attempt, startedAt, output } = input;
    const log = output ? await writeLog(runId, phase, attempt, output.stdout) : null;
    const digest = output ? createHash("sha256").update(output.stdout).digest("hex") : null;
    const report = output && phase === "verify" ? parseReport(output.stdout) : null;
    await mutate((ledger) => {
      const run = ledger.delivery.runs?.[runId];
      const receipt = run?.[phase];
      // A newer attempt or a restart already settled this receipt; never overwrite it.
      const settled = receipt?.status !== "started" || receipt.attempt !== attempt;
      if (!run || !receipt || settled || receipt.startedAt !== startedAt) return;
      const at = nowIso();
      receipt.finishedAt = at;
      receipt.outputDigest = digest;
      receipt.log = log;
      if (output === null) {
        receipt.status = "unknown";
        const reason = `The ${phase} step's outcome is unknown. Check the target, then choose verify, rerun or abandon.`;
        failRun(ledger, run, { kind: "unknown", reason, at });
        return;
      }
      receipt.exitCode = output.exitCode;
      receipt.status = output.exitCode === 0 ? "succeeded" : "failed";
      if (output.exitCode !== 0) {
        const reason = `The ${phase} step exited with ${output.exitCode}; see its delivery log.`;
        failRun(ledger, run, { kind: "step-failed", reason, at });
        return;
      }
      if (phase === "deploy") {
        run.state = "verifying";
        return;
      }
      const refusal = report
        ? reportRefusal(run, report, ledger)
        : "Verification printed no release report.";
      if (refusal !== null || report === null) {
        receipt.status = "failed";
        const reason = refusal ?? "Verification printed no release report.";
        failRun(ledger, run, { kind: "step-failed", reason, at });
        return;
      }
      run.report = report;
      deliver({ ledger, run, report, laneEpoch: receipt.laneEpoch, at });
    });
  }

  function deliver(input: Delivered): void {
    const { ledger, run, report, laneEpoch, at } = input;
    const event = releaseEvent(run, report, at);
    ledger.delivery.receipts.push({
      jobId: run.id,
      kind: JOB_KIND[run.kind],
      commits: [run.commit],
      target: CHANNEL[run.kind],
      verifiedAt: at,
      verification: `The verify step reported ${event.version}.`,
      outcome: "delivered",
      laneEpoch,
      notesUrl: null,
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
      await deps.notify({
        kind: "beta-notice",
        runId: run.id,
        commit: run.commit,
        notBefore,
      });
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
      ledger.delivery.lock = lockFor(
        current,
        deps.installation,
        epoch,
        deps.now(),
        deps.stepTimeoutMs * 2,
      );
      current.state = "running";
      current.waitingOn = null;
      return true;
    });
  }

  async function pollLifecycle(run: DeliveryRun): Promise<boolean> {
    const requestId = run.deploy?.lifecycleRequest;
    if (!deps.lifecycle || !requestId) return refuse(run.id, "The lifecycle request is missing.");
    const status = await deps.lifecycle.status(requestId);
    if (status.kind === "pending") return false;
    await mutate((ledger) => {
      const current = ledger.delivery.runs?.[run.id];
      if (!current?.deploy || current.state !== "awaiting-approval") return;
      const at = nowIso();
      current.deploy.finishedAt = at;
      if (status.kind === "refused") {
        current.deploy.status = "failed";
        failRun(ledger, current, {
          kind: "step-failed",
          reason: status.reason,
          at,
        });
        return;
      }
      current.deploy.status = "succeeded";
      current.state = "verifying";
    });
    return true;
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
      case "running": {
        const deploy = run.deploy;
        if (deploy === null) return launch(run, "deploy");
        const proven = deploy.status === "unknown" && run.acceptUnknownDeploy;
        if (deploy.status !== "succeeded" && !proven) return false;
        await mutate((current) => {
          const target = current.delivery.runs?.[run.id];
          if (target?.state === "running") target.state = "verifying";
        });
        return true;
      }
      case "awaiting-approval":
        return pollLifecycle(run);
      case "verifying":
        return run.verify === null ? launch(run, "verify") : false;
      case "delivered":
      case "failed":
        return false;
    }
  }

  /** One deterministic pass: moves the queue until it waits. Concurrent calls share one pass. */
  function advance(): Promise<void> {
    inFlight ??= (async () => {
      try {
        for (let moves = 0; moves < 32 && (await step()); moves++);
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
      queue.find((run) => run.kind === "beta" && run.state === "pending" && run.deploy === null) ??
      null;
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
    hold,
    resolve,
    resume,
    advance,
    list,
    snapshot,
  };
}

export type DeliveryExecutor = ReturnType<typeof createDeliveryExecutor>;
