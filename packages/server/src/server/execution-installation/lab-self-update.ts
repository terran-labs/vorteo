import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LabUpdateSchema,
  LabUpdateStepNameSchema,
  type LabUpdate,
  type LabUpdateRequest,
  type LabUpdateStep,
  type LabUpdateStepName,
} from "@getpaseo/protocol/lab-self-update";
import type { HandoffOutcome } from "./coordinator-handoff.js";
import { RestartRequestError } from "./restarts.js";

/**
 * Lab self-update: rebuild the coordinator and Host daemon from the live checkout and switch to
 * them, on an installation whose type is Lab. It follows the release upgrade pattern
 * (release-upgrades.ts): one journal, steps advanced by the coordinator's drain, every effect
 * recorded before it starts so a coordinator restarted mid-job resumes from its record.
 *
 * - build: copy-on-write clone of the live checkout into a new release directory, then the
 *   server build. Runs beside the drain; cancellable while it runs.
 * - host: points host-current at the new release, then restarts the Host daemon through a
 *   tracked restart queue job, so the restart shows in Installation controls with its own
 *   status, finish-turns hold and cancellation. A failed or cancelled restart points the link
 *   back at the previous release (and restarts onto it when the daemon may have moved).
 * - coordinator: the existing coordinator-swap handoff, which rolls coordinator-current back
 *   itself when the new coordinator does not come up.
 *
 * Approval is the installation type: Lab approves its own self-updates, Stable refuses them.
 */
export const LAB_UPDATE_STEPS = LabUpdateStepNameSchema.options;

const LabPrivateSchema = z.strictObject({
  rollbackRestartId: z.string().uuid().optional(),
  coordinatorLaunchedAt: z.string().datetime().optional(),
  /** When the Host service itself restarted, so a resumed job never restarts it twice. */
  hostServiceRestartedAt: z.string().datetime().optional(),
});

const LabRecordSchema = LabUpdateSchema.extend({ private: LabPrivateSchema });
type LabRecord = z.infer<typeof LabRecordSchema>;

const LabJournalSchema = z.strictObject({
  version: z.literal(1),
  updates: z.array(LabRecordSchema),
});

const RETAINED_UPDATES = 20;

export interface LabUpdateJournal {
  read(): Promise<LabRecord[]>;
  write(updates: LabRecord[]): Promise<void>;
}

export function createLabUpdateJournal(directory: string): LabUpdateJournal {
  const file = path.join(directory, "journal.json");
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return LabJournalSchema.parse(JSON.parse(text)).updates;
    },
    async write(updates) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.journal.json.${process.pid}.${randomUUID()}`);
      try {
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, updates: updates.slice(-RETAINED_UPDATES) }, null, 2),
          { mode: 0o600 },
        );
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  };
}

export interface LabHostRestartState {
  status: "running" | "succeeded" | "failed" | "cancelled";
  detail: string;
}

export interface LabUpdatePorts {
  now(): Date;
  /** Why lab self-updates cannot run here now (Stable type included), or null. */
  blocker(): Promise<string | null>;
  /** Another lifecycle operation that must finish first, such as a release upgrade, or null. */
  conflict(): string | null;
  /** Reads the live checkout's HEAD, branch and dirty files, with their claimants. */
  inspectSource(): Promise<NonNullable<LabUpdate["source"]>>;
  /**
   * Clones the live checkout into a new release directory and builds it. Returns the release.
   * A rerun after a coordinator restart starts over in a fresh directory.
   */
  build(update: LabUpdate, signal: AbortSignal): Promise<string>;
  /** The release host-current selects now. */
  hostRelease(): Promise<string>;
  /** The release coordinator-current selects now. */
  coordinatorRelease(): Promise<string>;
  /** The release this coordinator process runs from. */
  runningRelease(): Promise<string>;
  pointHostLink(release: string): Promise<void>;
  /** Creates and approves a tracked Host restart; returns its restart queue ID. */
  requestHostRestart(update: LabUpdate, reason: string): string;
  hostRestart(jobId: string): LabHostRestartState;
  /**
   * Restarts the Host service itself. The tracked restart only replaces the daemon's worker,
   * which its supervisor relaunches from the release it resolved when it started; the service
   * restart makes the supervisor resolve host-current again.
   */
  restartHostService(): Promise<void>;
  /** Cancels the tracked Host restart before dispatch; false when it already dispatched. */
  cancelHostRestart(jobId: string): boolean;
  launchCoordinatorSwap(update: LabUpdate, next: string, previous: string): void;
  coordinatorOutcome(updateId: string): HandoffOutcome | null;
  coordinatorDeadlineMs: number;
  /** Removes old lab releases, keeping these. Errors are the port's to log. */
  prune(keep: string[]): Promise<void>;
}

type StepResult =
  | { status: "waiting"; detail?: string }
  | {
      status: Exclude<LabUpdateStep["status"], "pending" | "running">;
      detail: string;
      /** Ends the job as cancelled rather than failed. */
      cancelled?: boolean;
    };

interface LabBuild {
  controller: AbortController;
  settled?: StepResult;
  release?: string;
}

const ACTIVE = new Set<LabUpdate["status"]>(["approved", "running"]);

function project(record: LabRecord): LabUpdate {
  const { private: _private, ...update } = record;
  return update;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unfinished(step: LabUpdateStep): boolean {
  return step.status === "pending" || step.status === "running";
}

export class LabSelfUpdates {
  private records: LabRecord[] = [];
  private loaded: Promise<void> | null = null;
  /** Journal mutations run one at a time, so requests and drains never interleave. */
  private tail: Promise<unknown> = Promise.resolve();
  private draining = false;
  /** In-process builds by update ID. A build lost to a restart is started again. */
  private readonly builds = new Map<string, LabBuild>();

  constructor(
    private readonly journal: LabUpdateJournal,
    private readonly ports: LabUpdatePorts,
  ) {}

  private load(): Promise<void> {
    this.loaded ??= this.journal.read().then((records) => {
      this.records = records;
      return undefined;
    });
    return this.loaded;
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.load();
      return action();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  async list(): Promise<LabUpdate[]> {
    await this.load();
    return this.records.map(project).toReversed();
  }

  async get(id: string): Promise<LabUpdate | null> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    return record ? project(record) : null;
  }

  async active(): Promise<LabUpdate | null> {
    await this.load();
    const record = this.activeRecord();
    return record ? project(record) : null;
  }

  private activeRecord(): LabRecord | undefined {
    return this.records.find((item) => ACTIVE.has(item.status));
  }

  private latest(id: string): LabRecord {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error("Lab update disappeared");
    return record;
  }

  private async save(record: LabRecord, changes: Partial<LabRecord>): Promise<LabRecord> {
    const next = LabRecordSchema.parse({ ...record, ...changes, revision: randomUUID() });
    this.records = this.records.map((item) => (item.id === record.id ? next : item));
    await this.journal.write(this.records);
    return next;
  }

  /**
   * Records an approved update. The approval is the Lab installation type; Stable refuses.
   * Nothing runs until the next drain.
   */
  request(input: LabUpdateRequest, requestedBy: LabUpdate["requestedBy"]): Promise<LabUpdate> {
    return this.exclusive(async () => {
      const blocker = await this.ports.blocker();
      if (blocker) throw new RestartRequestError(blocker);
      const conflict = this.ports.conflict();
      if (conflict) throw new RestartRequestError(conflict);
      if (this.activeRecord())
        throw new RestartRequestError("Another lab self-update is already running");
      if (input.rollbackOf) {
        const original = this.records.find((item) => item.id === input.rollbackOf);
        if (!original) throw new RestartRequestError("The lab update to roll back was not found");
        if (!original.previous.host || !original.previous.coordinator)
          throw new RestartRequestError("That lab update recorded no previous releases to restore");
      }
      const now = this.ports.now().toISOString();
      const rollback = Boolean(input.rollbackOf);
      const record = LabRecordSchema.parse({
        id: randomUUID(),
        revision: randomUUID(),
        kind: rollback ? "rollback" : "update",
        ...(input.rollbackOf ? { rollbackOf: input.rollbackOf } : {}),
        status: "approved",
        detail: "Approved by the Lab installation type. Starting.",
        reason:
          input.reason ??
          (rollback ? "Roll back a lab self-update." : "Rebuild from the live checkout."),
        requestedBy,
        ...(input.requester ? { requester: input.requester } : {}),
        createdAt: now,
        approval: { policy: "lab-installation-type", installationType: "lab", decidedAt: now },
        source: null,
        release: null,
        // Filled from the links as the host and coordinator steps start.
        previous: { host: null, coordinator: null },
        steps: LAB_UPDATE_STEPS.map((name) => ({ name, status: "pending", detail: "" })),
        private: {},
      });
      this.records = [...this.records, record];
      await this.journal.write(this.records);
      return project(record);
    });
  }

  /**
   * Cancels a running update while nothing has restarted: during the build, or while the
   * tracked Host restart still waits. A dispatched restart or coordinator swap cannot be
   * cancelled; request a rollback instead.
   */
  cancel(id: string, revision: string): Promise<LabUpdate> {
    return this.exclusive(async () => {
      const record = this.records.find((item) => item.id === id);
      if (!record) throw new RestartRequestError("Lab update not found");
      if (record.revision !== revision)
        throw new RestartRequestError("The lab update changed. Review it again.");
      if (!ACTIVE.has(record.status))
        throw new RestartRequestError(`A lab update that is ${record.status} cannot be cancelled`);
      const step = record.steps.find(unfinished);
      if (step?.name === "coordinator")
        throw new RestartRequestError(
          "The Host already restarted on the new release. Request a rollback instead.",
        );
      if (step?.name === "host" && record.hostRestartId) {
        if (!this.ports.cancelHostRestart(record.hostRestartId))
          throw new RestartRequestError(
            "The Host restart already dispatched. Request a rollback instead.",
          );
        // The host step sees the cancelled restart and restores the link on its next drain.
        return project(record);
      }
      this.builds.get(id)?.controller.abort();
      this.builds.delete(id);
      return project(
        await this.save(record, {
          status: "cancelled",
          detail: "Cancelled by the owner before anything restarted.",
          finishedAt: this.ports.now().toISOString(),
          steps: record.steps.map((item) =>
            unfinished(item)
              ? { name: item.name, status: "skipped" as const, detail: "Not run." }
              : item,
          ),
        }),
      );
    });
  }

  /** Advances the active update as far as it can go now. Safe to call repeatedly. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const advanced = await this.exclusive(async () => {
          const record = this.activeRecord();
          return record ? this.advance(record) : false;
        });
        if (!advanced) return;
      }
    } finally {
      this.draining = false;
    }
  }

  private async advance(input: LabRecord): Promise<boolean> {
    let record = input;
    if (record.status === "approved")
      record = await this.save(record, { status: "running", detail: "Lab self-update running." });
    const index = record.steps.findIndex(unfinished);
    if (index === -1) {
      await this.finish(record, "succeeded", this.successDetail(record));
      return false;
    }
    const step = record.steps[index];
    if (step.status === "pending")
      record = await this.saveStep(record, index, {
        status: "running",
        detail: "",
        startedAt: this.ports.now().toISOString(),
      });
    let result: StepResult;
    try {
      result = await this.run(step.name, record);
    } catch (error) {
      result = { status: "failed", detail: message(error) };
    }
    const latest = this.latest(record.id);
    if (result.status === "waiting") {
      if (result.detail && result.detail !== latest.steps[index].detail)
        await this.save(latest, {
          steps: this.stepsWith(latest, index, { detail: result.detail }),
        });
      return false;
    }
    const steps = this.stepsWith(latest, index, {
      status: result.status,
      detail: result.detail,
      finishedAt: this.ports.now().toISOString(),
    });
    if (result.status !== "failed" && result.status !== "rolled-back") {
      await this.save(latest, { steps });
      return true;
    }
    await this.finish(
      await this.save(latest, { steps: this.skipRemaining(steps, index) }),
      result.cancelled ? "cancelled" : "failed",
      result.detail,
    );
    return false;
  }

  private async finish(
    record: LabRecord,
    status: LabUpdate["status"],
    detail: string,
  ): Promise<void> {
    const finished = await this.save(record, {
      status,
      detail,
      finishedAt: this.ports.now().toISOString(),
    });
    if (status !== "succeeded") return;
    try {
      const keep = [
        finished.release,
        finished.previous.host,
        finished.previous.coordinator,
        await this.ports.hostRelease(),
        await this.ports.coordinatorRelease(),
      ];
      await this.ports.prune(keep.filter((item): item is string => Boolean(item)));
    } catch {
      /* Pruning is housekeeping; the update already succeeded. */
    }
  }

  private successDetail(record: LabRecord): string {
    if (record.kind === "rollback") return "Rolled back to the previous releases.";
    const head = record.source?.head?.slice(0, 12) ?? "the live checkout";
    const dirty = record.source?.dirty.length ?? 0;
    return dirty
      ? `The Host daemon and coordinator run ${head} with ${dirty} uncommitted file${dirty === 1 ? "" : "s"}.`
      : `The Host daemon and coordinator run ${head}.`;
  }

  private stepsWith(record: LabRecord, index: number, changes: Partial<LabUpdateStep>) {
    return record.steps.map((step, position) =>
      position === index ? Object.assign({}, step, changes) : step,
    );
  }

  private skipRemaining(steps: LabUpdateStep[], index: number): LabUpdateStep[] {
    return steps.map((step, position) =>
      position > index
        ? Object.assign({}, step, { status: "skipped" as const, detail: "Not run." })
        : step,
    );
  }

  private saveStep(record: LabRecord, index: number, changes: Partial<LabUpdateStep>) {
    return this.save(record, { steps: this.stepsWith(record, index, changes) });
  }

  private run(name: LabUpdateStepName, record: LabRecord): Promise<StepResult> {
    switch (name) {
      case "build":
        return this.runBuild(record);
      case "host":
        return this.runHost(record);
      case "coordinator":
        return this.runCoordinator(record);
    }
  }

  private async runBuild(record: LabRecord): Promise<StepResult> {
    if (record.kind === "rollback")
      return { status: "skipped", detail: "A rollback reselects existing releases." };
    const running = this.builds.get(record.id);
    if (running?.settled) {
      this.builds.delete(record.id);
      if (running.release) await this.save(this.latest(record.id), { release: running.release });
      return running.settled;
    }
    if (running) return { status: "waiting" };
    // A new build, or one a coordinator restart interrupted: (re)start it.
    const blocker = await this.ports.blocker();
    if (blocker) return { status: "failed", detail: blocker };
    const source = await this.ports.inspectSource();
    const withSource = await this.save(this.latest(record.id), { source });
    const entry: LabBuild = { controller: new AbortController() };
    this.builds.set(record.id, entry);
    this.ports.build(project(withSource), entry.controller.signal).then(
      (release) => {
        entry.release = release;
        entry.settled = { status: "succeeded", detail: `Built ${path.basename(release)}.` };
        return undefined;
      },
      (error: unknown) => {
        entry.settled = entry.controller.signal.aborted
          ? { status: "failed", detail: "Cancelled by the owner.", cancelled: true }
          : {
              status: "failed",
              detail: `The build failed: ${message(error)} The running releases stay selected.`,
            };
      },
    );
    const head = source.head?.slice(0, 12) ?? "the live checkout";
    const dirty = source.dirty.length;
    return {
      status: "waiting",
      detail: dirty
        ? `Building ${head} with ${dirty} uncommitted file${dirty === 1 ? "" : "s"}.`
        : `Building ${head}.`,
    };
  }

  /** The releases this job selects for each link. */
  private targets(record: LabRecord): { host: string | null; coordinator: string | null } {
    if (record.kind === "rollback") {
      const original = this.records.find((item) => item.id === record.rollbackOf);
      return {
        host: original?.previous.host ?? null,
        coordinator: original?.previous.coordinator ?? null,
      };
    }
    return { host: record.release, coordinator: record.release };
  }

  private async runHost(input: LabRecord): Promise<StepResult> {
    let record = input;
    const target = this.targets(record).host;
    if (!target) return { status: "failed", detail: "No Host release to select." };
    const jobId = record.hostRestartId;
    if (!jobId) {
      // Recorded before the link moves, so a failure always knows where to return.
      const previousHost = await this.ports.hostRelease();
      record = await this.save(record, { previous: { ...record.previous, host: previousHost } });
      if (previousHost === target)
        return { status: "skipped", detail: "The Host daemon already runs this release." };
      await this.ports.pointHostLink(target);
      const restartId = this.ports.requestHostRestart(
        project(record),
        record.kind === "rollback"
          ? `Lab self-update rollback (${record.id}): restart the Host daemon on the previous release.`
          : `Lab self-update (${record.id}): restart the Host daemon on the release built from the live checkout.`,
      );
      await this.save(this.latest(record.id), { hostRestartId: restartId });
      return {
        status: "waiting",
        detail: "Waiting for the tracked Host restart. Current turns finish first when supported.",
      };
    }
    const restart = this.ports.hostRestart(jobId);
    if (restart.status === "running") return { status: "waiting", detail: restart.detail };
    if (restart.status === "succeeded") return this.restartHostService(record);
    // Failed or cancelled: put the previous release back.
    const restore = record.previous.host;
    if (restore) await this.ports.pointHostLink(restore);
    if (restart.status === "cancelled")
      return {
        status: "rolled-back",
        detail:
          "The Host restart was cancelled before it ran. The previous release is selected again.",
        cancelled: true,
      };
    if (restore && !record.private.rollbackRestartId) {
      // The daemon may have come up on the new release before failing; restart it onto the old.
      try {
        const rollbackId = this.ports.requestHostRestart(
          project(record),
          `Lab self-update rollback (${record.id}): the Host restart failed; restart on the previous release.`,
        );
        await this.save(this.latest(record.id), {
          private: { ...record.private, rollbackRestartId: rollbackId },
        });
      } catch (error) {
        return {
          status: "failed",
          detail: `The Host restart failed (${restart.detail}). The previous release is selected again, but its restart could not be requested (${message(error)}).`,
        };
      }
    }
    return {
      status: "rolled-back",
      detail: `The Host restart failed (${restart.detail}). The previous release is selected again and a tracked restart onto it was requested.`,
    };
  }

  /**
   * The tracked restart finished current turns and replaced the worker; the service restart
   * that follows moves the supervisor onto the selected release. Without it the job would
   * report success while the Host still ran the previous release.
   */
  private async restartHostService(record: LabRecord): Promise<StepResult> {
    if (!record.private.hostServiceRestartedAt) {
      try {
        await this.ports.restartHostService();
      } catch (error) {
        const restore = record.previous.host;
        if (restore) await this.ports.pointHostLink(restore);
        return {
          status: "failed",
          detail: `The Host service did not restart (${message(error)}). The previous release is selected again; the Host keeps running it.`,
        };
      }
      await this.save(this.latest(record.id), {
        private: { ...record.private, hostServiceRestartedAt: this.ports.now().toISOString() },
      });
    }
    return { status: "succeeded", detail: "The Host service restarted on the selected release." };
  }

  private async runCoordinator(input: LabRecord): Promise<StepResult> {
    let record = input;
    const next = this.targets(record).coordinator;
    if (!next) return { status: "failed", detail: "No coordinator release to select." };
    const launchedAt = record.private.coordinatorLaunchedAt;
    if (!launchedAt) {
      const previous = await this.ports.coordinatorRelease();
      if (previous === next && (await this.ports.runningRelease()) === next)
        return { status: "succeeded", detail: "The coordinator already runs this release." };
      // Recorded before the launch: the handoff restarts this process.
      record = await this.save(record, {
        previous: { ...record.previous, coordinator: previous },
        private: { ...record.private, coordinatorLaunchedAt: this.ports.now().toISOString() },
      });
      this.ports.launchCoordinatorSwap(project(record), next, previous);
      return { status: "waiting", detail: "Restarting the coordinator on the new release." };
    }
    const outcome = this.ports.coordinatorOutcome(record.id);
    if (outcome?.status === "succeeded") return { status: "succeeded", detail: outcome.detail };
    if (outcome?.status === "rolled-back")
      return {
        status: "rolled-back",
        detail: `${outcome.detail} The Host daemon keeps the new release; request a rollback to restore it too.`,
      };
    if (outcome?.status === "failed") return { status: "failed", detail: outcome.detail };
    const elapsed = this.ports.now().getTime() - Date.parse(launchedAt);
    if (elapsed < this.ports.coordinatorDeadlineMs) return { status: "waiting" };
    return (await this.ports.runningRelease()) === next
      ? { status: "succeeded", detail: "The coordinator runs the new release." }
      : {
          status: "failed",
          detail: "The coordinator handoff did not report and the previous coordinator is running.",
        };
  }
}
