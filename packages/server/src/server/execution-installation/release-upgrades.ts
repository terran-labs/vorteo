import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  InstallationUpgradeSchema,
  UpgradeStepNameSchema,
  type InstallationUpgrade,
  type ReleaseNotes,
  type UpgradeDecision,
  type UpgradeStep,
  type UpgradeStepName,
} from "@getpaseo/protocol/installation-upgrades";
import { writePrivateFileAtomicSync } from "../private-files.js";
import type { HandoffOutcome } from "./coordinator-handoff.js";
import { RestartRequestError } from "./restarts.js";

/**
 * Owner-approved upgrade to one tested GitHub release. Steps run in order:
 * snapshot, fetch, Host build and restart, coordinator replacement, Dev image.
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

const UpgradeRecordSchema = InstallationUpgradeSchema.extend({
  private: UpgradePrivateSchema,
});
type UpgradeRecord = z.infer<typeof UpgradeRecordSchema>;

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
  /** True while this installation predates the installer layout (no `deployment`). */
  adoptionRequired: boolean;
  /** Starts the installer engine's in-place adoption, detached; it restarts this coordinator. */
  launchAdoption(upgrade: InstallationUpgrade): void;
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
  snapshot(upgrade: InstallationUpgrade): Promise<string>;
  /** Fetches the tag into the source directory and checks it still names sourceCommit. */
  fetchRelease(upgrade: InstallationUpgrade): Promise<void>;
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
  launchHostBuild(upgrade: InstallationUpgrade): void;
  /** How long the build-only Host release may run before the upgrade fails. */
  hostBuildDeadlineMs: number;
  hostBuild(upgradeId: string): { status: "running" | "succeeded" | "failed"; detail: string };
  /** Null when no agent on the target is working or starting; otherwise what still runs. */
  busy(target: "host" | "container-daemon"): Promise<string | null>;
  /** Stages the release as a Host source update and approves it in the restart queue. */
  requestHostUpdate(upgrade: InstallationUpgrade): Promise<string>;
  hostUpdate(jobId: string): { status: "running" | "succeeded" | "failed"; detail: string };
  /** The Host release directory selected now. */
  hostRelease(): string;
  /** The release this coordinator process runs from. */
  runningRelease(): string;
  /** The release the coordinator service link selects. */
  coordinatorRelease(): string;
  launchCoordinatorSwap(upgrade: InstallationUpgrade, next: string, previous: string): void;
  coordinatorOutcome(upgradeId: string): HandoffOutcome | null;
  /** How long the swap helper may take before the step is judged from the link alone. */
  coordinatorDeadlineMs: number;
  /**
   * Refreshes Dev's deployment scripts from the release, then answers whether Dev can move
   * by swapping only its daemon release ("release") or needs a new image ("image").
   */
  prepareDev(upgrade: InstallationUpgrade): Promise<"release" | "image">;
  /** The same answer without touching Dev's deployment, for builds before any restart. */
  devUpgradeMode(upgrade: InstallationUpgrade): Promise<"release" | "image">;
  /** Copies the release's deployment scripts into Dev's deployment. */
  refreshDevScripts(upgrade: InstallationUpgrade): Promise<void>;
  /** False when Docker no longer has the image, such as after a prune. */
  hasDevImage(image: string): Promise<boolean>;
  /** The selected Dev release's commit, or "none" when Dev runs its image's own daemon. */
  devRelease(): Promise<string>;
  /** Builds the upgrade's Dev release on the Host; reuses one already built. */
  buildDevRelease(upgrade: InstallationUpgrade): Promise<void>;
  /** Restarts Dev's daemon on a release, or "none". Throws when Dev does not become healthy. */
  selectDevRelease(release: string): Promise<void>;
  /** Removes old Dev releases, keeping the selected, previous and newest ones. */
  pruneDevReleases(): Promise<void>;
  devImage(): Promise<string>;
  buildDevImage(upgrade: InstallationUpgrade): Promise<string>;
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

function project(record: UpgradeRecord): InstallationUpgrade {
  const { private: _private, ...upgrade } = record;
  return upgrade;
}

function upgradeIsActive(record: InstallationUpgrade): boolean {
  return ["pending", "approved", "running"].includes(record.status);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class InstallationUpgrades {
  private records: UpgradeRecord[];
  private draining = false;

  constructor(
    private readonly journal: UpgradeJournal,
    private readonly ports: UpgradePorts,
  ) {
    this.records = journal.read();
  }

  list(): InstallationUpgrade[] {
    return this.records.map(project).toReversed();
  }

  active(): InstallationUpgrade | null {
    const record = this.activeRecord();
    return record ? project(record) : null;
  }

  private activeRecord(): UpgradeRecord | undefined {
    return this.records.find(upgradeIsActive);
  }

  private save(record: UpgradeRecord, changes: Partial<UpgradeRecord>): UpgradeRecord {
    const next = UpgradeRecordSchema.parse({ ...record, ...changes, revision: randomUUID() });
    this.records = this.records.map((item) => (item.id === record.id ? next : item));
    this.journal.write(this.records);
    return next;
  }

  /** Why a pending or approved upgrade was withdrawn without the owner, such as a newer release. */
  withdraw(id: string, detail: string): InstallationUpgrade {
    const record = this.records.find((item) => item.id === id);
    if (!record || !["pending", "approved"].includes(record.status))
      throw new RestartRequestError("Only an upgrade that has not started can be withdrawn");
    return project(this.save(record, { status: "cancelled", detail }));
  }

  /**
   * Approves an update-check offer under the installation's automatic update policy. The Host
   * restart always waits until no agents would be interrupted.
   */
  approveAutomatically(id: string): InstallationUpgrade {
    const record = this.records.find((item) => item.id === id);
    if (record?.status !== "pending" || record.origin !== "update-check")
      throw new RestartRequestError("Only a pending update-check offer is approved automatically");
    return project(
      this.save(record, {
        status: "approved",
        approvedAt: this.ports.now().toISOString(),
        automatic: true,
        restart: "after-work",
        detail: "Approved by the automatic update policy. Starting.",
      }),
    );
  }

  async request(
    release: string,
    offer?: { origin: "update-check"; notes: ReleaseNotes },
  ): Promise<InstallationUpgrade> {
    if (this.activeRecord())
      throw new RestartRequestError("Another upgrade is already pending or running");
    const sourceCommit = await this.ports.resolveRelease(release);
    // The update check, its routes and the owner can request at once; the first one wins.
    if (this.activeRecord())
      throw new RestartRequestError("Another upgrade is already pending or running");
    const previousCommit = this.ports.currentCommit();
    if (previousCommit === sourceCommit)
      throw new RestartRequestError(`This installation already runs ${release}`);
    const now = this.ports.now().toISOString();
    const record = UpgradeRecordSchema.parse({
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
    });
    this.records = [...this.records, record];
    this.journal.write(this.records);
    return project(record);
  }

  decide(id: string, revision: string, decision: UpgradeDecision["decision"]): InstallationUpgrade {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new RestartRequestError("Upgrade not found");
    if (record.revision !== revision)
      throw new RestartRequestError("The upgrade changed. Review it again.");
    const now = this.ports.now().toISOString();
    if (
      (decision === "approve" || decision === "approve-after-work") &&
      record.status === "pending"
    )
      return project(
        this.save(record, {
          status: "approved",
          approvedAt: now,
          restart: decision === "approve" ? "now" : "after-work",
          detail: "Approved. Starting.",
        }),
      );
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
    if (decision === "acknowledge" && record.automatic && !upgradeIsActive(record))
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
        detail: `Upgraded to ${record.release}.`,
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
      result = await this.run(step.name, record);
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
    await this.ports.fetchRelease(project(record));
    return { status: "succeeded", detail: `Fetched ${record.release} (${record.sourceCommit}).` };
  }

  private async runHost(record: UpgradeRecord): Promise<StepResult> {
    const jobId = record.private.hostJobId;
    if (!jobId) {
      if (this.ports.currentCommit() === record.sourceCommit)
        return { status: "skipped", detail: "The Host already runs this release." };
      // Turning automatic updates off stops an automatic upgrade that has not restarted anything.
      if (record.automatic && !this.ports.automaticAllowed())
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
    const outcome = this.ports.coordinatorOutcome(record.id);
    if (outcome?.status === "succeeded") return { status: "succeeded", detail: outcome.detail };
    if (outcome?.status === "rolled-back") return { status: "rolled-back", detail: outcome.detail };
    if (outcome?.status === "failed") return { status: "failed", detail: outcome.detail };
    const elapsed = this.ports.now().getTime() - Date.parse(state.coordinatorLaunchedAt);
    if (elapsed < this.ports.coordinatorDeadlineMs) return { status: "waiting" };
    // The helper never reported. Judge by what this process runs.
    return this.ports.runningRelease() === state.coordinatorNext
      ? { status: "succeeded", detail: "The coordinator runs the new release." }
      : {
          status: "failed",
          detail: "The coordinator handoff did not report and the previous coordinator is running.",
        };
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
