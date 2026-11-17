import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import {
  CoordinatorSettingsJobSchema,
  type CoordinatorFollowJob,
  type CoordinatorSettingChange,
  type CoordinatorSettingField,
  type CoordinatorSettingsDecision,
  type CoordinatorSettingsJob,
  type CoordinatorSettingsRequest,
  type CoordinatorSettingsStatus,
} from "@getpaseo/protocol/installation-upgrades";
import { writePrivateFileAtomicSync } from "../private-files.js";
import {
  InstallationConfigSchema,
  readInstallationConfig,
  type InstallationConfig,
} from "./config.js";
import {
  handoffLaunchBlocker,
  launchHandoff,
  readHandoffOutcome,
  restoreFileAtomically,
  type CoordinatorConfigPlan,
  type HandoffOutcome,
} from "./coordinator-handoff.js";
import {
  BrokerReviewUnavailable,
  isBrokerSetting,
  reviewBrokerSettings,
  type BrokerSettingsReviewPorts,
  type BrokerSettingsReviewResult,
} from "./coordinator-broker-settings.js";
import type { BrokerSetting } from "./preview-broker-configuration-checks.js";
import { RestartRequestError } from "./restarts.js";
import {
  delegatedAdmissionStep,
  delegatedApproval,
  delegatedDispatchHolds,
  delegatedPlanDigest,
  type DelegationGrant,
} from "./delegated-admission.js";
import { inspectBootstrapWritableMountRoots } from "./coordinator-bootstrap-host.js";
import { verifyBrokerExecutorInputs } from "./preview-broker-configuration-checks.js";
import { managedServices } from "./service-control.js";

/**
 * Keys of the coordinator configuration that agents may propose changing. Every other key is
 * refused. Values of keys not marked display-safe never reach the owner interface; the owner
 * sees only that they changed. Plain registered values are scalars, so the owner reviews the
 * exact value rather than an opaque object.
 *
 * Never register a plain key that names something the coordinator executes or connects to.
 * An approved patch would let an agent choose what runs with Host privileges behind a value
 * the owner cannot meaningfully review. The broker keys are registered as `reviewed: "broker"`
 * instead: `reviewBrokerSettings` pins their Docker endpoint, Dev container, interpreters and
 * placement to what the installation already records, confines their code to installer-managed
 * releases, and hashes every file itself, at request and again at dispatch. The owner then
 * reviews each changed field as a path and digest prefix verified on disk.
 */
export const COORDINATOR_SETTINGS: readonly {
  key: keyof InstallationConfig;
  displaySafe: boolean;
  reviewed?: "broker";
}[] = [
  { key: "claudeHostRefresh", displaySafe: true },
  { key: "codexHostRefresh", displaySafe: true },
  { key: "previewBrokerDeployment", displaySafe: true, reviewed: "broker" },
  { key: "previewBroker", displaySafe: true, reviewed: "broker" },
];

const execFileAsync = promisify(execFile);

/** One readiness window; a failed restart waits twice, then restores. */
const COORDINATOR_READY_TIMEOUT_MS = 120_000;
const CHANGE_DEADLINE_MS = COORDINATOR_READY_TIMEOUT_MS * 2 + 60_000;
/** How long a finished job stays in the status, so the owner sees how it ended. */
const RESULT_MS = 24 * 60 * 60_000;
const RETAINED_JOBS = 20;
/** Dispatch reviews that may fail to run before an approved broker change fails. */
const REVIEW_ATTEMPTS = 3;

const SettingsRecordSchema = CoordinatorSettingsJobSchema.extend({
  /** The exact patch, values included. Never leaves the coordinator. */
  patch: z.record(z.string(), z.unknown()),
  /** SHA-256 of the configuration written in place, once the change started. */
  appliedSha256: z.string().optional(),
  /** Dispatch reviews that could not run, such as a Docker inspection timeout. */
  reviewAttempts: z.number().int().nonnegative().optional(),
  /** The recorded participant scope was kept before dispatch minted a new one. */
  scopeKept: z.literal(true).optional(),
});
type SettingsRecord = z.infer<typeof SettingsRecordSchema>;

const JournalSchema = z.strictObject({
  version: z.literal(1),
  jobs: z.array(SettingsRecordSchema),
});

export interface CoordinatorSettingsJournal {
  /** Throws when the journal is corrupt or written by a newer coordinator. */
  read(): SettingsRecord[];
  write(jobs: SettingsRecord[]): void;
  /** Moves an unreadable journal aside and returns where it went. */
  quarantine(): string;
}

export function createCoordinatorSettingsJournal(directory: string): CoordinatorSettingsJournal {
  const file = path.join(directory, "journal.json");
  return {
    read: () =>
      existsSync(file) ? JournalSchema.parse(JSON.parse(readFileSync(file, "utf8"))).jobs : [],
    quarantine: () => {
      const moved = `${file}.unreadable-${Date.now()}`;
      renameSync(file, moved);
      return moved;
    },
    write: (jobs) =>
      writePrivateFileAtomicSync(
        file,
        JSON.stringify({ version: 1, jobs: jobs.slice(-RETAINED_JOBS) }, null, 2),
      ),
  };
}

export interface CoordinatorSettingsPorts {
  now(): Date;
  /** Null when this coordinator can change its own configuration; otherwise why not. */
  blocker: string | null;
  /** The configuration file's current text. */
  readConfig(): string;
  /** The startup validation the next coordinator runs; throws when the text is refused. */
  validate(text: string): void;
  /** SHA-256 of the configuration this process started with, when known. */
  runningSha256: string | null;
  /**
   * Why another coordinator restart or lifecycle job keeps a change from starting now, or
   * null. Checked at request, approval and dispatch.
   */
  conflict(): string | null;
  followJob(id: string): CoordinatorFollowJob | null;
  /** Keeps `previous` as the job's backup, then replaces the configuration with `next`. */
  writeConfig(jobId: string, previous: string, next: string): void;
  /** Puts the job's backup back in place. */
  restoreConfig(jobId: string): void;
  /** Why the handoff cannot start on this machine, such as a missing helper, or null. */
  launchBlocker(): string | null;
  /**
   * Starts the detached coordinator-config handoff; it restarts this process. A spawn that
   * fails after returning reports through `onError`.
   */
  launch(jobId: string, onError: (error: Error) => void): void;
  outcome(jobId: string): HandoffOutcome | null;
  /** Keeps the participant scope at `file`, or that it was absent, once per job. */
  keepScope(jobId: string, file: string): void;
  /** Puts the kept participant scope back, if one was kept. */
  restoreScope(jobId: string): void;
  /**
   * Reviews reviewed broker keys of `candidate` against the files on disk and the values
   * `current` records, and returns each key's changed fields. Throws when any is refused.
   */
  reviewBroker(input: {
    keys: BrokerSetting[];
    current: string;
    candidate: string;
    phase: "request" | "dispatch";
  }): Promise<BrokerSettingsReviewResult>;
  deadlineMs: number;
  warn(message: string): void;
  /** The active full maintenance grant, read fresh; null when none applies. */
  delegationGrant?(): DelegationGrant | null;
  /** The cancellation window before delegated work starts. */
  cancellationDelayMs?: number;
}

/** The operation names full delegation checks against OWNER_ONLY_OPERATIONS. */
const settingsOperations = (job: SettingsRecord) =>
  Object.keys(job.patch).map((key) => `coordinator-settings:${key}`);
/** Binds a delegated approval to the exact request: its base and patch as proposed. */
const settingsPlan = (job: SettingsRecord) =>
  delegatedPlanDigest("coordinator-settings", { baseSha256: job.baseSha256, patch: job.patch });

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActive(job: { status: CoordinatorSettingsJob["status"] }): boolean {
  return ["pending", "approved", "running"].includes(job.status);
}

function merge(text: string, patch: Record<string, unknown>): string {
  const next = JSON.parse(text) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

function project(record: SettingsRecord): CoordinatorSettingsJob {
  const {
    patch: _patch,
    appliedSha256: _applied,
    reviewAttempts: _attempts,
    scopeKept: _kept,
    ...job
  } = record;
  return job;
}

/**
 * Agent-proposed, owner-approved changes to registered keys of the coordinator's own
 * configuration file. A change is bound to the SHA-256 of the file it was prepared against and
 * refused if the file changed. Applying it keeps the previous file as a backup, writes the new
 * one in place and starts the coordinator-config handoff, which restarts the coordinator and
 * restores the backup if it does not answer. Every transition is journaled before its effect,
 * so the coordinator that starts next resumes the job from the handoff's outcome.
 */
export class CoordinatorSettings {
  private jobs: SettingsRecord[] = [];
  /** The drain in progress; dispatch awaits file checks, so drains must not overlap. */
  private draining: Promise<void> | null = null;
  /** Set when the journal could not be read; changes stay off until the next start. */
  private journalProblem: string | null = null;

  constructor(
    private readonly journal: CoordinatorSettingsJournal,
    private readonly ports: CoordinatorSettingsPorts,
  ) {
    try {
      this.jobs = journal.read();
    } catch (error) {
      // A corrupt or newer journal must not keep the coordinator from starting.
      let moved = "it could not be moved aside";
      try {
        moved = `it was moved to ${path.basename(journal.quarantine())}`;
      } catch (moveError) {
        moved = `${moved} (${message(moveError)})`;
      }
      this.journalProblem = `The coordinator settings journal could not be read (${message(error)}); ${moved}. Check coordinator.json, then restart the coordinator to accept changes again.`;
      ports.warn(this.journalProblem);
    }
  }

  private blocker(): string | null {
    return this.journalProblem ?? this.ports.blocker;
  }

  /** The current configuration's hash, which a request must name as its base. */
  base(): { sha256: string } {
    const blocker = this.blocker();
    if (blocker) throw new RestartRequestError(blocker);
    return { sha256: sha256(this.ports.readConfig()) };
  }

  /** The job approved or running. Coordinator updates and upgrades must not start beside it. */
  dispatching(): CoordinatorSettingsJob | null {
    const job = this.jobs.find((item) => item.status === "approved" || item.status === "running");
    return job ? project(job) : null;
  }

  /** Every retained job, for installation management. */
  list(): CoordinatorSettingsJob[] {
    return this.jobs.map(project);
  }

  get(id: string): CoordinatorSettingsJob | null {
    const job = this.jobs.find((item) => item.id === id);
    return job ? project(job) : null;
  }

  status(): CoordinatorSettingsStatus {
    const blocker = this.blocker();
    return {
      available: blocker === null,
      detail: blocker ?? "Registered coordinator settings can change after owner approval.",
      job: this.shownJob(),
    };
  }

  async request(input: CoordinatorSettingsRequest): Promise<CoordinatorSettingsJob> {
    this.refuseRequest();
    const keys = Object.keys(input.patch);
    if (keys.length === 0) throw new RestartRequestError("The patch changes no settings");
    for (const key of keys) this.validateEntry(key, input.patch[key]);
    const text = this.ports.readConfig();
    if (sha256(text) !== input.baseSha256)
      throw new RestartRequestError(
        "The coordinator configuration changed since the patch was prepared. Fetch the base hash again.",
      );
    const candidate = merge(text, input.patch);
    try {
      this.ports.validate(candidate);
    } catch (error) {
      throw new RestartRequestError(`The changed configuration is invalid: ${message(error)}`);
    }
    const current = JSON.parse(text) as Record<string, unknown>;
    const changed = keys.filter(
      (key) => JSON.stringify(current[key] ?? null) !== JSON.stringify(input.patch[key]),
    );
    if (changed.length === 0) throw new RestartRequestError("The patch changes nothing");
    const brokerKeys = changed.filter(isBrokerSetting);
    let fields: Record<string, CoordinatorSettingField[]> = {};
    // Unchanged keys are dropped, so an unchanged broker key never needs a field review.
    let patch = Object.fromEntries(changed.map((key) => [key, input.patch[key]]));
    if (brokerKeys.length > 0) {
      try {
        const review = await this.ports.reviewBroker({
          keys: brokerKeys,
          current: text,
          candidate,
          phase: "request",
        });
        fields = review.fields;
        // The coordinator fills in values it derives itself, such as the minted scope digest.
        patch = { ...patch, ...review.values };
        this.ports.validate(merge(text, patch));
      } catch (error) {
        throw new RestartRequestError(`The broker settings were refused: ${message(error)}`);
      }
      // The review read files asynchronously; nothing may have started or changed meanwhile.
      this.refuseRequest();
      if (sha256(this.ports.readConfig()) !== input.baseSha256)
        throw new RestartRequestError(
          "The coordinator configuration changed since the patch was prepared. Fetch the base hash again.",
        );
    }
    const changes = changed.map((key) => this.change(key, current[key], patch[key], fields));
    const record = SettingsRecordSchema.parse({
      id: randomUUID(),
      revision: randomUUID(),
      createdAt: this.ports.now().toISOString(),
      status: "pending",
      detail: "Waiting for owner approval.",
      baseSha256: input.baseSha256,
      changes,
      ...(input.requester ? { requester: input.requester } : {}),
      patch,
    });
    this.jobs = [...this.jobs, record];
    this.journal.write(this.jobs);
    return project(record);
  }

  private refuseRequest(): void {
    const blocker = this.blocker() ?? this.ports.conflict();
    if (blocker) throw new RestartRequestError(blocker);
    if (this.jobs.some(isActive))
      throw new RestartRequestError("A coordinator settings change is already waiting or running");
  }

  decide(
    id: string,
    revision: string,
    decision: CoordinatorSettingsDecision["decision"],
    client: { reviewedFields?: boolean } = {},
  ): CoordinatorSettingsJob {
    const job = this.reviewed(id, revision);
    if (decision === "approve" && job.status === "pending") {
      this.refuseBlindApproval(job, client);
      this.refuseStale(job);
      const conflict = this.ports.conflict();
      if (conflict) throw new RestartRequestError(conflict);
      return project(
        this.save(job, {
          status: "approved",
          approvedAt: this.ports.now().toISOString(),
          approvedWith: undefined,
          delegatedApproval: undefined,
          detail: "Approved. Starting.",
        }),
      );
    }
    if (decision === "reject" && job.status === "pending")
      return project(this.finish(job, "rejected", "Rejected by the owner."));
    if (decision === "cancel" && (job.status === "pending" || job.status === "approved"))
      return project(this.finish(job, "cancelled", "Cancelled by the owner."));
    throw new RestartRequestError(
      `A coordinator settings change that is ${job.status} cannot be changed that way`,
    );
  }

  /**
   * One owner decision for a coordinator update and this change: `approveFollow` approves the
   * update, and this change is approved by that same decision once the update succeeds.
   */
  approveWithFollow(
    id: string,
    revision: string,
    approveFollow: () => CoordinatorFollowJob,
    client: { reviewedFields?: boolean } = {},
  ): CoordinatorSettingsJob {
    const job = this.reviewed(id, revision);
    if (job.status !== "pending")
      throw new RestartRequestError(
        `A coordinator settings change that is ${job.status} cannot be approved`,
      );
    this.refuseBlindApproval(job, client);
    this.refuseStale(job);
    const follow = approveFollow();
    return project(
      this.save(job, {
        approvedWith: follow.id,
        // The owner's approval replaces a delegated one, so a later revocation cannot cancel it.
        delegatedApproval: undefined,
        detail: "Approved with the coordinator update. Applies after it succeeds.",
      }),
    );
  }

  /**
   * An owner interface that cannot show per-field changes renders reviewed broker keys as
   * "hidden → changed", so its approval would be blind.
   */
  private refuseBlindApproval(job: SettingsRecord, client: { reviewedFields?: boolean }): void {
    // COMPAT(coordinatorSettingFields): added in 26.11.6, remove after 2027-05-07 once every owner app sends reviewedFields.
    if (Object.keys(job.patch).some(isBrokerSetting) && client.reviewedFields !== true)
      throw new RestartRequestError(
        "Update Vorteo to review these broker settings field by field before approving them.",
      );
  }

  /** Advances a linked approval, starts an approved job or follows a running one. */
  drain(): Promise<void> {
    this.draining ??= this.drainOnce().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    this.settleLinkedApproval();
    this.admitDelegated();
    const job = this.jobs.find((item) => item.status === "approved" || item.status === "running");
    if (job?.status === "approved") await this.dispatch(job);
    else if (job?.status === "running") this.track(job);
  }

  private settleLinkedApproval(): void {
    const job = this.jobs.find((item) => item.status === "pending" && item.approvedWith);
    if (!job?.approvedWith) return;
    const follow = this.ports.followJob(job.approvedWith);
    if (follow?.status === "succeeded") {
      this.save(job, {
        status: "approved",
        approvedAt: this.ports.now().toISOString(),
        detail: "The coordinator update succeeded. Applying the settings.",
      });
      return;
    }
    if (follow && isActive(follow)) return;
    this.save(job, {
      approvedWith: undefined,
      detail:
        "The coordinator update did not succeed, so these settings were not applied. Review and approve them again.",
    });
  }

  /**
   * Full maintenance delegation approves a fresh Host-agent change for exactly its base and
   * patch, after the cancellation window. It stays pending until then, so the owner can still
   * cancel it and a rollback runtime that ignores the evidence waits for the owner. There is no
   * owner interface to render broker fields, so the broker review that runs at request runs
   * again at dispatch, as for every approval.
   */
  private admitDelegated(): void {
    const job = this.jobs.find((item) => item.status === "pending" && !item.approvedWith);
    if (!job) return;
    const now = this.ports.now().getTime();
    const grant = this.ports.delegationGrant?.() ?? null;
    // Only authenticated Host agents can request settings changes.
    const step = delegatedAdmissionStep(
      { ...job, requestedBy: "host-agent" },
      {
        grant,
        operations: settingsOperations(job),
        planSha256: settingsPlan(job),
        now,
      },
    );
    if (step === "attach" && grant) {
      const revision = randomUUID();
      const approval = delegatedApproval(grant, {
        requestRevision: revision,
        planSha256: settingsPlan(job),
        now,
        cancellationDelayMs: this.ports.cancellationDelayMs ?? 30_000,
      });
      this.save(job, {
        revision,
        delegatedApproval: approval,
        detail: `Approved under owner maintenance delegation. Starts after ${approval.dispatchAfter} unless cancelled.`,
      });
    } else if (step === "invalid") {
      this.finish(
        job,
        "cancelled",
        "Delegated approval changed before dispatch. Nothing was applied.",
      );
    } else if (step === "ready") {
      const refusal = this.staleOrBlocked(job);
      if (refusal) {
        this.finish(job, "cancelled", refusal);
        return;
      }
      this.save(job, {
        status: "approved",
        approvedAt: this.ports.now().toISOString(),
        detail: "Approved under owner maintenance delegation. Starting.",
      });
    }
  }

  /**
   * Cancels a change the full grant approved when that grant no longer holds: revoked, renewed,
   * credentials rotated or its keys newly excluded. The plan was bound at admission; the broker
   * review completes it with coordinator-computed digests afterwards. Owner approvals pass.
   */
  private delegationLapsed(job: SettingsRecord): boolean {
    if (
      delegatedDispatchHolds(job.delegatedApproval, this.ports.delegationGrant?.() ?? null, {
        operations: settingsOperations(job),
      })
    )
      return false;
    this.restoreKeptScope(job);
    this.finish(
      job,
      "cancelled",
      "Delegated approval changed before dispatch. Nothing was applied.",
    );
    return true;
  }

  /** Why a pending change cannot be approved now, without throwing. */
  private staleOrBlocked(job: SettingsRecord): string | null {
    const blocker = this.blocker() ?? this.ports.conflict();
    if (blocker) return blocker;
    try {
      if (sha256(this.ports.readConfig()) !== job.baseSha256)
        return "The coordinator configuration changed after this change was prepared. Ask for it again.";
    } catch (error) {
      return `The coordinator configuration could not be read: ${message(error)}`;
    }
    return null;
  }

  private async dispatch(approved: SettingsRecord): Promise<void> {
    let job = approved;
    if (this.delegationLapsed(job)) return;
    const refusal = this.blocker() ?? this.ports.conflict();
    if (refusal) {
      this.finish(job, "failed", refusal);
      return;
    }
    if (Object.keys(job.patch).some(isBrokerSetting)) {
      const reviewed = await this.reviewAtDispatch(job);
      if (!reviewed) return;
      job = reviewed;
      // The grant may have been revoked or the credentials rotated during the review.
      if (this.delegationLapsed(job)) return;
    }
    let text: string;
    let candidate: string;
    try {
      text = this.ports.readConfig();
      if (sha256(text) !== job.baseSha256) {
        this.finish(
          job,
          "failed",
          "The coordinator configuration changed after this change was reviewed. Nothing was applied.",
        );
        return;
      }
      candidate = merge(text, job.patch);
      this.ports.validate(candidate);
    } catch (error) {
      this.finish(job, "failed", `The changed configuration is invalid: ${message(error)}`);
      return;
    }
    const launchBlocker = this.ports.launchBlocker();
    if (launchBlocker) {
      this.finish(job, "failed", `${launchBlocker} Nothing was applied.`);
      return;
    }
    if (this.delegationLapsed(job)) return;
    // Recorded before any effect: the handoff restarts this process.
    const running = this.save(job, {
      status: "running",
      startedAt: this.ports.now().toISOString(),
      appliedSha256: sha256(candidate),
      detail: "Restarting the coordinator with the new settings.",
    });
    try {
      this.ports.writeConfig(job.id, text, candidate);
    } catch (error) {
      this.finish(running, "failed", `The configuration could not be written: ${message(error)}`);
      return;
    }
    try {
      this.ports.launch(job.id, (error) => this.launchFailed(job.id, error));
    } catch (error) {
      this.launchFailed(job.id, error);
    }
  }

  /**
   * Gates the change before minting, keeps the scope, then reviews every broker file again.
   * Returns the job to apply, or null when it was finished, kept for a retry or cancelled.
   */
  private async reviewAtDispatch(approved: SettingsRecord): Promise<SettingsRecord | null> {
    let job = approved;
    const brokerKeys = Object.keys(job.patch).filter(isBrokerSetting);
    // Every gate that needs no broker review runs first: minting changes the scope file.
    const early = this.applyBlocker(job);
    if (early) {
      this.finish(job, "failed", early);
      return null;
    }
    const scope = (job.patch.previewBrokerDeployment as { scope?: { path?: unknown } } | null)
      ?.scope?.path;
    if (typeof scope === "string") {
      this.ports.keepScope(job.id, scope);
      job = this.save(job, { scopeKept: true });
    }
    // Hash and confine every broker file again: one swapped after approval is refused.
    let review: BrokerSettingsReviewResult;
    try {
      const text = this.ports.readConfig();
      review = await this.ports.reviewBroker({
        keys: brokerKeys,
        current: text,
        candidate: merge(text, job.patch),
        phase: "dispatch",
      });
    } catch (error) {
      const latest = this.jobs.find((item) => item.id === job.id);
      if (latest?.status !== "approved") {
        this.restoreKeptScope(job);
        return null;
      }
      const attempts = (latest.reviewAttempts ?? 0) + 1;
      // A check that could not run stays approved and runs again on the next drain.
      if (error instanceof BrokerReviewUnavailable && attempts < REVIEW_ATTEMPTS) {
        this.restoreKeptScope(latest);
        this.save(latest, {
          reviewAttempts: attempts,
          detail: `Approved. Waiting to check the broker files again: ${message(error)}`,
        });
        return null;
      }
      this.finish(
        latest,
        "failed",
        `The broker settings no longer pass review: ${message(error)}. Nothing was applied.`,
      );
      return null;
    }
    // The owner may have cancelled, or another restart started, during the review.
    const latest = this.jobs.find((item) => item.id === job.id);
    if (latest?.status !== "approved") {
      // A cancel finished the job before the scope was minted; put it back again.
      this.restoreKeptScope(job);
      return null;
    }
    // The participant scope was minted at its recorded path; apply its digest.
    job = this.save(latest, { patch: { ...latest.patch, ...review.values } });
    const conflict = this.blocker() ?? this.ports.conflict();
    if (conflict) {
      this.finish(job, "failed", conflict);
      return null;
    }
    return job;
  }

  /** Why an approved change cannot apply now, before any broker review or effect. */
  private applyBlocker(job: SettingsRecord): string | null {
    try {
      if (sha256(this.ports.readConfig()) !== job.baseSha256)
        return "The coordinator configuration changed after this change was reviewed. Nothing was applied.";
    } catch (error) {
      return `The coordinator configuration could not be read: ${message(error)}`;
    }
    const launchBlocker = this.ports.launchBlocker();
    return launchBlocker ? `${launchBlocker} Nothing was applied.` : null;
  }

  /** Restores the kept participant scope; a failure is reported, never thrown. */
  private restoreKeptScope(job: SettingsRecord): void {
    if (!job.scopeKept) return;
    try {
      this.ports.restoreScope(job.id);
    } catch (error) {
      this.ports.warn(`The participant scope could not be restored: ${message(error)}`);
    }
  }

  /** Nothing restarted: put the running configuration back on disk and fail the job. */
  private launchFailed(jobId: string, error: unknown): void {
    const job = this.jobs.find((item) => item.id === jobId);
    if (job?.status !== "running") return;
    let restored = "nothing changed";
    try {
      this.ports.restoreConfig(jobId);
    } catch (restoreError) {
      restored = `restoring the previous configuration also failed: ${message(restoreError)}`;
    }
    this.finish(
      job,
      "failed",
      `The coordinator restart could not start; ${restored} (${message(error)}).`,
    );
  }

  private track(job: SettingsRecord): void {
    try {
      this.trackEffects(job);
    } catch (error) {
      // An unreadable outcome or configuration must not throw on every drain forever. When this
      // coordinator already runs the new configuration, it pins the minted scope digest, so the
      // minted scope stays.
      this.finish(
        job,
        "failed",
        `The coordinator restart could not be followed: ${message(error)}. Check coordinator.json before another change.`,
        { scopeApplied: this.ports.runningSha256 === job.appliedSha256 },
      );
    }
  }

  private trackEffects(job: SettingsRecord): void {
    const outcome = this.ports.outcome(job.id);
    if (outcome) {
      this.finish(job, outcome.status, outcome.detail);
      return;
    }
    const elapsed = this.ports.now().getTime() - Date.parse(job.startedAt ?? job.createdAt);
    if (elapsed < this.ports.deadlineMs) return;
    // The handoff never reported. Judge by the configuration this process started with.
    if (this.ports.runningSha256 === job.appliedSha256) {
      this.finish(job, "succeeded", "The coordinator runs the new settings.");
      return;
    }
    // Keep the file on disk matching the coordinator that runs.
    if (sha256(this.ports.readConfig()) === job.appliedSha256) this.ports.restoreConfig(job.id);
    this.finish(
      job,
      "failed",
      "The coordinator restart never reported and the previous settings are running.",
    );
  }

  private validateEntry(key: string, value: unknown): void {
    const entry = COORDINATOR_SETTINGS.find((item) => item.key === key);
    if (!entry)
      throw new RestartRequestError(`"${key}" is not a coordinator setting that can change here`);
    if (value === null) return;
    if (entry.reviewed === "broker") {
      // Structured, but every field is reviewed against disk and recorded values.
      const parsed = InstallationConfigSchema.shape[entry.key].safeParse(value);
      if (typeof value !== "object" || !parsed.success)
        throw new RestartRequestError(
          `"${key}" has an invalid value${parsed.success ? "" : `: ${parsed.error.issues[0]?.message}`}`,
        );
      return;
    }
    // Plain registered keys hold scalars; an object would hide its contents from the owner.
    if (typeof value === "object")
      throw new RestartRequestError(`"${key}" has an invalid value: expected a single value`);
    const parsed = InstallationConfigSchema.shape[entry.key].safeParse(value);
    if (value === undefined || !parsed.success)
      throw new RestartRequestError(
        `"${key}" has an invalid value${parsed.success ? "" : `: ${parsed.error.issues[0]?.message}`}`,
      );
  }

  private change(
    key: string,
    before: unknown,
    after: unknown,
    fields: Record<string, CoordinatorSettingField[]>,
  ): CoordinatorSettingChange {
    const entry = COORDINATOR_SETTINGS.find((item) => item.key === key)!;
    const { displaySafe } = entry;
    if (!displaySafe) return { key, displaySafe };
    // Older interfaces see "hidden → changed"; newer ones show each field.
    if (entry.reviewed === "broker") return { key, displaySafe, fields: fields[key] ?? [] };
    return {
      key,
      displaySafe,
      before: before === undefined ? null : JSON.stringify(before),
      after: after === null ? null : JSON.stringify(after),
    };
  }

  private reviewed(id: string, revision: string): SettingsRecord {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new RestartRequestError("Coordinator settings change not found");
    if (job.revision !== revision)
      throw new RestartRequestError("The coordinator settings change changed. Review it again.");
    return job;
  }

  /** Cancels and refuses a change whose base configuration no longer applies. */
  private refuseStale(job: SettingsRecord): void {
    const blocker = this.blocker();
    if (blocker) throw new RestartRequestError(blocker);
    if (sha256(this.ports.readConfig()) === job.baseSha256) return;
    const detail =
      "The coordinator configuration changed after this change was prepared. Ask for it again.";
    this.finish(job, "cancelled", detail);
    throw new RestartRequestError(detail);
  }

  private shownJob(): CoordinatorSettingsJob | null {
    const active = this.jobs.find(isActive);
    if (active) return project(active);
    const latest = this.jobs.at(-1);
    if (!latest?.finishedAt) return null;
    const age = this.ports.now().getTime() - Date.parse(latest.finishedAt);
    return age < RESULT_MS ? project(latest) : null;
  }

  private finish(
    job: SettingsRecord,
    status: CoordinatorSettingsJob["status"],
    detail: string,
    options: { scopeApplied?: boolean } = {},
  ): SettingsRecord {
    // Anything that does not apply the change leaves the recorded scope as it was, including
    // a handoff that rolls the coordinator back to the previous configuration.
    if (status !== "succeeded" && !options.scopeApplied) this.restoreKeptScope(job);
    return this.save(job, { status, detail, finishedAt: this.ports.now().toISOString() });
  }

  private save(job: SettingsRecord, changes: Partial<SettingsRecord>): SettingsRecord {
    const next = SettingsRecordSchema.parse({
      ...job,
      ...changes,
      revision: changes.revision ?? randomUUID(),
    });
    this.jobs = this.jobs.map((item) => (item.id === job.id ? next : item));
    this.journal.write(this.jobs);
    return next;
  }
}

/** Docker mount inspection, executor probes and scope writes on the macOS Host. */
function nativeBrokerReview(directory: string): BrokerSettingsReviewPorts {
  return {
    writableMountRoots: (connection) => inspectBootstrapWritableMountRoots(connection),
    coordinatorNode: () => process.execPath,
    async executorInputs({ settings, config, writableMountRoots }) {
      // The deployment executor rereads the candidate as a protected, hash-pinned file.
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const text = `${JSON.stringify(config, null, 2)}\n`;
      const file = path.join(directory, `coordinator.json.review-${randomUUID()}`);
      await writeFile(file, text, { mode: 0o600, flag: "wx" });
      try {
        await verifyBrokerExecutorInputs({
          settings,
          config,
          configurationFile: { path: await realpath(file), sha256: sha256(text) },
          writableMountRoots,
        });
      } finally {
        await rm(file, { force: true });
      }
    },
    now: () => new Date(),
    randomUUID,
    async bootUUID() {
      const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        timeout: 10_000,
      });
      return stdout.trim();
    },
    reviewScopeFile: () => path.join(directory, `participant-scope.review-${randomUUID()}.json`),
    removeFile: (file) => rm(file, { force: true }),
    async writeScope(file, text) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Replace atomically beside the pinned path; the rename never follows a planted link.
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}`);
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      try {
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  };
}

/**
 * Keeps a job's participant scope bytes, or that the file was absent, in its private work
 * folder before dispatch mints a new scope, and puts them back atomically. The first kept copy
 * is never overwritten, so retries cannot keep a minted scope instead of the original.
 */
export function createScopeCustody(work: (jobId: string) => string) {
  const kept = (jobId: string) => path.join(work(jobId), "participant-scope.before");
  const target = (jobId: string) => path.join(work(jobId), "participant-scope.path");
  // Stage the bytes beside the file, then rename over it, as the scope was written: the
  // rename stays on the scope's volume and replaces a planted link instead of following it.
  const replace = (file: string, bytes: Buffer) => {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}`);
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  };
  return {
    keepScope(jobId: string, file: string) {
      if (existsSync(target(jobId))) return;
      mkdirSync(work(jobId), { recursive: true, mode: 0o700 });
      if (existsSync(file)) writePrivateFileAtomicSync(kept(jobId), readFileSync(file));
      // Written last: its presence means the kept state is complete.
      writePrivateFileAtomicSync(target(jobId), file);
    },
    restoreScope(jobId: string) {
      if (!existsSync(target(jobId))) return;
      const file = readFileSync(target(jobId), "utf8");
      if (existsSync(kept(jobId))) replace(file, readFileSync(kept(jobId)));
      else rmSync(file, { force: true });
    },
  };
}

/** Why this coordinator cannot change its own configuration, or null. */
function settingsBlocker(config: InstallationConfig, configFile: string | undefined) {
  if (!configFile) return "This coordinator was started without its configuration file.";
  if (!config.deployment?.coordinator?.releaseLink)
    return "Only installations made by the one-command installer change coordinator settings here.";
  const services = managedServices(config);
  return typeof services === "string" ? services : null;
}

export function createCoordinatorSettings(input: {
  config: InstallationConfig;
  configFile: string | undefined;
  /** SHA-256 of the exact bytes the coordinator parsed at startup. */
  startupSha256: string | undefined;
  conflict(): string | null;
  followJob(id: string): CoordinatorFollowJob | null;
  warn(message: string): void;
  entrypoint?: string;
  /** Replaces the native Docker inspection and executor probes; tests only. */
  brokerReview?: BrokerSettingsReviewPorts;
  /** The active full maintenance grant; a Host-agent change is delegated under it. */
  delegationGrant?: () => DelegationGrant | null;
}): CoordinatorSettings {
  const { config, configFile } = input;
  const directory = path.join(config.stateDir, "coordinator-settings");
  const work = (jobId: string) => path.join(directory, jobId);
  const backup = (jobId: string) => path.join(work(jobId), "coordinator.json.before");
  const blocker = settingsBlocker(config, configFile);
  const readConfig = () => readFileSync(configFile!, "utf8");
  const helper = () =>
    path.join(
      path.dirname(realpathSync(input.entrypoint ?? process.argv[1]!)),
      "coordinator-handoff-main.js",
    );
  return new CoordinatorSettings(createCoordinatorSettingsJournal(directory), {
    now: () => new Date(),
    blocker,
    readConfig,
    validate(text) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const candidate = path.join(directory, "coordinator.json.candidate");
      writePrivateFileAtomicSync(candidate, text);
      try {
        // The full startup validation the next coordinator runs, before anything is replaced.
        const validated = readInstallationConfig(candidate);
        if (validated.public.installationId !== config.public.installationId)
          throw new Error("The candidate configuration names a different installation");
      } finally {
        rmSync(candidate, { force: true });
      }
    },
    // Unknown without the startup bytes: a handoff that never reports is then judged failed.
    runningSha256: input.startupSha256 ?? null,
    conflict: input.conflict,
    followJob: input.followJob,
    delegationGrant: () => input.delegationGrant?.() ?? null,
    cancellationDelayMs: 30_000,
    writeConfig(jobId, previous, next) {
      mkdirSync(work(jobId), { recursive: true, mode: 0o700 });
      writePrivateFileAtomicSync(backup(jobId), previous);
      writePrivateFileAtomicSync(configFile!, next);
    },
    restoreConfig: (jobId) => restoreFileAtomically(backup(jobId), configFile!),
    launchBlocker() {
      const services = managedServices(config);
      if (typeof services === "string") return services;
      try {
        return handoffLaunchBlocker({ node: process.execPath, helper: helper(), services });
      } catch (error) {
        return `The coordinator handoff helper cannot be found: ${message(error)}.`;
      }
    },
    launch(jobId, onError) {
      const services = managedServices(config);
      if (typeof services === "string") throw new Error(services);
      const plan: CoordinatorConfigPlan = {
        kind: "coordinator-config",
        id: jobId,
        configFile: configFile!,
        backupFile: backup(jobId),
        services,
        health: {
          url: `http://127.0.0.1:${config.listenPort}/api/installation/health`,
          installationId: config.public.installationId,
          previousPid: process.pid,
        },
        outcomeFile: path.join(work(jobId), "outcome.json"),
        timeoutMs: COORDINATOR_READY_TIMEOUT_MS,
      };
      launchHandoff({
        node: process.execPath,
        helper: helper(),
        planFile: path.join(work(jobId), "plan.json"),
        logFile: path.join(work(jobId), "handoff.log"),
        plan,
        onError,
      });
    },
    outcome: (jobId) => readHandoffOutcome(path.join(work(jobId), "outcome.json")),
    ...createScopeCustody(work),
    reviewBroker: ({ keys, current, candidate, phase }) =>
      reviewBrokerSettings(
        {
          keys,
          current: InstallationConfigSchema.parse(JSON.parse(current)),
          candidate: InstallationConfigSchema.parse(JSON.parse(candidate)),
          phase,
        },
        input.brokerReview ?? nativeBrokerReview(directory),
      ),
    deadlineMs: CHANGE_DEADLINE_MS,
    warn: input.warn,
  });
}
