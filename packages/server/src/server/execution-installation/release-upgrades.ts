import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CoordinatorFollowJobSchema,
  InstallationUpgradeSchema,
  ReleaseTagSchema,
  SourceUpgradeSchema,
  UpgradeStepNameSchema,
  type AgentUpdateStatus,
  type CoordinatorFollowDecision,
  type CoordinatorFollowJob,
  type CoordinatorFollowStatus,
  type InstallationUpgrade,
  type ReleaseNotes,
  type SourceUpgrade,
  type SourceUpgradeDecision,
  type SourceUpgradeStatus,
  type UpgradeDecision,
  type UpgradeStep,
  type UpgradeStepName,
} from "@getpaseo/protocol/installation-upgrades";
import { writePrivateFileAtomicSync } from "../private-files.js";
import type { HandoffOutcome } from "./coordinator-handoff.js";
import { RestartRequestError } from "./restarts.js";
import {
  delegableUnderGrant,
  delegatedAdmissionStep,
  delegatedApproval,
  delegatedApprovalHolds,
  delegatedDispatchHolds,
  delegatedPlanDigest,
  type DelegationEvidence,
  type DelegationGrant,
} from "./delegated-admission.js";

/**
 * Owner-approved upgrades to one tested GitHub release or one reviewed commit on `main`. Steps
 * run in order: snapshot, fetch, Host build and restart, coordinator replacement, Dev image.
 * An installation made before the one-command installer first moves to its layout
 * inside the snapshot step (see `runAdoption`), since snapshots need that layout.
 * Every transition is written to the journal before its effect starts, so a
 * coordinator that restarts mid-upgrade (including the planned restart during
 * coordinator replacement) resumes the running step from its recorded state.
 */
export const UPGRADE_STEPS = UpgradeStepNameSchema.options;

/** Coordinator-private step state. Projected out of every reply. */
const UpgradePrivateSchema = z.strictObject({
  adoptionLaunchedAt: z.string().datetime().optional(),
  // Tracked restart jobs use UUIDs; installer-made Hosts build releases directly as
  // `installer-<upgrade id>` (see release-upgrade-runtime.ts). Refusing that ID failed every
  // save, so the coordinator relaunched the Host build on each tick and the upgrade never ended.
  hostJobId: z
    .union([
      z.string().uuid(),
      z.string().regex(/^installer-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
    ])
    .optional(),
  coordinatorNext: z.string().startsWith("/").optional(),
  coordinatorPrevious: z.string().startsWith("/").optional(),
  coordinatorLaunchedAt: z.string().datetime().optional(),
  devPreviousImage: z.string().min(1).optional(),
  devImage: z.string().min(1).optional(),
  devReplacing: z.boolean().optional(),
  /** "release" restarts only Dev's daemon on a Host-built release; "image" recreates Dev. */
  devMode: z.enum(["release", "image"]).optional(),
  /** The Dev release selected before the upgrade, or "none" for the image's own daemon. */
  devPreviousRelease: z.string().min(1).optional(),
  devReleaseBuilt: z.boolean().optional(),
  /** When the Host release build that runs before any restart was launched. */
  hostBuildLaunchedAt: z.string().datetime().optional(),
});
type UpgradePrivate = z.infer<typeof UpgradePrivateSchema>;

/**
 * Release and source upgrade records share every step. Each kind has its own journal file, so a
 * coordinator rolled back to a release without source upgrades never reads a record it refuses.
 */
const UpgradeRecordSchema = z.union([
  InstallationUpgradeSchema.extend({ private: UpgradePrivateSchema }),
  SourceUpgradeSchema.extend({ private: UpgradePrivateSchema }),
]);
type UpgradeRecord = z.infer<typeof UpgradeRecordSchema>;

/** A release upgrade or a source upgrade, as replies show it. */
export type UpgradeJob = InstallationUpgrade | SourceUpgrade;

export function isSourceUpgrade(job: UpgradeJob): job is SourceUpgrade {
  return "kind" in job && job.kind === "source-upgrade";
}

function isReleaseUpgrade(job: UpgradeJob): job is InstallationUpgrade {
  return !isSourceUpgrade(job);
}

/** How details name the target: its release tag, or the short commit. */
export function upgradeTarget(job: UpgradeJob): string {
  return isSourceUpgrade(job) ? `commit ${job.sourceCommit.slice(0, 12)}` : job.release;
}

/** Why a rollback can no longer run because its 24-hour window ended, or null. */
function rollbackExpired(job: UpgradeJob, now: Date): string | null {
  if (!isSourceUpgrade(job) || !job.rollbackUntil) return null;
  return now.getTime() >= Date.parse(job.rollbackUntil)
    ? "The 24-hour rollback window has ended."
    : null;
}

function automatic(job: UpgradeJob): boolean {
  return isReleaseUpgrade(job) && job.automatic === true;
}

const UpgradeJournalSchema = z.strictObject({
  version: z.literal(1),
  upgrades: z.array(UpgradeRecordSchema),
});

const RETAINED_UPGRADES = 20;

/**
 * Release-mode Dev keys, dropped once a step that used them ends so a coordinator rolled
 * back to a release that predates them can still read the journal.
 */
const FORGET_DEV_BUILD = {
  devMode: undefined,
  devPreviousRelease: undefined,
  devReleaseBuilt: undefined,
  hostBuildLaunchedAt: undefined,
} satisfies Partial<UpgradePrivate>;

export interface UpgradeJournal {
  read(): UpgradeRecord[];
  write(upgrades: UpgradeRecord[]): void;
}

export function createUpgradeJournal(directory: string): UpgradeJournal {
  const file = path.join(directory, "journal.json");
  return {
    read: () =>
      existsSync(file)
        ? UpgradeJournalSchema.parse(JSON.parse(readFileSync(file, "utf8"))).upgrades
        : [],
    write: (upgrades) =>
      writePrivateFileAtomicSync(
        file,
        JSON.stringify({ version: 1, upgrades: upgrades.slice(-RETAINED_UPGRADES) }, null, 2),
      ),
  };
}

/** What the installer engine's in-place adoption wrote when it finished. */
export interface AdoptionOutcome {
  status: "succeeded" | "failed";
  detail: string;
}

export interface UpgradePorts {
  now(): Date;
  /** Why another installation operation keeps an upgrade from starting now, or null. */
  conflict(): string | null;
  /** True while this installation predates the installer layout (no `deployment`). */
  adoptionRequired: boolean;
  /** Starts the installer engine's in-place adoption, detached; it restarts this coordinator. */
  launchAdoption(upgrade: UpgradeJob): void;
  adoptionOutcome(upgradeId: string): AdoptionOutcome | null;
  /** How long adoption (Dev and gate image builds included) may take before it is judged failed. */
  adoptionDeadlineMs: number;
  hasContainer: boolean;
  /** Dev exists but the installer does not manage its deployment; upgrades leave it alone. */
  devUnmanaged?: boolean;
  /** Null when the coordinator can replace itself; otherwise why it cannot. */
  coordinatorReplacement: string | null;
  /** Installed Host source commit. */
  currentCommit(): string | null;
  /** The commit a release tag names on GitHub. */
  resolveRelease(release: string): Promise<string>;
  /** Takes a safety snapshot and prunes old ones; returns its id. */
  snapshot(upgrade: UpgradeJob): Promise<string>;
  /** Fetches the tag into the source directory and checks it still names sourceCommit. */
  fetchRelease(upgrade: UpgradeJob): Promise<void>;
  /** False once the owner has turned automatic updates off. */
  automaticAllowed(): boolean;
  /** True when the installer engine, not a restart-queue source update, restarts the Host. */
  directHost: boolean;
  /**
   * True when that engine can build the Host release without restarting it, so the Host
   * and Dev builds finish before the first restart. Older engines build and restart at once.
   */
  directHostBuild: boolean;
  /** Starts the build-only Host release for the upgrade, detached. */
  launchHostBuild(upgrade: UpgradeJob): void;
  /** How long the build-only Host release may run before the upgrade fails. */
  hostBuildDeadlineMs: number;
  hostBuild(upgradeId: string): { status: "running" | "succeeded" | "failed"; detail: string };
  /** Null when no agent on the target is working or starting; otherwise what still runs. */
  busy(target: "host" | "container-daemon"): Promise<string | null>;
  /** Stages the release as a Host source update and approves it in the restart queue. */
  requestHostUpdate(upgrade: UpgradeJob): Promise<string>;
  hostUpdate(jobId: string): { status: "running" | "succeeded" | "failed"; detail: string };
  /** The Host release directory selected now. */
  hostRelease(): string;
  /** The release this coordinator process runs from. */
  runningRelease(): string;
  /** The release the coordinator service link selects. */
  coordinatorRelease(): string;
  launchCoordinatorSwap(upgrade: UpgradeJob, next: string, previous: string): void;
  coordinatorOutcome(upgradeId: string): HandoffOutcome | null;
  /** How long the swap helper may take before the step is judged from the link alone. */
  coordinatorDeadlineMs: number;
  /**
   * Refreshes Dev's deployment scripts from the release, then answers whether Dev can move
   * by swapping only its daemon release ("release") or needs a new image ("image").
   */
  prepareDev(upgrade: UpgradeJob): Promise<"release" | "image">;
  /** The same answer without touching Dev's deployment, for builds before any restart. */
  devUpgradeMode(upgrade: UpgradeJob): Promise<"release" | "image">;
  /** Copies the release's deployment scripts into Dev's deployment. */
  refreshDevScripts(upgrade: UpgradeJob): Promise<void>;
  /** False when Docker no longer has the image, such as after a prune. */
  hasDevImage(image: string): Promise<boolean>;
  /** The selected Dev release's commit, or "none" when Dev runs its image's own daemon. */
  devRelease(): Promise<string>;
  /** Builds the upgrade's Dev release on the Host; reuses one already built. */
  buildDevRelease(upgrade: UpgradeJob): Promise<void>;
  /** Restarts Dev's daemon on a release, or "none". Throws when Dev does not become healthy. */
  selectDevRelease(release: string): Promise<void>;
  /** Removes old Dev releases, keeping the selected, previous and newest ones. */
  pruneDevReleases(): Promise<void>;
  devImage(): Promise<string>;
  buildDevImage(upgrade: UpgradeJob): Promise<string>;
  /** Recreates Dev on an image. Throws when Dev does not become healthy. */
  replaceDevImage(image: string): Promise<void>;
  /** Throws unless the coordinator reaches the recreated Dev daemon. */
  verifyDev(): Promise<void>;
}

type StepResult =
  | { status: "waiting"; detail?: string; private?: Partial<UpgradePrivate> }
  | {
      status: Exclude<UpgradeStep["status"], "pending" | "running">;
      detail: string;
      private?: Partial<UpgradePrivate>;
      snapshotId?: string;
    };

function project(record: UpgradeRecord): UpgradeJob {
  const { private: _private, ...upgrade } = record;
  return upgrade;
}

function upgradeIsActive(record: UpgradeJob): boolean {
  return ["pending", "approved", "running"].includes(record.status);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SwapResult = { status: "waiting" } | { status: HandoffOutcome["status"]; detail: string };

/**
 * Where a launched coordinator swap stands. The helper restarts this process, so its outcome
 * file is read by whichever coordinator runs next; one that never reports is judged after the
 * deadline by the release this process runs.
 */
function coordinatorSwapResult(
  ports: Pick<UpgradePorts, "now" | "runningRelease" | "coordinatorDeadlineMs">,
  input: { outcome: HandoffOutcome | null; launchedAt: string; next: string | undefined },
): SwapResult {
  if (input.outcome) return { status: input.outcome.status, detail: input.outcome.detail };
  const elapsed = ports.now().getTime() - Date.parse(input.launchedAt);
  if (elapsed < ports.coordinatorDeadlineMs) return { status: "waiting" };
  return ports.runningRelease() === input.next
    ? { status: "succeeded", detail: "The coordinator runs the new release." }
    : {
        status: "failed",
        detail: "The coordinator handoff did not report and the previous coordinator is running.",
      };
}

/**
 * The steps every upgrade runs, whatever it targets. Release upgrades and source upgrades each
 * keep one instance with its own journal; neither starts while the other is approved or running.
 */
abstract class UpgradePipeline<Ports extends UpgradePorts = UpgradePorts> {
  protected records: UpgradeRecord[];
  private draining = false;

  constructor(
    private readonly journal: UpgradeJournal,
    protected readonly ports: Ports,
  ) {
    this.records = journal.read();
  }

  /** Newest first. */
  protected jobs(): UpgradeJob[] {
    return this.records.map(project).toReversed();
  }

  protected activeJob(): UpgradeJob | null {
    const record = this.activeRecord();
    return record ? project(record) : null;
  }

  /** True while an upgrade is approved or running, which keeps the other kind from starting. */
  dispatching(): boolean {
    const record = this.activeRecord();
    return record !== undefined && record.status !== "pending";
  }

  protected activeRecord(): UpgradeRecord | undefined {
    return this.records.find(upgradeIsActive);
  }

  protected save(record: UpgradeRecord, changes: Partial<UpgradeRecord>): UpgradeRecord {
    const next = UpgradeRecordSchema.parse({ ...record, ...changes, revision: randomUUID() });
    this.records = this.records.map((item) => (item.id === record.id ? next : item));
    this.journal.write(this.records);
    return next;
  }

  protected add(input: UpgradeRecord): UpgradeJob {
    const record = UpgradeRecordSchema.parse(input);
    this.records = [...this.records, record];
    this.journal.write(this.records);
    return project(record);
  }

  protected refuseConflict(): void {
    const conflict = this.ports.conflict();
    if (conflict) throw new RestartRequestError(conflict);
  }

  protected refuseActive(): void {
    if (this.activeRecord())
      throw new RestartRequestError("Another upgrade is already pending or running");
  }

  /**
   * Why the upgrade must stop before its next step or before it restarts the Host, or null.
   * Restarts already started finish; nothing new restarts.
   */
  protected stepRefusal(): Promise<string | null> {
    return Promise.resolve(null);
  }

  /** Why an approval must be refused now, beyond conflicts; the record is then cancelled. */
  protected approvalRefusal(_record: UpgradeRecord): string | null {
    return null;
  }

  protected decideJob(
    id: string,
    revision: string,
    decision: UpgradeDecision["decision"],
  ): UpgradeJob {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new RestartRequestError("Upgrade not found");
    if (record.revision !== revision)
      throw new RestartRequestError("The upgrade changed. Review it again.");
    const now = this.ports.now().toISOString();
    if (
      (decision === "approve" || decision === "approve-after-work") &&
      record.status === "pending"
    ) {
      this.refuseConflict();
      const refusal = this.approvalRefusal(record);
      if (refusal) {
        this.save(record, { status: "cancelled", detail: refusal });
        throw new RestartRequestError(refusal);
      }
      return project(
        this.save(record, {
          status: "approved",
          approvedAt: now,
          restart: decision === "approve" ? "now" : "after-work",
          detail: "Approved. Starting.",
        }),
      );
    }
    // Install now on an upgrade waiting for current work: later restarts stop waiting. A Host
    // restart already queued to finish current turns is forced from Installation controls.
    if (
      decision === "approve" &&
      ["approved", "running"].includes(record.status) &&
      record.restart === "after-work"
    )
      return project(
        this.save(record, { restart: "now", detail: "The owner chose to install now." }),
      );
    if (decision === "acknowledge" && automatic(record) && !upgradeIsActive(record))
      return project(this.save(record, { acknowledgedAt: now }));
    if (decision === "reject" && record.status === "pending")
      return project(this.save(record, { status: "rejected", detail: "Rejected by the owner." }));
    if (decision === "cancel" && (record.status === "pending" || record.status === "approved"))
      return project(this.save(record, { status: "cancelled", detail: "Cancelled by the owner." }));
    throw new RestartRequestError(`An upgrade that is ${record.status} cannot be changed that way`);
  }

  /** Advances the active upgrade as far as it can go now. Safe to call repeatedly. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const record = this.activeRecord();
        if (!record || record.status === "pending") return;
        const advanced = await this.advance(record);
        if (!advanced) return;
      }
    } finally {
      this.draining = false;
    }
  }

  private async advance(input: UpgradeRecord): Promise<boolean> {
    let record = input;
    if (record.status === "approved")
      record = this.save(record, { status: "running", detail: "Upgrade running." });
    const index = record.steps.findIndex((step) => !this.finished(step));
    if (index === -1) {
      this.save(record, {
        status: "succeeded",
        detail: `Upgraded to ${upgradeTarget(record)}.`,
        private: { ...record.private, ...FORGET_DEV_BUILD },
      });
      return false;
    }
    const step = record.steps[index];
    const now = this.ports.now().toISOString();
    if (step.status === "pending")
      record = this.saveStep(record, index, { status: "running", detail: "", startedAt: now });
    let result: StepResult;
    try {
      // Checked where a step starts, so nothing new restarts once the check fails.
      const refusal = step.status === "pending" ? await this.stepRefusal() : null;
      result = refusal
        ? { status: "failed", detail: `${refusal} Nothing more was restarted.` }
        : await this.run(step.name, record);
    } catch (error) {
      result = { status: "failed", detail: message(error) };
    }
    const latest = this.records.find((item) => item.id === record.id) ?? record;
    const privateState = { ...latest.private, ...result.private };
    if (result.status === "waiting") {
      // The drain runs every few seconds; a wait that changed nothing is not rewritten.
      if (!result.private && (!result.detail || result.detail === latest.steps[index]?.detail))
        return false;
      this.save(latest, {
        private: privateState,
        ...(result.detail
          ? { steps: this.stepsWith(latest, index, { detail: result.detail }) }
          : {}),
      });
      return false;
    }
    const steps = this.stepsWith(latest, index, {
      status: result.status,
      detail: result.detail,
      finishedAt: this.ports.now().toISOString(),
    });
    const failed = result.status === "failed" || result.status === "rolled-back";
    this.save(latest, {
      // A failure skips the steps that would use and drop these keys.
      private: failed ? { ...privateState, ...FORGET_DEV_BUILD } : privateState,
      steps: failed ? this.skipRemaining(steps, index) : steps,
      ...(result.snapshotId ? { snapshotId: result.snapshotId } : {}),
      ...(failed ? { status: "failed", detail: result.detail } : {}),
    });
    return !failed;
  }

  private finished(step: UpgradeStep): boolean {
    return step.status !== "pending" && step.status !== "running";
  }

  private stepsWith(record: UpgradeRecord, index: number, changes: Partial<UpgradeStep>) {
    return record.steps.map((step, position) =>
      position === index ? { ...step, ...changes } : step,
    );
  }

  private skipRemaining(steps: UpgradeStep[], index: number): UpgradeStep[] {
    return steps.map((step, position) =>
      position > index ? { ...step, status: "skipped" as const, detail: "Not run." } : step,
    );
  }

  private saveStep(record: UpgradeRecord, index: number, changes: Partial<UpgradeStep>) {
    return this.save(record, { steps: this.stepsWith(record, index, changes) });
  }

  private run(name: UpgradeStepName, record: UpgradeRecord): Promise<StepResult> {
    switch (name) {
      case "snapshot":
        return this.runSnapshot(record);
      case "fetch":
        return this.runFetch(record);
      case "host":
        return this.runHost(record);
      case "coordinator":
        return this.runCoordinator(record);
      case "dev":
        return this.runDev(record);
    }
  }

  private async runSnapshot(record: UpgradeRecord): Promise<StepResult> {
    const adoption = this.runAdoption(record);
    if (adoption) return adoption;
    const snapshotId = await this.ports.snapshot(project(record));
    return { status: "succeeded", detail: `Snapshot ${snapshotId} saved.`, snapshotId };
  }

  /**
   * Moves an installation from before the installer to its layout: the engine adds the
   * deployment block and release links, moves Dev to gate mode and restarts this
   * coordinator, which resumes here with the new configuration. Null once that is done.
   */
  private runAdoption(record: UpgradeRecord): StepResult | null {
    const launchedAt = record.private.adoptionLaunchedAt;
    if (!launchedAt) {
      if (!this.ports.adoptionRequired) return null;
      // Recorded before the launch: the engine restarts this process.
      const launched = this.save(record, {
        private: { ...record.private, adoptionLaunchedAt: this.ports.now().toISOString() },
      });
      this.ports.launchAdoption(project(launched));
      return {
        status: "waiting",
        detail:
          "Moving this installation to the installer layout. Dev switches to gate mode and the coordinator restarts.",
      };
    }
    const outcome = this.ports.adoptionOutcome(record.id);
    if (outcome?.status === "failed")
      return {
        status: "failed",
        detail: `The installation could not move to the installer layout: ${outcome.detail}`,
      };
    if (outcome?.status === "succeeded" && !this.ports.adoptionRequired) return null;
    const elapsed = this.ports.now().getTime() - Date.parse(launchedAt);
    if (elapsed < this.ports.adoptionDeadlineMs) return { status: "waiting" };
    return {
      status: "failed",
      detail: outcome
        ? "The installation moved to the installer layout, but the coordinator did not restart on it."
        : "The move to the installer layout did not report. Its log is in the upgrade's folder.",
    };
  }

  private async runFetch(record: UpgradeRecord): Promise<StepResult> {
    const expired = rollbackExpired(record, this.ports.now());
    if (expired) return { status: "failed", detail: `${expired} Nothing was restarted.` };
    await this.ports.fetchRelease(project(record));
    return {
      status: "succeeded",
      detail: isSourceUpgrade(record)
        ? `Fetched ${record.sourceCommit} from main.`
        : `Fetched ${record.release} (${record.sourceCommit}).`,
    };
  }

  private async runHost(record: UpgradeRecord): Promise<StepResult> {
    const jobId = record.private.hostJobId;
    if (!jobId) {
      if (this.ports.currentCommit() === record.sourceCommit)
        return { status: "skipped", detail: "The Host already runs this release." };
      const changed = this.hostChanged(record);
      if (changed) return changed;
      // Turning automatic updates off stops an automatic upgrade that has not restarted anything.
      if (automatic(record) && !this.ports.automaticAllowed())
        return {
          status: "failed",
          detail:
            "Automatic updates were turned off before the Host restart. Nothing was restarted.",
        };
      // Build the Host release, then Dev's from it, before anything restarts, so agents are
      // interrupted only once every build has passed.
      // Once chosen, the build-first path is kept even if the engine on disk changes.
      const launchedAt = record.private.hostBuildLaunchedAt;
      if (launchedAt || this.ports.directHostBuild) {
        if (!launchedAt) {
          // Recorded before the launch: a coordinator that restarts in between waits for
          // that build, and fails at the deadline, instead of starting a second one.
          const launched = this.save(record, {
            private: { ...record.private, hostBuildLaunchedAt: this.ports.now().toISOString() },
          });
          this.ports.launchHostBuild(project(launched));
          return {
            status: "waiting",
            detail: "Building the Host release, then Dev's. Nothing restarts until both are built.",
          };
        }
        const build = this.ports.hostBuild(record.id);
        if (build.status === "running") {
          if (this.ports.now().getTime() - Date.parse(launchedAt) < this.ports.hostBuildDeadlineMs)
            return { status: "waiting" };
          return {
            status: "failed",
            detail: "The Host release build never reported a result. Nothing was restarted.",
          };
        }
        if (build.status === "failed")
          return {
            status: "failed",
            detail: `The Host release did not build (${build.detail}). Nothing was restarted.`,
            private: FORGET_DEV_BUILD,
          };
        try {
          await this.buildDevAhead(record);
        } catch (error) {
          return {
            status: "failed",
            detail: `Dev's build failed (${message(error)}). Nothing was restarted.`,
            private: FORGET_DEV_BUILD,
          };
        }
      }
      // The restart queue holds new work and waits on its own; the installer engine does not.
      if (record.restart === "after-work" && this.ports.directHost) {
        const busy = await this.ports.busy("host");
        if (busy) return { status: "waiting", detail: `Waiting for current Host work: ${busy}` };
      }
      const stop = await this.beforeHostRestart(record);
      if (stop) return stop;
      const created = await this.ports.requestHostUpdate(project(record));
      return {
        status: "waiting",
        detail: this.ports.directHostBuild
          ? "Restarting the Host daemon on the built release."
          : "Building the release. The Host daemon restarts when the build passes.",
        private: { hostJobId: created, hostBuildLaunchedAt: undefined },
      };
    }
    const job = this.ports.hostUpdate(jobId);
    if (job.status === "running") return { status: "waiting" };
    if (job.status === "failed") return { status: "failed", detail: job.detail };
    return { status: "succeeded", detail: job.detail };
  }

  /**
   * Admission proved the reviewed Host commit is in the target. A Host change since then, such
   * as a source update while this waited for idle agents, would be silently dropped.
   */
  private hostChanged(record: UpgradeRecord): StepResult | null {
    if (!isSourceUpgrade(record) || this.ports.currentCommit() === record.previousCommit)
      return null;
    return {
      status: "failed",
      detail:
        "The Host changed after this source upgrade was approved, so installing it could drop that change. Nothing was restarted. Request it again.",
      private: FORGET_DEV_BUILD,
    };
  }

  /** The builds before a Host restart can take an hour; check again immediately before it. */
  private async beforeHostRestart(record: UpgradeRecord): Promise<StepResult | null> {
    const changed = this.hostChanged(record);
    if (changed) return changed;
    const refusal = await this.stepRefusal();
    return refusal
      ? { status: "failed", detail: `${refusal} Nothing was restarted.`, private: FORGET_DEV_BUILD }
      : null;
  }

  private async runCoordinator(record: UpgradeRecord): Promise<StepResult> {
    if (this.ports.coordinatorReplacement !== null)
      return { status: "skipped", detail: this.ports.coordinatorReplacement };
    const state = record.private;
    if (!state.coordinatorLaunchedAt) {
      const next = this.ports.hostRelease();
      const previous = this.ports.coordinatorRelease();
      if (previous === next && this.ports.runningRelease() === next)
        return { status: "succeeded", detail: "The coordinator already runs this release." };
      // Record the launch before it happens: the helper restarts this process.
      const launched = this.save(record, {
        private: {
          ...state,
          coordinatorNext: next,
          coordinatorPrevious: previous,
          coordinatorLaunchedAt: this.ports.now().toISOString(),
        },
      });
      this.ports.launchCoordinatorSwap(project(launched), next, previous);
      return { status: "waiting", detail: "Restarting the coordinator on the new release." };
    }
    return coordinatorSwapResult(this.ports, {
      outcome: this.ports.coordinatorOutcome(record.id),
      launchedAt: state.coordinatorLaunchedAt,
      next: state.coordinatorNext,
    });
  }

  /**
   * The Dev step. Its release-mode keys are dropped once it ends, so a coordinator rolled
   * back to a release that predates them can still read the journal.
   */
  private async runDev(record: UpgradeRecord): Promise<StepResult> {
    const forget = FORGET_DEV_BUILD;
    let result: StepResult;
    try {
      result = await this.runDevStep(record);
    } catch (error) {
      // Thrown before any swap (preparation or a build), so a retry can start over.
      const latest = this.records.find((item) => item.id === record.id) ?? record;
      this.save(latest, { private: { ...latest.private, ...forget } });
      throw error;
    }
    if (result.status === "waiting") return result;
    return { ...result, private: { ...result.private, ...forget } };
  }

  private async runDevStep(record: UpgradeRecord): Promise<StepResult> {
    if (this.ports.devUnmanaged)
      return {
        status: "skipped",
        detail:
          "Dev is not managed by the installer, so it is left as it is. Update it through Dev source updates.",
      };
    if (!this.ports.hasContainer)
      return { status: "skipped", detail: "This installation has no Dev container." };
    const { state: current, persist } = this.persister(record);
    let state = current();
    const save = (changes: Partial<UpgradePrivate>) => {
      persist(changes);
      state = current();
    };
    // A mode chosen during the Host step still needs this release's deployment scripts.
    if (state.devMode && state.devReplacing !== true)
      await this.ports.refreshDevScripts(project(record));
    const mode = state.devMode ?? (await this.ports.prepareDev(project(record)));
    save({ devMode: mode });
    if (mode === "release") return this.runDevRelease(record, current, persist);
    const previous = state.devPreviousImage ?? (await this.ports.devImage());
    save({ devPreviousImage: previous });
    // Built during the Host step; Docker may have pruned it since.
    if (
      state.devImage &&
      state.devReplacing !== true &&
      !(await this.ports.hasDevImage(state.devImage))
    )
      save({ devImage: undefined });
    const image = state.devImage ?? (await this.ports.buildDevImage(project(record)));
    save({ devImage: image });
    if (record.restart === "after-work" && state.devReplacing !== true) {
      const busy = await this.ports.busy("container-daemon");
      if (busy) return { status: "waiting", detail: `Waiting for current Dev work: ${busy}` };
    }
    // A coordinator that restarted while Dev was being recreated checks what runs now.
    const resumed = state.devReplacing === true && (await this.ports.devImage()) === image;
    save({ devReplacing: true });
    try {
      if (!resumed) await this.ports.replaceDevImage(image);
      await this.ports.verifyDev();
    } catch (error) {
      try {
        if ((await this.ports.devImage()) !== previous) await this.ports.replaceDevImage(previous);
      } catch (rollbackError) {
        return {
          status: "failed",
          detail: `Dev failed on the new image (${message(error)}) and the previous image did not come back (${message(rollbackError)}).`,
          private: { devReplacing: false },
        };
      }
      return {
        status: "rolled-back",
        detail: `Dev failed on the new image (${message(error)}). Dev runs the previous image again.`,
        private: { devReplacing: false },
      };
    }
    return {
      status: "succeeded",
      detail: `Dev runs ${image}.`,
      private: { devReplacing: false },
    };
  }

  /** The record's private state as saved now, and a saver of real changes only. */
  private persister(record: UpgradeRecord) {
    const latest = () => this.records.find((item) => item.id === record.id) ?? record;
    return {
      state: () => latest().private,
      // Saves only real changes, so a Dev wait leaves the revision the owner decides on intact.
      persist: (changes: Partial<UpgradePrivate>) => {
        const now = latest();
        if (
          Object.entries(changes).some(
            ([key, value]) => now.private[key as keyof UpgradePrivate] !== value,
          )
        )
          this.save(now, { private: { ...now.private, ...changes } });
      },
    };
  }

  /**
   * Builds Dev's release or image during the Host step, from the Host release just built,
   * and records it so the Dev step only restarts Dev. Same keys as the Dev step's own build.
   */
  private async buildDevAhead(record: UpgradeRecord): Promise<void> {
    if (this.ports.devUnmanaged || !this.ports.hasContainer) return;
    const { state, persist } = this.persister(record);
    // Dev's deployment is left alone until the Dev step: the Host step may still fail.
    const mode = state().devMode ?? (await this.ports.devUpgradeMode(project(record)));
    persist({ devMode: mode });
    if (mode === "release") {
      persist({
        devPreviousRelease: state().devPreviousRelease ?? (await this.ports.devRelease()),
      });
      if (state().devReleaseBuilt !== true) {
        await this.ports.buildDevRelease(project(record));
        persist({ devReleaseBuilt: true });
      }
      return;
    }
    persist({ devPreviousImage: state().devPreviousImage ?? (await this.ports.devImage()) });
    if (!state().devImage) persist({ devImage: await this.ports.buildDevImage(project(record)) });
  }

  /**
   * Builds the Dev release on the Host and restarts only Dev's daemon on it. The image,
   * the container and the gate are kept. A failure restores the previous selection.
   */
  private async runDevRelease(
    record: UpgradeRecord,
    state: () => UpgradePrivate,
    persist: (changes: Partial<UpgradePrivate>) => void,
  ): Promise<StepResult> {
    const previous = state().devPreviousRelease ?? (await this.ports.devRelease());
    persist({ devPreviousRelease: previous });
    if (state().devReleaseBuilt !== true) {
      await this.ports.buildDevRelease(project(record));
      persist({ devReleaseBuilt: true });
    }
    if (record.restart === "after-work" && state().devReplacing !== true) {
      const busy = await this.ports.busy("container-daemon");
      if (busy) return { status: "waiting", detail: `Waiting for current Dev work: ${busy}` };
    }
    // A coordinator that restarted mid-swap swaps again: the link can be repointed before
    // Dev's daemon restarted, and only the restart proves which release runs.
    persist({ devReplacing: true });
    const was = previous === "none" ? "its image's daemon" : `release ${previous}`;
    try {
      await this.ports.selectDevRelease(record.sourceCommit);
      await this.ports.verifyDev();
    } catch (error) {
      try {
        if ((await this.ports.devRelease()) !== previous)
          await this.ports.selectDevRelease(previous);
      } catch (rollbackError) {
        return {
          status: "failed",
          detail: `Dev failed on the new release (${message(error)}) and ${was} did not come back (${message(rollbackError)}).`,
          private: { devReplacing: false },
        };
      }
      return {
        status: "rolled-back",
        detail: `Dev failed on the new release (${message(error)}). Dev runs ${was} again.`,
        private: { devReplacing: false },
      };
    }
    await this.ports.pruneDevReleases().catch(() => undefined);
    return {
      status: "succeeded",
      detail: `Dev's daemon runs release ${record.sourceCommit.slice(0, 12)}; its image was kept.`,
      private: { devReplacing: false },
    };
  }
}

/**
 * Owner-approved upgrade to one tested GitHub release. Steps run in order:
 * snapshot, fetch, Host build and restart, coordinator replacement, Dev image.
 */
export class InstallationUpgrades extends UpgradePipeline {
  list(): InstallationUpgrade[] {
    return this.jobs().filter(isReleaseUpgrade);
  }

  active(): InstallationUpgrade | null {
    const job = this.activeJob();
    return job && isReleaseUpgrade(job) ? job : null;
  }

  /** Why another installation operation keeps a release upgrade from starting now, or null. */
  blocked(): string | null {
    return this.ports.conflict();
  }

  /** Why a pending or approved upgrade was withdrawn without the owner, such as a newer release. */
  withdraw(id: string, detail: string): InstallationUpgrade {
    const record = this.records.find((item) => item.id === id);
    if (!record || !["pending", "approved"].includes(record.status) || !isReleaseUpgrade(record))
      throw new RestartRequestError("Only an upgrade that has not started can be withdrawn");
    return this.release(project(this.save(record, { status: "cancelled", detail })));
  }

  /**
   * Approves an update-check offer under the installation's automatic update policy. The Host
   * restart always waits until no agents would be interrupted.
   */
  approveAutomatically(id: string): InstallationUpgrade {
    const record = this.records.find((item) => item.id === id);
    if (
      record?.status !== "pending" ||
      !isReleaseUpgrade(record) ||
      record.origin !== "update-check"
    )
      throw new RestartRequestError("Only a pending update-check offer is approved automatically");
    this.refuseConflict();
    return this.release(
      project(
        this.save(record, {
          status: "approved",
          approvedAt: this.ports.now().toISOString(),
          automatic: true,
          restart: "after-work",
          detail: "Approved by the automatic update policy. Starting.",
        }),
      ),
    );
  }

  async request(
    release: string,
    offer?: { origin: "update-check"; notes: ReleaseNotes },
  ): Promise<InstallationUpgrade> {
    this.refuseActive();
    this.refuseConflict();
    const sourceCommit = await this.ports.resolveRelease(release);
    // The update check, its routes and the owner can request at once; the first one wins.
    this.refuseActive();
    const previousCommit = this.ports.currentCommit();
    if (previousCommit === sourceCommit)
      throw new RestartRequestError(`This installation already runs ${release}`);
    const now = this.ports.now().toISOString();
    return this.release(
      this.add({
        id: randomUUID(),
        revision: randomUUID(),
        release,
        sourceCommit,
        previousCommit,
        createdAt: now,
        status: "pending",
        detail: "Waiting for owner approval.",
        steps: UPGRADE_STEPS.map((name) => ({ name, status: "pending", detail: "" })),
        ...offer,
        private: {},
      }),
    );
  }

  decide(id: string, revision: string, decision: UpgradeDecision["decision"]): InstallationUpgrade {
    return this.release(this.decideJob(id, revision, decision));
  }

  private release(job: UpgradeJob): InstallationUpgrade {
    if (!isReleaseUpgrade(job))
      throw new Error("The release upgrade journal holds a source upgrade");
    return job;
  }
}

/** What admission learned about a commit after fetching `main`. */
export interface SourceFacts {
  /** The commit is on `main` of the release repository. */
  onMain: boolean;
  /** The commit contains the installed Host commit, so it is not a downgrade. */
  containsInstalled: boolean;
  /** Whether every check `main`'s ruleset requires passed on the commit. */
  checks: { passed: boolean; detail: string };
  /** The newest release tag the commit contains, or null when unknown. */
  lastRelease: string | null;
}

export interface SourceUpgradePorts extends UpgradePorts {
  /** Fetches `main` and inspects the commit. Throws when it cannot; that refuses the request. */
  inspectSource(commit: string, installed: string): Promise<SourceFacts>;
  /** The newest release tag a commit contains, or null. Used for rollbacks, which skip admission. */
  lastRelease(commit: string): Promise<string | null>;
  /** Null when the Host release built for `commit` can be selected again without a build. */
  rollbackBlocker(commit: string): string | null;
  /** Why a source upgrade must stop now, such as the installation having become Lab, or null. */
  installationBlocker(): Promise<string | null>;
  /** The active full maintenance grant, read fresh; null when none applies. */
  delegationGrant?(): DelegationGrant | null;
  /**
   * Delegated approvals, kept beside the strict upgrade journal that older coordinators read:
   * their records stay pending, so a rolled-back coordinator waits for the owner.
   */
  delegationEvidence?: DelegationEvidence;
  /** The cancellation window before delegated work starts. */
  cancellationDelayMs?: number;
}

/** The operation name full delegation checks against OWNER_ONLY_OPERATIONS. */
const SOURCE_UPGRADE_OPERATION = "source-upgrade";
const sourcePlan = (record: { sourceCommit: string; previousCommit?: string | null }) =>
  delegatedPlanDigest(SOURCE_UPGRADE_OPERATION, {
    sourceCommit: record.sourceCommit,
    previousCommit: record.previousCommit ?? null,
  });

/** How long after a source upgrade finished the owner can roll the Host back to its predecessor. */
export const SOURCE_ROLLBACK_WINDOW_MS = 24 * 60 * 60_000;

export type SourceRollbackOffer = SourceUpgradeStatus["rollback"];

function hostStep(job: UpgradeJob): UpgradeStep | undefined {
  return job.steps.find((step) => step.name === "host");
}

/** Why admission refuses a commit, or null. Checked at request and again at approval. */
function admissionRefusal(commit: string, installed: string, facts: SourceFacts): string | null {
  if (!facts.onMain)
    return `Commit ${commit.slice(0, 12)} is not on main. Only commits on main can be installed.`;
  if (!facts.containsInstalled)
    return `Commit ${commit.slice(0, 12)} does not contain the installed Host commit ${installed.slice(0, 12)}. Installing it would be a downgrade.`;
  if (!facts.checks.passed) return `Required checks have not passed: ${facts.checks.detail}`;
  return null;
}

/**
 * Owner-approved upgrade of a Stable installation to one reviewed commit on `main`. It runs
 * the release upgrade's steps; only admission, the fetch and the journal differ. Approval is
 * always the owner's: no update policy approves it. The owner can roll the Host back to the
 * release it replaced for 24 hours, as another source upgrade with its own approval.
 */
export class SourceUpgrades extends UpgradePipeline<SourceUpgradePorts> {
  /**
   * A delegated request is shown with its start time, projected from the side evidence: the
   * stored record and the revision its approval binds stay unchanged.
   */
  list(): SourceUpgrade[] {
    return this.jobs()
      .filter(isSourceUpgrade)
      .map((job) => this.projectDelegated(job));
  }

  /**
   * The detail a pending request shows while a valid delegated approval covers it: when it
   * starts, that current work finishes first, and, after the window, what it is waiting for. A
   * revoked or changed grant shows the record's own owner-approval detail again.
   */
  private projectDelegated(job: SourceUpgrade): SourceUpgrade {
    if (job.status !== "pending") return job;
    const approval = this.ports.delegationEvidence?.get(job.id);
    if (
      !approval ||
      !delegatedApprovalHolds(approval, this.ports.delegationGrant?.() ?? null, {
        revision: job.revision,
        planSha256: sourcePlan(job),
      })
    )
      return job;
    const detail =
      this.ports.now().getTime() < Date.parse(approval.dispatchAfter)
        ? `Approved under owner maintenance delegation. Starts after ${approval.dispatchAfter} unless cancelled; current work finishes before the Host restarts.`
        : "Approved under owner maintenance delegation. Starts once admission passes again and no other upgrade runs; current work finishes before the Host restarts. Cancel to stop it.";
    return Object.assign(structuredClone(job), { detail });
  }

  active(): SourceUpgrade | null {
    const job = this.activeJob();
    return job && isSourceUpgrade(job) ? job : null;
  }

  /**
   * Creates a pending source upgrade once admission passes: the commit is on `main`, contains
   * the installed Host commit and passed `main`'s required checks, and no upgrade runs.
   */
  async request(input: {
    commit: string;
    reason: string;
    requestedBy: string;
    /** A Host agent's request, which the full maintenance grant may approve after its window. */
    hostAgent?: boolean;
  }): Promise<SourceUpgrade> {
    this.refuseActive();
    this.refuseConflict();
    const installed = this.ports.currentCommit();
    if (!installed)
      throw new RestartRequestError(
        "The installed Host commit is unknown, so a source upgrade cannot prove it is not a downgrade.",
      );
    if (installed === input.commit)
      throw new RestartRequestError("The Host already runs this commit.");
    const facts = await this.ports.inspectSource(input.commit, installed);
    const refusal = admissionRefusal(input.commit, installed, facts);
    if (refusal) throw new RestartRequestError(refusal);
    // Admission fetched and called GitHub; another request may have won meanwhile.
    this.refuseActive();
    this.refuseConflict();
    const created = this.create({
      sourceCommit: input.commit,
      previousCommit: installed,
      reason: input.reason,
      requestedBy: input.requestedBy,
      lastRelease: facts.lastRelease,
    });
    // Only the Host-agent route writes evidence, so its presence proves the request's origin.
    const grant = this.ports.delegationGrant?.() ?? null;
    if (input.hostAgent && grant && delegableUnderGrant(SOURCE_UPGRADE_OPERATION))
      this.ports.delegationEvidence?.set(
        created.id,
        delegatedApproval(grant, {
          requestRevision: created.revision,
          planSha256: sourcePlan(created),
          now: this.ports.now().getTime(),
          cancellationDelayMs: this.ports.cancellationDelayMs ?? 30_000,
        }),
      );
    return this.projectDelegated(created);
  }

  /**
   * Starts a delegated source upgrade once its window ends. Admission runs again while the record
   * is still pending; then one journal write takes it from pending straight to running, so no
   * approved record exists that an older coordinator would replay. A lapsed grant leaves the
   * request pending for the owner.
   */
  private readonly delegatedCheckedAt = new Map<string, number>();

  /** Whether another upgrade is active; this request's own pending record does not count. */
  private busyWith(id: string): boolean {
    const active = this.activeRecord();
    return active !== undefined && active.id !== id;
  }

  override async drain(): Promise<void> {
    await this.claimDelegated();
    return super.drain();
  }

  private async claimDelegated(): Promise<void> {
    const evidence = this.ports.delegationEvidence;
    if (!evidence) return;
    for (const record of this.records.filter(isSourceUpgrade)) {
      const approval = evidence.get(record.id);
      if (!approval) continue;
      // Rollbacks stay with the owner (OWNER_ONLY_OPERATIONS: source-upgrade-rollback).
      if (
        record.status !== "pending" ||
        ("rollbackOf" in record && record.rollbackOf) ||
        !record.previousCommit
      ) {
        evidence.delete(record.id);
        continue;
      }
      const ready = () => {
        const current = this.records.find((item) => item.id === record.id);
        if (!current || current.status !== "pending" || current.revision !== record.revision)
          return "gone";
        return delegatedAdmissionStep(
          { ...current, requestedBy: "host-agent", delegatedApproval: approval },
          {
            grant: this.ports.delegationGrant?.() ?? null,
            operations: [SOURCE_UPGRADE_OPERATION],
            planSha256: sourcePlan(current),
            now: this.ports.now().getTime(),
          },
        );
      };
      const step = ready();
      if (step === "invalid" || step === "gone") {
        // Revoked, renewed or changed: the owner decides it, as for any request.
        evidence.delete(record.id);
        continue;
      }
      if (step !== "ready" || this.busyWith(record.id)) continue;
      // Admission fetches main and asks GitHub: at most once a minute while checks are pending.
      const time = this.ports.now().getTime();
      if (time - (this.delegatedCheckedAt.get(record.id) ?? 0) < 60_000) continue;
      this.delegatedCheckedAt.set(record.id, time);
      const facts = await this.ports.inspectSource(record.sourceCommit, record.previousCommit);
      const refusal = admissionRefusal(record.sourceCommit, record.previousCommit, facts);
      if (refusal) continue; // Stays pending; it starts once checks pass, or the owner decides.
      this.claim(record.id, ready, evidence);
    }
  }

  /** Checked last, after the asynchronous admission: then one write, pending to running. */
  private claim(id: string, ready: () => string, evidence: DelegationEvidence): void {
    const latest = ready();
    if (latest === "invalid" || latest === "gone") {
      evidence.delete(id);
      return;
    }
    if (latest !== "ready" || this.busyWith(id)) return;
    try {
      this.refuseConflict();
    } catch {
      return;
    }
    const current = this.records.find((item) => item.id === id)!;
    const blocked = this.approvalRefusal(current);
    if (blocked) {
      this.save(current, { status: "cancelled", detail: blocked });
      evidence.delete(id);
      return;
    }
    this.save(current, {
      status: "running",
      approvedAt: this.ports.now().toISOString(),
      // Current turns finish before the Host restarts, as for an owner's "after work".
      restart: "after-work",
      detail: "Approved under owner maintenance delegation. Upgrade running.",
    });
    evidence.delete(id);
  }

  /** Creates a pending rollback of the source upgrade the rollback offer names. */
  async requestRollback(upgradeId: string, requestedBy: string): Promise<SourceUpgrade> {
    const offer = this.rollbackOffer();
    if (!offer.available || offer.upgradeId !== upgradeId || !offer.commit)
      throw new RestartRequestError(offer.detail);
    this.refuseConflict();
    const lastRelease = await this.ports.lastRelease(offer.commit).catch(() => null);
    this.refuseActive();
    return this.create({
      sourceCommit: offer.commit,
      previousCommit: this.ports.currentCommit(),
      reason: `Roll back the source upgrade to commit ${
        this.list()
          .find((job) => job.id === upgradeId)
          ?.sourceCommit.slice(0, 12) ?? "unknown"
      }.`,
      requestedBy,
      lastRelease,
      rollbackOf: upgradeId,
      rollbackUntil: offer.until,
    });
  }

  /**
   * Approval repeats admission (on main, no downgrade, required checks) against `main` as it
   * is now. A refusal leaves the request pending, so it can be approved once checks pass.
   */
  async decide(
    id: string,
    revision: string,
    decision: SourceUpgradeDecision["decision"],
  ): Promise<SourceUpgrade> {
    const record = this.records.find((item) => item.id === id);
    if (
      record?.status === "pending" &&
      isSourceUpgrade(record) &&
      !record.rollbackOf &&
      record.previousCommit &&
      (decision === "approve" || decision === "approve-after-work")
    ) {
      const facts = await this.ports.inspectSource(record.sourceCommit, record.previousCommit);
      const refusal = admissionRefusal(record.sourceCommit, record.previousCommit, facts);
      if (refusal) throw new RestartRequestError(refusal);
    }
    const job = this.decideJob(id, revision, decision);
    if (!isSourceUpgrade(job))
      throw new Error("The source upgrade journal holds a release upgrade");
    // The owner's decision replaces a delegated approval.
    this.ports.delegationEvidence?.delete(id);
    return job;
  }

  /**
   * The rollback of the newest source upgrade that moved the Host: offered for 24 hours after
   * its Host step succeeded, even when a later step failed, while the Host still runs it and
   * its previous Host release can be selected without a build.
   */
  rollbackOffer(): SourceRollbackOffer {
    const latest = this.list().find(
      (job) => !upgradeIsActive(job) && hostStep(job)?.status === "succeeded",
    );
    const none = (detail: string): SourceRollbackOffer => ({ available: false, detail });
    if (!latest || latest.rollbackOf) return none("No source upgrade can be rolled back.");
    const hostFinished = hostStep(latest)?.finishedAt;
    const finished = hostFinished ? Date.parse(hostFinished) : null;
    if (finished === null || !latest.previousCommit)
      return none("The newest source upgrade did not record what it replaced.");
    const until = finished + SOURCE_ROLLBACK_WINDOW_MS;
    if (this.ports.now().getTime() >= until)
      return none("The 24-hour rollback window of the newest source upgrade has ended.");
    if (this.ports.currentCommit() !== latest.sourceCommit)
      return none("The Host no longer runs the newest source upgrade.");
    const offer = {
      upgradeId: latest.id,
      commit: latest.previousCommit,
      until: new Date(until).toISOString(),
    };
    if (this.activeRecord())
      return { available: false, detail: "Wait for the source upgrade to finish.", ...offer };
    const blocker = this.ports.rollbackBlocker(latest.previousCommit);
    if (blocker) return { available: false, detail: blocker, ...offer };
    return {
      available: true,
      detail: `Selects the Host release of ${latest.previousCommit.slice(0, 12)} again without a build.`,
      ...offer,
    };
  }

  /** Only a Stable installation continues a source upgrade, checked before every step. */
  protected override stepRefusal(): Promise<string | null> {
    return this.ports.installationBlocker();
  }

  /** The approval binds the installed commit the owner reviewed against. */
  protected override approvalRefusal(record: UpgradeRecord): string | null {
    const expired = rollbackExpired(record, this.ports.now());
    if (expired) return expired;
    if (this.ports.currentCommit() !== record.previousCommit)
      return "The installed Host commit changed after this source upgrade was reviewed. Request it again.";
    return null;
  }

  private create(input: {
    sourceCommit: string;
    previousCommit: string | null;
    reason: string;
    requestedBy: string;
    lastRelease: string | null;
    rollbackOf?: string;
    rollbackUntil?: string;
  }): SourceUpgrade {
    const lastRelease = ReleaseTagSchema.safeParse(input.lastRelease);
    const job = this.add({
      id: randomUUID(),
      revision: randomUUID(),
      kind: "source-upgrade",
      sourceCommit: input.sourceCommit,
      previousCommit: input.previousCommit,
      reason: input.reason.trim().slice(0, 500) || "No reason given.",
      requestedBy: input.requestedBy,
      lastRelease: lastRelease.success ? lastRelease.data : null,
      ...(input.rollbackOf ? { rollbackOf: input.rollbackOf } : {}),
      ...(input.rollbackUntil ? { rollbackUntil: input.rollbackUntil } : {}),
      createdAt: this.ports.now().toISOString(),
      status: "pending",
      detail: "Waiting for owner approval.",
      steps: UPGRADE_STEPS.map((name) => ({ name, status: "pending", detail: "" })),
      private: {},
    });
    if (!isSourceUpgrade(job))
      throw new Error("A source upgrade was recorded as a release upgrade");
    return job;
  }
}

const CoordinatorFollowJournalSchema = z.strictObject({
  version: z.literal(1),
  jobs: z.array(CoordinatorFollowJobSchema),
});

export interface CoordinatorFollowJournal {
  read(): CoordinatorFollowJob[];
  write(jobs: CoordinatorFollowJob[]): void;
}

export function createCoordinatorFollowJournal(directory: string): CoordinatorFollowJournal {
  const file = path.join(directory, "journal.json");
  return {
    read: () =>
      existsSync(file)
        ? CoordinatorFollowJournalSchema.parse(JSON.parse(readFileSync(file, "utf8"))).jobs
        : [],
    write: (jobs) =>
      writePrivateFileAtomicSync(
        file,
        JSON.stringify({ version: 1, jobs: jobs.slice(-RETAINED_UPGRADES) }, null, 2),
      ),
  };
}

export interface CoordinatorFollowPorts extends Pick<
  UpgradePorts,
  "now" | "hostRelease" | "runningRelease" | "coordinatorRelease" | "coordinatorDeadlineMs"
> {
  /** Null when the coordinator can replace itself; otherwise why it cannot. */
  replacement: string | null;
  /** Why another installation operation, such as a release upgrade, blocks this now, or null. */
  conflict(): string | null;
  /** True when the release holds the coordinator entrypoint this process runs. */
  hasCoordinator(release: string): boolean;
  /** Starts the detached swap helper; it restarts this process. */
  launchSwap(job: CoordinatorFollowJob, next: string, previous: string): void;
  swapOutcome(jobId: string): HandoffOutcome | null;
  /** The active full maintenance grant, read fresh; null when none applies. */
  delegationGrant?(): DelegationGrant | null;
  /** The cancellation window before delegated work starts. */
  cancellationDelayMs?: number;
}

/** The operation name full delegation checks against OWNER_ONLY_OPERATIONS. */
const FOLLOW_OPERATION = "coordinator-follow";
const followPlan = (job: CoordinatorFollowJob) =>
  delegatedPlanDigest(FOLLOW_OPERATION, { next: job.next });

export type AgentCoordinatorFollow = NonNullable<AgentUpdateStatus["coordinatorFollow"]>;

/** How long a finished job stays in the status, so the owner sees how it ended. */
const FOLLOW_RESULT_MS = 24 * 60 * 60_000;

function followIsActive(job: CoordinatorFollowJob): boolean {
  return ["pending", "approved", "running"].includes(job.status);
}

/**
 * Moves the coordinator onto the Host's selected release. Host source updates repoint the Host
 * release link only, and installations that track `main` never receive the release tags that
 * upgrades replace the coordinator for. The owner approves one job bound to the exact Host
 * release reviewed; it then runs the release upgrade's coordinator swap. Every transition is
 * written before its effect, so the coordinator that starts next resumes from the journal.
 */
export class CoordinatorFollow {
  private jobs: CoordinatorFollowJob[];

  constructor(
    private readonly journal: CoordinatorFollowJournal,
    private readonly ports: CoordinatorFollowPorts,
  ) {
    this.jobs = journal.read();
  }

  /** The job approved or running. A release upgrade must not start beside it. */
  dispatching(): CoordinatorFollowJob | null {
    return this.jobs.find((job) => job.status === "approved" || job.status === "running") ?? null;
  }

  /** Every retained job, for installation management. */
  list(): CoordinatorFollowJob[] {
    return structuredClone(this.jobs);
  }

  job(id: string): CoordinatorFollowJob | null {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  status(): CoordinatorFollowStatus {
    return { ...this.availability(), job: this.shownJob() };
  }

  agentStatus(): AgentCoordinatorFollow {
    const { available, detail, current, job } = this.status();
    return { available, detail, current, job };
  }

  request(
    next: string,
    origin: { requestedBy: "owner" | "host-agent"; requester?: string } = { requestedBy: "owner" },
  ): CoordinatorFollowJob {
    if (this.jobs.some(followIsActive))
      throw new RestartRequestError("A coordinator update is already waiting or running");
    const { available, detail, current } = this.availability();
    if (!available || !current) throw new RestartRequestError(detail);
    if (current.hostRelease !== next)
      throw new RestartRequestError(
        "The Host release changed. Review the coordinator update again.",
      );
    const job = CoordinatorFollowJobSchema.parse({
      id: randomUUID(),
      revision: randomUUID(),
      createdAt: this.ports.now().toISOString(),
      status: "pending",
      detail: "Waiting for owner approval.",
      next,
      requestedBy: origin.requestedBy,
      ...(origin.requester ? { requester: origin.requester } : {}),
    });
    this.jobs = [...this.jobs, job];
    this.journal.write(this.jobs);
    return job;
  }

  decide(
    id: string,
    revision: string,
    decision: CoordinatorFollowDecision["decision"],
  ): CoordinatorFollowJob {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new RestartRequestError("Coordinator update not found");
    if (job.revision !== revision)
      throw new RestartRequestError("The coordinator update changed. Review it again.");
    if (decision === "approve" && job.status === "pending") {
      const refusal = this.refusal(job);
      if (refusal) {
        this.finish(job, "cancelled", refusal);
        throw new RestartRequestError(refusal);
      }
      return this.save(job, {
        status: "approved",
        approvedAt: this.ports.now().toISOString(),
        delegatedApproval: undefined,
        detail: "Approved. Starting.",
      });
    }
    if (decision === "reject" && job.status === "pending")
      return this.finish(job, "rejected", "Rejected by the owner.");
    if (decision === "cancel" && (job.status === "pending" || job.status === "approved"))
      return this.finish(job, "cancelled", "Cancelled by the owner.");
    throw new RestartRequestError(
      `A coordinator update that is ${job.status} cannot be changed that way`,
    );
  }

  /** Starts an approved job or follows a running one. Safe to call repeatedly. */
  drain(): void {
    this.admitDelegated();
    const job = this.dispatching();
    if (job?.status === "approved") this.dispatch(job);
    else if (job?.status === "running") this.follow(job);
  }

  /**
   * Full maintenance delegation approves a fresh Host-agent request for exactly its Host release,
   * after the cancellation window. Until then it stays pending, so the owner can still cancel it
   * and a rollback runtime that ignores the evidence waits for the owner.
   */
  private admitDelegated(): void {
    const job = this.jobs.find((item) => item.status === "pending");
    if (!job) return;
    const now = this.ports.now().getTime();
    const step = delegatedAdmissionStep(job, {
      grant: this.ports.delegationGrant?.() ?? null,
      operations: [FOLLOW_OPERATION],
      planSha256: followPlan(job),
      now,
    });
    if (step === "attach") {
      const revision = randomUUID();
      const approval = delegatedApproval(this.ports.delegationGrant!()!, {
        requestRevision: revision,
        planSha256: followPlan(job),
        now,
        cancellationDelayMs: this.ports.cancellationDelayMs ?? 30_000,
      });
      this.save(job, {
        revision,
        delegatedApproval: approval,
        detail: `Approved under owner maintenance delegation. Starts after ${approval.dispatchAfter} unless cancelled.`,
      });
    } else if (step === "invalid") {
      this.finish(job, "cancelled", "Delegated approval changed before dispatch. Nothing started.");
    } else if (step === "ready") {
      const refusal = this.refusal(job);
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

  private dispatch(job: CoordinatorFollowJob): void {
    // A delegated approval holds only while its grant does, including one recovered from the
    // journal after a restart between approval and dispatch.
    if (
      !delegatedDispatchHolds(job.delegatedApproval, this.ports.delegationGrant?.() ?? null, {
        operations: [FOLLOW_OPERATION],
        planSha256: followPlan(job),
      })
    ) {
      this.finish(job, "cancelled", "Delegated approval changed before dispatch. Nothing started.");
      return;
    }
    const refusal = this.refusal(job);
    if (refusal) {
      this.finish(job, "failed", refusal);
      return;
    }
    let previous: string;
    try {
      previous = this.ports.coordinatorRelease();
    } catch (error) {
      this.finish(job, "failed", `The coordinator release link cannot be read: ${message(error)}`);
      return;
    }
    if (previous === job.next && this.ports.runningRelease() === job.next) {
      this.finish(job, "succeeded", "The coordinator already runs the Host release.");
      return;
    }
    // Recorded before the launch: the helper restarts this process.
    const running = this.save(job, {
      status: "running",
      previous,
      startedAt: this.ports.now().toISOString(),
      detail: "Restarting the coordinator on the Host release.",
    });
    try {
      this.ports.launchSwap(running, job.next, previous);
    } catch (error) {
      this.finish(
        running,
        "failed",
        `The coordinator replacement did not start: ${message(error)}`,
      );
    }
  }

  private follow(job: CoordinatorFollowJob): void {
    const result = coordinatorSwapResult(this.ports, {
      outcome: this.ports.swapOutcome(job.id),
      launchedAt: job.startedAt ?? job.createdAt,
      next: job.next,
    });
    if (result.status === "succeeded" && this.ports.runningRelease() !== job.next) {
      // The helper sees only a new process answer. One started outside the link runs on.
      this.finish(
        job,
        "failed",
        "The coordinator restarted but still runs its previous release. Its service does not start through the release link.",
      );
      return;
    }
    if (result.status !== "waiting") this.finish(job, result.status, result.detail);
  }

  /** Why an approved job must not start now: the reviewed Host release no longer applies. */
  private refusal(job: CoordinatorFollowJob): string | null {
    if (this.ports.replacement) return this.ports.replacement;
    const conflict = this.ports.conflict();
    if (conflict) return conflict;
    let host: string;
    try {
      host = this.ports.hostRelease();
    } catch (error) {
      return `The Host release cannot be read: ${message(error)}`;
    }
    if (host !== job.next)
      return "The Host release changed after this update was reviewed. Review it again.";
    if (!this.ports.hasCoordinator(job.next))
      return "The Host release has no coordinator to start.";
    return null;
  }

  private availability(): Omit<CoordinatorFollowStatus, "job"> {
    if (this.ports.replacement)
      return { available: false, detail: this.ports.replacement, current: null };
    let current: NonNullable<CoordinatorFollowStatus["current"]>;
    try {
      current = {
        coordinatorRelease: this.ports.coordinatorRelease(),
        runningRelease: this.ports.runningRelease(),
        hostRelease: this.ports.hostRelease(),
      };
    } catch (error) {
      return {
        available: false,
        detail: `The coordinator and Host releases cannot be read: ${message(error)}`,
        current: null,
      };
    }
    const unavailable = this.unavailableReason(current);
    return unavailable
      ? { available: false, detail: unavailable, current }
      : {
          available: true,
          detail: "The coordinator runs an older release than the Host.",
          current,
        };
  }

  private unavailableReason(current: NonNullable<CoordinatorFollowStatus["current"]>) {
    const conflict = this.ports.conflict();
    if (conflict) return conflict;
    const matches =
      current.coordinatorRelease === current.hostRelease &&
      current.runningRelease === current.hostRelease;
    if (matches) return "The coordinator already runs the Host release.";
    if (!this.ports.hasCoordinator(current.hostRelease))
      return "The Host release has no coordinator to start.";
    return null;
  }

  private shownJob(): CoordinatorFollowJob | null {
    const active = this.jobs.find(followIsActive);
    if (active) return active;
    const latest = this.jobs.at(-1);
    if (!latest?.finishedAt) return null;
    const age = this.ports.now().getTime() - Date.parse(latest.finishedAt);
    return age < FOLLOW_RESULT_MS ? latest : null;
  }

  private finish(
    job: CoordinatorFollowJob,
    status: CoordinatorFollowJob["status"],
    detail: string,
  ): CoordinatorFollowJob {
    return this.save(job, { status, detail, finishedAt: this.ports.now().toISOString() });
  }

  private save(
    job: CoordinatorFollowJob,
    changes: Partial<CoordinatorFollowJob>,
  ): CoordinatorFollowJob {
    const next = CoordinatorFollowJobSchema.parse({
      ...job,
      ...changes,
      revision: changes.revision ?? randomUUID(),
    });
    this.jobs = this.jobs.map((item) => (item.id === job.id ? next : item));
    this.journal.write(this.jobs);
    return next;
  }
}
