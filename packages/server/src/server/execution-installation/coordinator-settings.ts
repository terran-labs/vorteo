import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CoordinatorSettingsJobSchema,
  type CoordinatorFollowJob,
  type CoordinatorSettingChange,
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
import { RestartRequestError } from "./restarts.js";
import { managedServices } from "./service-control.js";

/**
 * Keys of the coordinator configuration that agents may propose changing. Every other key is
 * refused. Values of keys not marked display-safe never reach the owner interface; the owner
 * sees only that they changed. Registered values are scalars, so the owner reviews the exact
 * value rather than an opaque object.
 *
 * Never register a key that names something the coordinator executes or connects to, such as
 * `previewBroker` or `previewBrokerDeployment` (Docker, socket, Python, worker and module
 * paths with their digests). An approved patch would let an agent choose what runs with Host
 * privileges behind a JSON blob the owner cannot meaningfully review. Those keys change only
 * through their own reviewed deployment workflows, which inspect and bind each executable.
 */
export const COORDINATOR_SETTINGS: readonly {
  key: keyof InstallationConfig;
  displaySafe: boolean;
}[] = [
  { key: "claudeHostRefresh", displaySafe: true },
  { key: "codexHostRefresh", displaySafe: true },
];

/** One readiness window; a failed restart waits twice, then restores. */
const COORDINATOR_READY_TIMEOUT_MS = 120_000;
const CHANGE_DEADLINE_MS = COORDINATOR_READY_TIMEOUT_MS * 2 + 60_000;
/** How long a finished job stays in the status, so the owner sees how it ended. */
const RESULT_MS = 24 * 60 * 60_000;
const RETAINED_JOBS = 20;

const SettingsRecordSchema = CoordinatorSettingsJobSchema.extend({
  /** The exact patch, values included. Never leaves the coordinator. */
  patch: z.record(z.string(), z.unknown()),
  /** SHA-256 of the configuration written in place, once the change started. */
  appliedSha256: z.string().optional(),
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
  deadlineMs: number;
  warn(message: string): void;
}

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
  const { patch: _patch, appliedSha256: _applied, ...job } = record;
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

  request(input: CoordinatorSettingsRequest): CoordinatorSettingsJob {
    const blocker = this.blocker() ?? this.ports.conflict();
    if (blocker) throw new RestartRequestError(blocker);
    if (this.jobs.some(isActive))
      throw new RestartRequestError("A coordinator settings change is already waiting or running");
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
    const changes = keys
      .filter((key) => JSON.stringify(current[key] ?? null) !== JSON.stringify(input.patch[key]))
      .map((key) => this.change(key, current[key], input.patch[key]));
    if (changes.length === 0) throw new RestartRequestError("The patch changes nothing");
    const record = SettingsRecordSchema.parse({
      id: randomUUID(),
      revision: randomUUID(),
      createdAt: this.ports.now().toISOString(),
      status: "pending",
      detail: "Waiting for owner approval.",
      baseSha256: input.baseSha256,
      changes,
      ...(input.requester ? { requester: input.requester } : {}),
      patch: input.patch,
    });
    this.jobs = [...this.jobs, record];
    this.journal.write(this.jobs);
    return project(record);
  }

  decide(
    id: string,
    revision: string,
    decision: CoordinatorSettingsDecision["decision"],
  ): CoordinatorSettingsJob {
    const job = this.reviewed(id, revision);
    if (decision === "approve" && job.status === "pending") {
      this.refuseStale(job);
      const conflict = this.ports.conflict();
      if (conflict) throw new RestartRequestError(conflict);
      return project(
        this.save(job, {
          status: "approved",
          approvedAt: this.ports.now().toISOString(),
          approvedWith: undefined,
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
  ): CoordinatorSettingsJob {
    const job = this.reviewed(id, revision);
    if (job.status !== "pending")
      throw new RestartRequestError(
        `A coordinator settings change that is ${job.status} cannot be approved`,
      );
    this.refuseStale(job);
    const follow = approveFollow();
    return project(
      this.save(job, {
        approvedWith: follow.id,
        detail: "Approved with the coordinator update. Applies after it succeeds.",
      }),
    );
  }

  /** Advances a linked approval, starts an approved job or follows a running one. */
  drain(): void {
    this.settleLinkedApproval();
    const job = this.jobs.find((item) => item.status === "approved" || item.status === "running");
    if (job?.status === "approved") this.dispatch(job);
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

  private dispatch(job: SettingsRecord): void {
    const refusal = this.blocker() ?? this.ports.conflict();
    if (refusal) {
      this.finish(job, "failed", refusal);
      return;
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
      // An unreadable outcome or configuration must not throw on every drain forever.
      this.finish(
        job,
        "failed",
        `The coordinator restart could not be followed: ${message(error)}. Check coordinator.json before another change.`,
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
    // Registered keys hold scalars; an object would hide its contents from the owner.
    if (typeof value === "object")
      throw new RestartRequestError(`"${key}" has an invalid value: expected a single value`);
    const parsed = InstallationConfigSchema.shape[entry.key].safeParse(value);
    if (value === undefined || !parsed.success)
      throw new RestartRequestError(
        `"${key}" has an invalid value${parsed.success ? "" : `: ${parsed.error.issues[0]?.message}`}`,
      );
  }

  private change(key: string, before: unknown, after: unknown): CoordinatorSettingChange {
    const displaySafe = COORDINATOR_SETTINGS.find((item) => item.key === key)!.displaySafe;
    if (!displaySafe) return { key, displaySafe };
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
  ): SettingsRecord {
    return this.save(job, { status, detail, finishedAt: this.ports.now().toISOString() });
  }

  private save(job: SettingsRecord, changes: Partial<SettingsRecord>): SettingsRecord {
    const next = SettingsRecordSchema.parse({ ...job, ...changes, revision: randomUUID() });
    this.jobs = this.jobs.map((item) => (item.id === job.id ? next : item));
    this.journal.write(this.jobs);
    return next;
  }
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
    deadlineMs: CHANGE_DEADLINE_MS,
    warn: input.warn,
  });
}
