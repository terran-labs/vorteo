import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { DelegationGrant } from "./delegated-admission.js";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import {
  SnapshotPartKindSchema,
  SnapshotRestoreStatusSchema,
  type SnapshotList,
  type SnapshotRestoreRequest,
  type SnapshotRestoreStatus,
  type SourceUpgradeStatus,
  type UpgradeStatus,
} from "@getpaseo/protocol/installation-upgrades";
import type { RestartJob, SourceUpdate } from "@getpaseo/protocol/execution-installation";
import { writePrivateFileAtomicSync } from "../private-files.js";
import type { InstallationConfig } from "./config.js";
import { connectInstallationDaemon } from "./daemon.js";
import {
  launchHandoff,
  readCurrentLink,
  readHandoffOutcome,
  type CoordinatorSwapPlan,
  type RestorePlan,
} from "./coordinator-handoff.js";
import {
  CoordinatorFollow,
  createCoordinatorFollowJournal,
  createUpgradeJournal,
  InstallationUpgrades,
  isSourceUpgrade,
  SourceUpgrades,
  upgradeTarget,
  type AdoptionOutcome,
  type SourceUpgradePorts,
  type UpgradeJob,
  type UpgradePorts,
} from "./release-upgrades.js";
import { VORTEO_RELEASE_GIT_URL, VORTEO_RELEASE_REPOSITORY } from "./release-source.js";
import {
  ReleaseUpdates,
  createUpdatePolicyStore,
  fetchCheckRuns,
  fetchGitHubReleases,
  requiredChecksOf,
  summarizeRequiredChecks,
  type ReleaseUpdatePorts,
} from "./release-updates.js";
import { RestartRequestError, type InstallationRestarts } from "./restarts.js";
import { managedServices, runCommand, type CommandRunner } from "./service-control.js";
import {
  createInstallationSnapshots,
  devContainerName,
  devHomeThroughContainer,
  dockerSnapshotPorts,
  findDocker,
  snapshotPartKinds,
  snapshotRoot,
  snapshotSources,
  SNAPSHOT_RETENTION,
  type InstallationSnapshots,
} from "./snapshots.js";
import type { InstallationSourceUpdates } from "./source-updates.js";
import { readInstallationType } from "./installation-type.js";

const COORDINATOR_READY_TIMEOUT_MS = 120_000;
const UPGRADE_REASON_PREFIX = "Release upgrade";
const SOURCE_UPGRADE_REASON_PREFIX = "Source upgrade";
/** Where source upgrades keep the fetched `main` in the source checkout. */
const SOURCE_MAIN_REF = "refs/vorteo-source-upgrade/main";
// Adoption may build the Dev and gate images and a release before it restarts anything.
const ADOPTION_DEADLINE_MS = 4 * 60 * 60_000;
const INSTALLER_ENGINE = "scripts/installer/main.mjs";
const SUPERVISOR_ENTRYPOINT = "packages/server/dist/scripts/supervisor-entrypoint.js";
const COMMIT = /^[a-f0-9]{40}$/;
/** Where a release holds the coordinator entrypoint. */
const COORDINATOR_DIRECTORY = "packages/server/dist/server/server/execution-installation";

export interface ReleaseUpgradeRuntime {
  upgrades: InstallationUpgrades | null;
  /** Owner-approved upgrades to one reviewed commit on main. Null when unavailable. */
  sourceUpgrades: SourceUpgrades | null;
  sourceUpgradeStatus(): SourceUpgradeStatus;
  /** Moves the coordinator onto the Host release that Host source updates selected. */
  coordinatorFollow: CoordinatorFollow;
  /** The update policy and release check. Null when upgrades are unavailable. */
  updates: ReleaseUpdates | null;
  /**
   * After a Host source update this process saw succeed, moves an installation from before
   * the installer to its layout, once. Upgrades from the interface do the same first.
   */
  adoptAfterSourceUpdate(): void;
  snapshots: InstallationSnapshots | null;
  snapshotList(): SnapshotList;
  /**
   * `prune: false` keeps every existing snapshot and refuses once retention is two over its limit:
   * an agent's snapshot must never delete the owner's or an upgrade's rollback point.
   */
  takeSnapshot(options?: { prune?: boolean }): ReturnType<InstallationSnapshots["take"]>;
  restore(request: SnapshotRestoreRequest): Promise<SnapshotRestoreStatus>;
  upgradeStatus(): UpgradeStatus;
}

const COORDINATOR_LINK_MISSING =
  "The installer did not record the coordinator release link. Restart the coordinator with the vorteo update command.";

/**
 * Why the coordinator cannot move itself to another release, or null. It needs the installer's
 * coordinator release link and service descriptors, and must start through that link: a
 * service pinned to one release keeps running it after the link moves.
 */
function coordinatorReplacement(
  config: InstallationConfig,
  services: ReturnType<typeof managedServices>,
  entrypoint: string,
): string | null {
  const link = config.deployment?.coordinator?.releaseLink;
  if (!link) return COORDINATOR_LINK_MISSING;
  if (typeof services === "string") return services;
  if (!entrypoint.startsWith(`${link}/`))
    return "The coordinator service starts a fixed release instead of its release link, so moving the link would not move it. Report this; the installer cannot move it either.";
  return null;
}

/** The release root a coordinator entrypoint runs from. */
export function releaseOfEntrypoint(entrypoint: string): string {
  const suffix = COORDINATOR_DIRECTORY;
  const directory = path.dirname(realpathSync(entrypoint));
  if (!directory.endsWith(suffix)) throw new Error("The coordinator does not run from a release");
  return directory.slice(0, -suffix.length - 1);
}

function readEnvImage(directory: string): string {
  const line = readFileSync(path.join(directory, ".env"), "utf8")
    .split("\n")
    .find((item) => item.startsWith("PASEO_IMAGE="));
  if (!line) throw new Error("Dev's deployment has no PASEO_IMAGE");
  return line.slice("PASEO_IMAGE=".length).trim();
}

/**
 * True for a Host installation made before the one-command installer: its configuration
 * has no `deployment` and sits beside the old installer's installation.json. Upgrades
 * move it to the installer layout first, through the engine's `adopt` command.
 */
/**
 * The folder holding installation.json at or above the config's folder. A coordinator updated
 * through a reviewed plan runs a config inside `<root>/coordinator-plans/<plan>/`, so the
 * config's own folder is not always the installation root (scripts/installer/detect.mjs).
 */
export function installationRootOf(
  configFile: string,
  installationId: string,
  levels = 3,
): string | null {
  let folder = path.dirname(path.resolve(configFile));
  for (let level = 0; level <= levels; level += 1) {
    // Only the record of this installation counts, never another installation's folder.
    if (recordInstallationId(path.join(folder, "installation.json")) === installationId)
      return folder;
    const parent = path.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return null;
}

function recordInstallationId(file: string): string | null {
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    return typeof record?.installationId === "string" ? record.installationId : null;
  } catch {
    return null;
  }
}

export function adoptionRequired(config: InstallationConfig, configFile: string): boolean {
  return (
    !config.deployment && installationRootOf(configFile, config.public.installationId) !== null
  );
}

/** Why upgrades cannot run on this installation, or null. */
export function upgradeBlocker(config: InstallationConfig, adoptable = false): string | null {
  // Adoption writes the deployment block, the release links and the service descriptors.
  if (!config.deployment && adoptable) return null;
  if (!config.deployment) return "Upgrades need an installation made by the one-command installer.";
  // An installer-made installation upgrades its Host through the engine and its link.
  if (!directHostUpgrades(config) && (!config.sourceUpdates || !config.host.startupValidation))
    return "Upgrades need Host source updates, which this installation has not configured.";
  const services = managedServices(config);
  if (typeof services === "string") return services;
  return null;
}

/**
 * Why source upgrades cannot run, or null. They need the installer layout itself; an
 * installation from before the installer moves to it through a release upgrade first.
 */
function sourceUpgradeBlocker(blocker: string | null, adoptable: boolean): string | null {
  if (blocker) return blocker;
  return adoptable
    ? "Source upgrades need an installation made by the one-command installer. Install a release upgrade first."
    : null;
}

function hostUpdateRequester(upgrade: UpgradeJob): string {
  if (isSourceUpgrade(upgrade)) return "Source upgrade";
  return upgrade.automatic ? "Automatic release update policy" : "Release upgrade";
}

/**
 * True when upgrades rebuild Dev: an installation with Dev whose deployment the installer
 * manages. Adoption records `containerDirectory` only for such a Dev; an installation not yet
 * adopted keeps the old behavior until adoption decides.
 */
function managedDev(config: InstallationConfig): boolean {
  if (config.container === undefined) return false;
  return !config.deployment || config.deployment.containerDirectory !== undefined;
}

/** True when the installer engine, not Host source updates, builds Host releases. */
function directHostUpgrades(config: InstallationConfig): boolean {
  return !config.sourceUpdates && Boolean(config.deployment?.hostReleaseLink);
}

const DIRECT_JOB_PREFIX = "installer-";

/** The revision the installer engine built into a release, from its marker file. */
function installerRevision(release: string): string | null {
  try {
    const marker = JSON.parse(readFileSync(path.join(release, ".installer-release.json"), "utf8"));
    return typeof marker.revision === "string" && COMMIT.test(marker.revision)
      ? marker.revision
      : null;
  } catch {
    return null;
  }
}

/**
 * The Host commit of an installation from before the installer: its release folder,
 * which scripts/install-execution-host.mjs names by commit, or a source receipt in it.
 */
export function legacyHostCommit(config: InstallationConfig): string | null {
  const entrypoint = config.host.startupValidation?.entrypoint;
  if (!entrypoint) return null;
  try {
    const file = realpathSync(entrypoint);
    if (!file.endsWith(`/${SUPERVISOR_ENTRYPOINT}`)) return null;
    const release = file.slice(0, -SUPERVISOR_ENTRYPOINT.length - 1);
    const marked = installerRevision(release);
    if (marked) return marked;
    const receiptFile = path.join(release, ".installation-source.json");
    if (existsSync(receiptFile)) {
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
      if (COMMIT.test(receipt.sourceCommit ?? "")) return receipt.sourceCommit;
    }
    return COMMIT.test(path.basename(release)) ? path.basename(release) : null;
  } catch {
    return null;
  }
}

/** Starts `node args` in its own session with output in `log`, so it outlives this process. */
function spawnDetached(node: string, args: string[], log: string): void {
  const descriptor = openSync(log, "a", 0o600);
  try {
    spawn(node, args, { detached: true, stdio: ["ignore", descriptor, descriptor] }).unref();
  } finally {
    closeSync(descriptor);
  }
}

function readAdoptionOutcome(file: string): AdoptionOutcome | null {
  try {
    const result = JSON.parse(readFileSync(file, "utf8"));
    if (result.status !== "succeeded" && result.status !== "failed") return null;
    return { status: result.status, detail: String(result.detail ?? "") };
  } catch {
    return null;
  }
}

/**
 * Takes an owner-reason safety snapshot. With `prune`, the oldest beyond retention go, as for the
 * owner's own snapshot. Without it nothing is removed, and the snapshot is refused once retention
 * is two over its limit, so an agent's snapshot never deletes an existing rollback point.
 */
export async function takeSafetySnapshot(
  snapshots: Pick<InstallationSnapshots, "list" | "take" | "prune">,
  prune: boolean,
) {
  if (!prune && snapshots.list().length >= SNAPSHOT_RETENTION + 2)
    throw new RestartRequestError(
      "Snapshot retention is full. Ask the owner to take the next snapshot in Installation controls, which removes the oldest.",
    );
  const snapshot = await snapshots.take({ reason: "owner" });
  if (prune) snapshots.prune([snapshot.id]);
  return snapshot;
}

export function createReleaseUpgradeRuntime(input: {
  config: InstallationConfig;
  configFile: string;
  restarts: InstallationRestarts;
  hostUpdates: InstallationSourceUpdates | null;
  logger: Logger;
  run?: CommandRunner;
  entrypoint?: string;
  /** Replaces the GitHub Releases API in tests. */
  listReleases?: ReleaseUpdatePorts["listReleases"];
  /** Another coordinator restart, such as a settings change, that blocks upgrades and follows. */
  conflict?: () => string | null;
  /**
   * The shared coordinator restart check for a coordinator update: other coordinator
   * restarts, approved Host jobs and open coordinator requests.
   */
  coordinatorFollowConflict?: () => string | null;
  /** The active full maintenance grant; a Host-agent coordinator update is delegated under it. */
  delegationGrant?: () => DelegationGrant | null;
}): ReleaseUpgradeRuntime {
  const { config, configFile, restarts, hostUpdates, logger } = input;
  const run = input.run ?? runCommand;
  const entrypoint = input.entrypoint ?? process.argv[1] ?? "";
  // Resolved once: a link moved later without a restart must not pass for the new release.
  const startedRelease: { release: string } | { error: unknown } = (() => {
    try {
      return { release: releaseOfEntrypoint(entrypoint) };
    } catch (error) {
      return { error };
    }
  })();
  const root = snapshotRoot(config);
  const snapshots = root
    ? createInstallationSnapshots({
        root,
        sources: () =>
          devHomeThroughContainer(snapshotSources(config, configFile), {
            platform: process.platform,
            docker: findDocker(),
            container: devContainerName(config.deployment?.containerDirectory),
          }),
        ports: { now: () => new Date(), ...dockerSnapshotPorts },
      })
    : null;
  const upgradeDirectory = path.join(config.stateDir, "upgrades");
  const followDirectory = path.join(config.stateDir, "coordinator-follow");
  const restoreDirectory = root ? path.join(root, ".restores") : null;
  const services = managedServices(config);
  const adoptable = adoptionRequired(config, configFile);
  const blocker = upgradeBlocker(config, adoptable);
  const health = {
    url: `http://127.0.0.1:${config.listenPort}/api/installation/health`,
    installationId: config.public.installationId,
    previousPid: process.pid,
  };
  const hostNode = config.host.startupValidation?.node ?? process.execPath;
  const helper = () =>
    path.join(path.dirname(realpathSync(entrypoint)), "coordinator-handoff-main.js");

  function currentCommit(): string | null {
    const link = config.deployment?.hostReleaseLink;
    if (directHostUpgrades(config) && link) {
      try {
        return installerRevision(realpathSync(link));
      } catch {
        return null;
      }
    }
    try {
      const base = hostUpdates?.source().baseCommit;
      if (base) return base;
    } catch {
      /* Host source updates are unconfigured or unreadable */
    }
    return config.deployment ? null : legacyHostCommit(config);
  }

  const directOutcome = (upgradeId: string) =>
    path.join(upgradeDirectory, upgradeId, "host-release.json");

  /** Starts the engine's Host release build detached, so it survives this coordinator. */
  /**
   * Whether the source checkout's installer engine can build the Host release without
   * restarting the Host. Its parser refuses unknown options before writing an outcome, so
   * an older engine given the option would leave the upgrade waiting.
   */
  function engineBuildsOnly(): boolean {
    const deployment = config.deployment;
    if (!deployment || !directHostUpgrades(config)) return false;
    try {
      return readFileSync(path.join(deployment.sourceDirectory, INSTALLER_ENGINE), "utf8").includes(
        '"build-only"',
      );
    } catch {
      return false;
    }
  }

  const hostBuildOutcome = (upgradeId: string) =>
    path.join(upgradeDirectory, upgradeId, "host-build.json");

  function launchHostBuild(upgrade: UpgradeJob): void {
    const deployment = config.deployment;
    if (!deployment) throw new Error("The installation deployment is unknown");
    const directory = path.join(upgradeDirectory, upgrade.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(hostBuildOutcome(upgrade.id))) return;
    spawnDetached(
      hostNode,
      [
        path.join(deployment.sourceDirectory, INSTALLER_ENGINE),
        "host-release",
        "--build-only",
        "--root",
        deployment.installRoot,
        "--revision",
        upgrade.sourceCommit,
        "--outcome",
        hostBuildOutcome(upgrade.id),
      ],
      path.join(directory, "host-build.log"),
    );
  }

  function launchDirectHostRelease(upgrade: UpgradeJob): string {
    const deployment = config.deployment;
    if (!deployment) throw new Error("The installation deployment is unknown");
    const directory = path.join(upgradeDirectory, upgrade.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const outcome = directOutcome(upgrade.id);
    if (!existsSync(outcome))
      spawnDetached(
        hostNode,
        [
          path.join(deployment.sourceDirectory, INSTALLER_ENGINE),
          "host-release",
          "--root",
          deployment.installRoot,
          "--revision",
          upgrade.sourceCommit,
          "--outcome",
          outcome,
        ],
        path.join(directory, "host-release.log"),
      );
    return `${DIRECT_JOB_PREFIX}${upgrade.id}`;
  }

  /** The installer engine in the coordinator's own release, else in the Host's. */
  function adoptionEngine(): string {
    const releases: string[] = [];
    try {
      releases.push(releaseOfEntrypoint(entrypoint));
    } catch {
      /* not started from a release */
    }
    if (config.sourceUpdates) {
      try {
        releases.push(realpathSync(config.sourceUpdates.currentReleaseLink));
      } catch {
        /* no Host release selected */
      }
    }
    const engine = releases
      .map((release) => path.join(release, INSTALLER_ENGINE))
      .find((file) => existsSync(file));
    if (!engine) throw new Error("No release of this installation has the installer engine");
    return engine;
  }

  /** Runs the engine's `adopt` on this installation's root, detached; it restarts this process. */
  /** dev-release.mjs beside the installer engine this coordinator would run, if it has one. */
  function devReleaseTool(): string | null {
    try {
      const tool = path.join(path.dirname(adoptionEngine()), "dev-release.mjs");
      return existsSync(tool) ? tool : null;
    } catch {
      return null;
    }
  }

  async function devReleaseCommand(
    tool: string,
    command: string,
    commit?: string,
    timeoutMs = 300_000,
  ): Promise<string> {
    const deployment = config.deployment;
    if (!deployment?.containerDirectory || !deployment.sourceDirectory)
      throw new Error("Dev's deployment or source directory is unknown");
    return run(
      hostNode,
      [
        tool,
        command,
        "--deployment",
        deployment.containerDirectory,
        "--source",
        deployment.sourceDirectory,
        ...(commit ? ["--commit", commit] : []),
        ...(commit ? hostReleaseArguments(commit) : []),
      ],
      { timeoutMs },
    );
  }

  /**
   * The Host release built for `commit`, so Dev builds install its compiled packages.
   * dev-release.mjs checks the release's marker and builds from source when it does not
   * match, so a guess here never puts other code into Dev.
   */
  function hostReleaseArguments(commit: string): string[] {
    const link = config.deployment?.hostReleaseLink ?? config.sourceUpdates?.currentReleaseLink;
    if (!link) return [];
    const candidates = [path.join(path.dirname(link), commit)];
    try {
      candidates.push(realpathSync(link));
    } catch {
      /* no Host release selected */
    }
    const release = candidates.find((item) =>
      existsSync(path.join(item, ".installer-release.json")),
    );
    return [
      ...(release ? ["--host-release", release] : []),
      "--npm",
      path.join(path.dirname(hostNode), "npm"),
    ];
  }

  function launchAdoptionEngine(directory: string): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    spawnDetached(
      hostNode,
      [
        adoptionEngine(),
        "adopt",
        "--root",
        installationRootOf(configFile, config.public.installationId) ?? path.dirname(configFile),
        "--outcome",
        path.join(directory, "adoption.json"),
      ],
      path.join(directory, "adoption.log"),
    );
    logger.info({ directory }, "Installation adoption started");
  }

  const succeededHostUpdate = (job: RestartJob) =>
    job.target === "host" &&
    job.update !== undefined &&
    job.status === "succeeded" &&
    !job.reason.startsWith(UPGRADE_REASON_PREFIX) &&
    !job.reason.startsWith(SOURCE_UPGRADE_REASON_PREFIX);
  // Source updates that finished before this process started never trigger adoption.
  const earlierUpdates = new Set<string>();
  if (adoptable) {
    try {
      for (const job of restarts.list()) if (succeededHostUpdate(job)) earlierUpdates.add(job.id);
    } catch {
      /* the restart journal is unreadable; no update can trigger adoption */
    }
  }

  function adoptAfterSourceUpdate(): void {
    if (!adoptable) return;
    const directory = path.join(config.stateDir, "adoption");
    const launch = path.join(directory, "launch.json");
    // One automatic attempt; an upgrade from the interface retries after a failure.
    if (existsSync(launch)) return;
    const job = restarts
      .list()
      .find((item) => succeededHostUpdate(item) && !earlierUpdates.has(item.id));
    if (!job) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(
      launch,
      JSON.stringify({ jobId: job.id, launchedAt: new Date().toISOString() }, null, 2),
    );
    try {
      launchAdoptionEngine(directory);
    } catch (error) {
      logger.error({ err: error }, "Installation adoption could not start");
    }
  }

  async function git(args: string[], timeoutMs = 300_000) {
    return (await run("git", args, { timeoutMs })).trim();
  }

  /** Stage base..release as a bundle with the integration ref, exactly as Host agents upload. */
  async function stageHostUpdate(upgrade: UpgradeJob): Promise<SourceUpdate> {
    const settings = config.sourceUpdates;
    const source = config.deployment?.sourceDirectory;
    const base = currentCommit();
    if (!settings || !source || !hostUpdates || !base)
      throw new Error("Host source updates are unavailable");
    const work = path.join(upgradeDirectory, upgrade.id);
    const scratch = path.join(work, "bundle.git");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    await git(["init", "--bare", "--quiet", scratch]);
    // Fetch by ref, not by object ID: a local upload-pack may refuse unadvertised objects.
    // The release contains the installed commit, so its history brings the bundle's base.
    const temporary = `refs/vorteo-upgrade/${upgrade.id}`;
    await git(["-C", source, "update-ref", temporary, upgrade.sourceCommit]);
    try {
      await git([
        "-C",
        scratch,
        "fetch",
        "--quiet",
        "--no-tags",
        source,
        `${temporary}:${settings.integrationRef}`,
      ]);
    } finally {
      await git(["-C", source, "update-ref", "-d", temporary]);
    }
    await git(["-C", scratch, "merge-base", "--is-ancestor", base, upgrade.sourceCommit]).catch(
      () => {
        throw new Error(
          `${upgradeTarget(upgrade)} does not contain the installed Host source ${base}.`,
        );
      },
    );
    const bundle = path.join(work, "release.bundle");
    rmSync(bundle, { force: true });
    await git([
      "-C",
      scratch,
      "bundle",
      "create",
      "--quiet",
      bundle,
      settings.integrationRef,
      `^${base}`,
    ]);
    const bytes = readFileSync(bundle);
    const update: SourceUpdate = {
      sourceCommit: upgrade.sourceCommit,
      baseCommit: base,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    hostUpdates.stage(update, bytes);
    return update;
  }

  function upgradeJob(upgradeId: string): RestartJob | undefined {
    return restarts
      .list()
      .find((job) => job.target === "host" && job.reason.includes(upgradeId) && job.update);
  }

  /** Starts the detached helper that swaps the coordinator release; it restarts this process. */
  function launchCoordinatorSwap(directory: string, id: string, next: string, previous: string) {
    const link = config.deployment?.coordinator?.releaseLink;
    if (!link || typeof services === "string")
      throw new Error("Coordinator replacement is unavailable");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const plan: CoordinatorSwapPlan = {
      kind: "coordinator-swap",
      id,
      releaseLink: link,
      previous,
      next,
      services,
      health,
      outcomeFile: path.join(directory, "coordinator-handoff.json"),
      timeoutMs: COORDINATOR_READY_TIMEOUT_MS,
    };
    launchHandoff({
      node: process.execPath,
      helper: helper(),
      planFile: path.join(directory, "coordinator-handoff-plan.json"),
      logFile: path.join(directory, "coordinator-handoff.log"),
      plan,
    });
    logger.info({ id, next }, "Coordinator handoff started");
  }

  /** True when the Host commit was installed by a source upgrade. */
  function sourceInstalled(commit: string): boolean {
    return Boolean(
      sourceUpgrades
        ?.list()
        .some(
          (item) =>
            item.sourceCommit === commit &&
            item.steps.some((step) => step.name === "host" && step.status === "succeeded"),
        ),
    );
  }

  /** Fetches `main` of the release repository into the source checkout's source-upgrade ref. */
  async function fetchMain(source: string): Promise<void> {
    await git([
      "-C",
      source,
      "fetch",
      "--quiet",
      "--no-tags",
      VORTEO_RELEASE_GIT_URL,
      `+refs/heads/main:${SOURCE_MAIN_REF}`,
    ]);
  }

  /** True when `ancestor` is an ancestor of, or equal to, `commit` in the source checkout. */
  async function contains(source: string, commit: string, ancestor: string): Promise<boolean> {
    try {
      await git(["-C", source, "merge-base", "--is-ancestor", ancestor, commit]);
      return true;
    } catch {
      return false;
    }
  }

  /** The fetch step of a source upgrade: the commit must still be on main. */
  async function fetchSource(source: string, upgrade: UpgradeJob): Promise<void> {
    if (!isSourceUpgrade(upgrade)) throw new Error("Not a source upgrade");
    if (upgrade.rollbackOf) {
      // A rollback reselects a release already built; nothing is fetched.
      const refusal = rollbackBlocker(upgrade.sourceCommit);
      if (refusal) throw new Error(refusal);
      return;
    }
    await fetchMain(source);
    if (!(await contains(source, SOURCE_MAIN_REF, upgrade.sourceCommit)))
      throw new Error(
        `Commit ${upgrade.sourceCommit} is no longer on main. Nothing was restarted. Request the source upgrade again.`,
      );
    if (
      upgrade.previousCommit &&
      !(await contains(source, upgrade.sourceCommit, upgrade.previousCommit))
    )
      throw new Error(
        `Commit ${upgrade.sourceCommit} does not contain the Host commit it was reviewed against.`,
      );
  }

  /** Why the Host release built for `commit` cannot be selected again without a build, or null. */
  function rollbackBlocker(commit: string): string | null {
    const link = config.deployment?.hostReleaseLink;
    if (!directHostUpgrades(config) || !link)
      return "Rolling back needs a Host the installer builds. This Host updates through Host source updates, which cannot install an older commit.";
    if (installerRevision(path.join(path.dirname(link), commit)) !== commit)
      return `The Host release of ${commit.slice(0, 12)} is no longer installed, so it cannot be selected again.`;
    return null;
  }

  async function lastRelease(commit: string): Promise<string | null> {
    const source = config.deployment?.sourceDirectory;
    if (!source) return null;
    try {
      return await git(
        ["-C", source, "describe", "--tags", "--abbrev=0", "--match", "release-*", commit],
        30_000,
      );
    } catch {
      return null;
    }
  }

  /**
   * Reads the required check names from the commit's own `main` ruleset and their results from
   * the public GitHub API. Anything it cannot read refuses the request; it never passes blind.
   */
  async function requiredChecks(source: string, commit: string) {
    try {
      const ruleset = await git(
        ["-C", source, "show", `${commit}:.github/rulesets/main.json`],
        30_000,
      );
      return summarizeRequiredChecks(await fetchCheckRuns(commit), requiredChecksOf(ruleset));
    } catch (error) {
      return {
        passed: false,
        detail: `they could not be verified (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
  }

  const ports: UpgradePorts = {
    now: () => new Date(),
    conflict: () => {
      // `coordinatorFollow` and `sourceUpgrades` are created below from these ports; they exist
      // before any upgrade runs.
      if (coordinatorFollow.dispatching())
        return "Wait for the coordinator update to finish before upgrading.";
      if (sourceUpgrades?.dispatching())
        return "Wait for the source upgrade to finish before upgrading.";
      return input.conflict?.() ?? null;
    },
    adoptionRequired: adoptable,
    launchAdoption: (upgrade) => launchAdoptionEngine(path.join(upgradeDirectory, upgrade.id)),
    adoptionOutcome: (upgradeId) =>
      readAdoptionOutcome(path.join(upgradeDirectory, upgradeId, "adoption.json")),
    adoptionDeadlineMs: ADOPTION_DEADLINE_MS,
    hasContainer: managedDev(config),
    devUnmanaged: config.container !== undefined && !managedDev(config),
    coordinatorReplacement: config.deployment?.coordinator ? null : COORDINATOR_LINK_MISSING,
    currentCommit,
    // `updates` is created below from these ports; it exists before any upgrade runs.
    automaticAllowed: () => updates?.policy().mode === "automatic",
    directHost: directHostUpgrades(config),
    async busy(target) {
      try {
        const impact = (await restarts.impacts()).find((item) => item.target === target);
        if (!impact) return "agent activity is unknown.";
        if (impact.error) return impact.error;
        const working = impact.agents.length + impact.pendingStarts;
        return working === 0
          ? null
          : `${working} ${working === 1 ? "agent" : "agents"} still working.`;
      } catch (error) {
        return error instanceof Error ? error.message : "agent activity is unknown.";
      }
    },
    async resolveRelease(release) {
      const output = await run(
        "git",
        [
          "ls-remote",
          "--tags",
          VORTEO_RELEASE_GIT_URL,
          `refs/tags/${release}`,
          `refs/tags/${release}^{}`,
        ],
        { timeoutMs: 30_000 },
      );
      const lines = output.trim().split("\n").filter(Boolean);
      // An annotated tag lists its object and the peeled commit (^{}); prefer the commit.
      const line = lines.find((item) => item.endsWith("^{}")) ?? lines[0];
      const commit = line?.split(/\s+/)[0];
      if (!commit || !/^[a-f0-9]{40}$/.test(commit))
        throw new RestartRequestError(
          `Release ${release} was not found in ${VORTEO_RELEASE_REPOSITORY}`,
        );
      return commit;
    },
    async snapshot(upgrade) {
      if (!snapshots) throw new Error("Snapshots are unavailable");
      const snapshot = await snapshots.take({
        reason: "upgrade",
        upgradeId: upgrade.id,
        ...(isSourceUpgrade(upgrade) ? {} : { release: upgrade.release }),
      });
      snapshots.prune([snapshot.id]);
      return snapshot.id;
    },
    async fetchRelease(upgrade) {
      const source = config.deployment?.sourceDirectory;
      if (!source) throw new Error("The source directory is unknown");
      if (isSourceUpgrade(upgrade)) return fetchSource(source, upgrade);
      const ref = `refs/tags/${upgrade.release}`;
      await git([
        "-C",
        source,
        "fetch",
        "--quiet",
        "--no-tags",
        VORTEO_RELEASE_GIT_URL,
        `+${ref}:${ref}`,
      ]);
      const commit = await git(["-C", source, "rev-parse", `${ref}^{commit}`]);
      if (commit !== upgrade.sourceCommit)
        throw new Error(
          `Release ${upgrade.release} now names ${commit}, not the reviewed ${upgrade.sourceCommit}. Request the upgrade again.`,
        );
      // A Host the installer builds takes any revision, so a release cut without a commit a
      // source upgrade installed would silently drop it. Restart-queue Hosts refuse that when
      // staging the bundle.
      const installed = currentCommit();
      if (installed && sourceInstalled(installed) && !(await contains(source, commit, installed)))
        throw new Error(
          `Release ${upgrade.release} does not contain commit ${installed.slice(0, 12)}, which a source upgrade installed. Nothing was restarted. Wait for a release that includes it.`,
        );
    },
    async requestHostUpdate(upgrade) {
      if (directHostUpgrades(config)) return launchDirectHostRelease(upgrade);
      // A coordinator that restarted after creating the job reuses it.
      const existing = upgradeJob(upgrade.id);
      if (existing) return existing.id;
      const update = await stageHostUpdate(upgrade);
      const job = restarts.request(
        {
          target: "host",
          reason: `${isSourceUpgrade(upgrade) ? SOURCE_UPGRADE_REASON_PREFIX : UPGRADE_REASON_PREFIX} to ${upgradeTarget(upgrade)} (${upgrade.id})`,
          requester: hostUpdateRequester(upgrade),
        },
        "owner",
        update,
      );
      // The owner, or the owner's automatic update policy, approved this exact release or
      // commit; the bundle is derived from that reviewed commit. An upgrade approved to install after current
      // work takes the automatic updates' path: hold new work, build, then restart when idle.
      if (upgrade.restart === "after-work")
        restarts.decide(job.id, job.revision, "finish-current-turns", update.sha256);
      else restarts.decide(job.id, job.revision, "approve", update.sha256);
      return job.id;
    },
    get directHostBuild() {
      return engineBuildsOnly();
    },
    launchHostBuild,
    // A cold Host build installs dependencies and compiles the server, app and web UI.
    hostBuildDeadlineMs: 2 * 60 * 60_000,
    hostBuild(upgradeId) {
      const outcome = hostBuildOutcome(upgradeId);
      if (!existsSync(outcome)) return { status: "running", detail: "Building the Host release." };
      const result = JSON.parse(readFileSync(outcome, "utf8"));
      return result.status === "succeeded"
        ? { status: "succeeded", detail: String(result.detail) }
        : { status: "failed", detail: String(result.detail ?? "The Host release failed.") };
    },
    hostUpdate(jobId) {
      if (jobId.startsWith(DIRECT_JOB_PREFIX)) {
        const outcome = directOutcome(jobId.slice(DIRECT_JOB_PREFIX.length));
        if (!existsSync(outcome))
          return { status: "running", detail: "Building the Host release." };
        const result = JSON.parse(readFileSync(outcome, "utf8"));
        return result.status === "succeeded"
          ? { status: "succeeded", detail: String(result.detail) }
          : { status: "failed", detail: String(result.detail ?? "The Host release failed.") };
      }
      const job = restarts.list().find((item) => item.id === jobId);
      if (!job) return { status: "failed", detail: "The Host update request disappeared." };
      if (job.status === "succeeded") return { status: "succeeded", detail: job.detail };
      if (job.status === "failed" || job.status === "rejected")
        return { status: "failed", detail: job.detail };
      return { status: "running", detail: job.detail };
    },
    hostRelease() {
      const link = config.deployment?.hostReleaseLink;
      if (directHostUpgrades(config) && link) return realpathSync(link);
      if (!config.sourceUpdates) throw new Error("Host source updates are unavailable");
      return realpathSync(config.sourceUpdates.currentReleaseLink);
    },
    runningRelease: () => {
      if ("error" in startedRelease) throw startedRelease.error;
      return startedRelease.release;
    },
    coordinatorRelease() {
      const link = config.deployment?.coordinator?.releaseLink;
      if (!link) throw new Error("The coordinator release link is unknown");
      return readCurrentLink(link);
    },
    launchCoordinatorSwap: (upgrade, next, previous) =>
      launchCoordinatorSwap(path.join(upgradeDirectory, upgrade.id), upgrade.id, next, previous),
    coordinatorOutcome: (upgradeId) =>
      readHandoffOutcome(path.join(upgradeDirectory, upgradeId, "coordinator-handoff.json")),
    // Two readiness windows (new release, then rollback) plus restart slack.
    coordinatorDeadlineMs: COORDINATOR_READY_TIMEOUT_MS * 2 + 60_000,
    async prepareDev(upgrade) {
      const tool = devReleaseTool();
      // A coordinator release without the tool upgrades Dev the way it always has.
      if (!tool) return "image";
      const result = JSON.parse(await devReleaseCommand(tool, "prepare", upgrade.sourceCommit));
      logger.info({ upgradeId: upgrade.id, devMode: result.mode }, String(result.reason));
      return result.mode === "release" ? "release" : "image";
    },
    async devUpgradeMode(upgrade) {
      const tool = devReleaseTool();
      if (!tool) return "image";
      const result = JSON.parse(await devReleaseCommand(tool, "mode", upgrade.sourceCommit));
      logger.info({ upgradeId: upgrade.id, devMode: result.mode }, String(result.reason));
      return result.mode === "release" ? "release" : "image";
    },
    async refreshDevScripts(upgrade) {
      const tool = devReleaseTool();
      if (tool) await devReleaseCommand(tool, "refresh", upgrade.sourceCommit);
    },
    async hasDevImage(image) {
      try {
        await run("docker", ["image", "inspect", image]);
        return true;
      } catch {
        return false;
      }
    },
    async devRelease() {
      const tool = devReleaseTool();
      if (!tool) return "none";
      return String(JSON.parse(await devReleaseCommand(tool, "current")).release);
    },
    async buildDevRelease(upgrade) {
      const tool = devReleaseTool();
      if (!tool) throw new Error("This coordinator release cannot build Dev releases");
      await devReleaseCommand(tool, "build", upgrade.sourceCommit, 60 * 60_000);
    },
    async selectDevRelease(release) {
      const directory = config.deployment?.containerDirectory;
      if (!directory) throw new Error("Dev's deployment directory is unknown");
      // update.sh restores the previous selection itself when Dev is unhealthy on this one.
      await run("/bin/bash", [path.join(directory, "update.sh"), "--release", release], {
        timeoutMs: 15 * 60_000,
      });
    },
    async pruneDevReleases() {
      const tool = devReleaseTool();
      if (tool) await devReleaseCommand(tool, "prune");
    },
    async devImage() {
      const directory = config.deployment?.containerDirectory;
      if (!directory) throw new Error("Dev's deployment directory is unknown");
      return readEnvImage(directory);
    },
    async buildDevImage(upgrade) {
      const tool = devReleaseTool();
      if (tool)
        return String(
          JSON.parse(await devReleaseCommand(tool, "image", upgrade.sourceCommit, 90 * 60_000))
            .image,
        );
      // A coordinator release without the tool builds the image itself, from source.
      const source = config.deployment?.sourceDirectory;
      if (!source) throw new Error("The source directory is unknown");
      const work = path.join(upgradeDirectory, upgrade.id);
      const context = path.join(work, "dev-source");
      rmSync(context, { recursive: true, force: true });
      mkdirSync(context, { recursive: true, mode: 0o700 });
      const archive = path.join(work, "dev-source.tar");
      await git([
        "-C",
        source,
        "archive",
        "--format=tar",
        `--output=${archive}`,
        upgrade.sourceCommit,
      ]);
      await run("tar", ["-xf", archive, "-C", context], { timeoutMs: 300_000 });
      const iid = path.join(work, "dev-image.iid");
      rmSync(iid, { force: true });
      await run(
        "docker",
        [
          "build",
          "--build-arg",
          `PASEO_BUILD_COMMIT=${upgrade.sourceCommit}`,
          "--iidfile",
          iid,
          "-f",
          path.join(context, "docker/base/Dockerfile"),
          context,
        ],
        { timeoutMs: 90 * 60_000 },
      );
      return readFileSync(iid, "utf8").trim();
    },
    async replaceDevImage(image) {
      const directory = config.deployment?.containerDirectory;
      if (!directory) throw new Error("Dev's deployment directory is unknown");
      // update.sh waits for health and restores the previous image itself on failure.
      await run("/bin/bash", [path.join(directory, "update.sh"), image], {
        timeoutMs: 15 * 60_000,
      });
    },
    async verifyDev() {
      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          const client = await connectInstallationDaemon(config, "container");
          try {
            await client.getDaemonStatus({ timeout: 15_000 });
            return;
          } finally {
            await client.close();
          }
        } catch (error) {
          if (Date.now() > deadline)
            throw new Error("The coordinator cannot reach the recreated Dev daemon", {
              cause: error,
            });
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    },
  };

  const upgrades = blocker
    ? null
    : new InstallationUpgrades(createUpgradeJournal(upgradeDirectory), ports);

  const sourceBlocker = sourceUpgradeBlocker(blocker, adoptable);
  const sourcePorts: SourceUpgradePorts = {
    ...ports,
    adoptionRequired: false,
    conflict: () => {
      if (upgrades?.dispatching()) return "Wait for the release upgrade to finish.";
      if (coordinatorFollow.dispatching()) return "Wait for the coordinator update to finish.";
      return input.conflict?.() ?? null;
    },
    async inspectSource(commit, installed) {
      const source = config.deployment?.sourceDirectory;
      if (!source) throw new RestartRequestError("The source directory is unknown");
      try {
        await fetchMain(source);
      } catch (error) {
        throw new RestartRequestError(
          `main could not be fetched from ${VORTEO_RELEASE_REPOSITORY}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const onMain = await contains(source, SOURCE_MAIN_REF, commit);
      const containsInstalled = onMain && (await contains(source, commit, installed));
      return {
        onMain,
        containsInstalled,
        checks:
          onMain && containsInstalled
            ? await requiredChecks(source, commit)
            : { passed: false, detail: "not checked." },
        lastRelease: onMain ? await lastRelease(commit) : null,
      };
    },
    lastRelease,
    rollbackBlocker,
    async installationBlocker() {
      try {
        if ((await readInstallationType(config.stateDir)).type === "stable") return null;
        return "The installation became Lab, so the source upgrade stopped.";
      } catch {
        return "The installation type is unreadable, so the source upgrade stopped.";
      }
    },
  };
  const sourceUpgrades = sourceBlocker
    ? null
    : new SourceUpgrades(
        createUpgradeJournal(path.join(config.stateDir, "source-upgrades")),
        sourcePorts,
      );

  const coordinatorFollow = new CoordinatorFollow(createCoordinatorFollowJournal(followDirectory), {
    now: () => new Date(),
    replacement: coordinatorReplacement(config, services, entrypoint),
    // Checked at request, approval and dispatch: never restart the coordinator under other
    // lifecycle work it coordinates.
    conflict: () => {
      if (upgrades?.active()) return "Wait for the release upgrade to finish.";
      if (sourceUpgrades?.active()) return "Wait for the source upgrade to finish.";
      return input.coordinatorFollowConflict?.() ?? null;
    },
    hostRelease: () => ports.hostRelease(),
    runningRelease: () => ports.runningRelease(),
    coordinatorRelease: () => ports.coordinatorRelease(),
    coordinatorDeadlineMs: ports.coordinatorDeadlineMs,
    hasCoordinator: (release) =>
      existsSync(path.join(release, COORDINATOR_DIRECTORY, path.basename(entrypoint))),
    launchSwap: (job, next, previous) =>
      launchCoordinatorSwap(path.join(followDirectory, job.id), job.id, next, previous),
    delegationGrant: () => input.delegationGrant?.() ?? null,
    cancellationDelayMs: 30_000,
    swapOutcome: (jobId) =>
      readHandoffOutcome(path.join(followDirectory, jobId, "coordinator-handoff.json")),
  });

  /** The version in the selected Host release's manifest, such as 26.10.3001. */
  function installedVersion(): string | null {
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(ports.hostRelease(), "package.json"), "utf8"),
      );
      return typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      return null;
    }
  }

  const updates = upgrades
    ? new ReleaseUpdates(
        createUpdatePolicyStore(config.stateDir),
        upgrades,
        {
          now: () => new Date(),
          listReleases: input.listReleases ?? (() => fetchGitHubReleases()),
          installedVersion,
        },
        logger,
      )
    : null;
  void updates?.load();

  function upgradeDetail(): string {
    if (blocker) return blocker;
    // Before adoption the coordinator cannot tell whether Dev is installer-managed; the
    // adoption plan decides, and leaves an unmanaged Dev untouched.
    const dev = managedDev(config);
    const steps = dev
      ? "takes a snapshot, then restarts the Host daemon, replaces the coordinator and recreates the Dev container."
      : "takes a snapshot, then restarts the Host daemon and replaces the coordinator.";
    return adoptable
      ? "This installation predates the one-command installer. An upgrade first moves it to the installer layout in place, then takes a snapshot, restarts the Host daemon and replaces the coordinator. A Dev the installer made also moves to gate mode and is recreated; any other Dev is left exactly as it is."
      : `An upgrade ${steps}${config.container && !dev ? " Dev is not managed by the installer and is left as it is." : ""}`;
  }

  function readRestoreStatus(): SnapshotRestoreStatus | null {
    if (!restoreDirectory) return null;
    const file = path.join(restoreDirectory, "latest.json");
    if (!existsSync(file)) return null;
    try {
      return SnapshotRestoreStatusSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  /** The release the installed Host commit came from, or the one a source upgrade is ahead of. */
  function installedRelease(commit: string): { release: string | null; aheadOf: string | null } {
    const release = upgrades
      ?.list()
      .find((item) => item.status === "succeeded" && item.sourceCommit === commit)?.release;
    if (release) return { release, aheadOf: null };
    const source = sourceUpgrades
      ?.list()
      .find((item) => item.status === "succeeded" && item.sourceCommit === commit);
    return { release: null, aheadOf: source ? source.lastRelease : null };
  }

  function sourceUpgradeStatus(): SourceUpgradeStatus {
    const commit = currentCommit();
    const installed = commit ? installedRelease(commit) : null;
    const ahead = Boolean(
      commit &&
      !installed?.release &&
      sourceUpgrades
        ?.list()
        .some((item) => item.status === "succeeded" && item.sourceCommit === commit),
    );
    return {
      available: sourceUpgrades !== null,
      detail:
        sourceBlocker ??
        "A source upgrade installs one reviewed commit from main the way a release upgrade installs a release. The owner approves each one.",
      current: commit
        ? {
            sourceCommit: commit,
            lastRelease: installed?.release ?? installed?.aheadOf ?? null,
            ahead,
          }
        : null,
      rollback: sourceUpgrades?.rollbackOffer() ?? {
        available: false,
        detail: sourceBlocker ?? "",
      },
      upgrades: sourceUpgrades?.list() ?? [],
    };
  }

  return {
    upgrades,
    sourceUpgrades,
    sourceUpgradeStatus,
    coordinatorFollow,
    updates,
    adoptAfterSourceUpdate,
    snapshots,
    snapshotList() {
      return {
        available: snapshots !== null,
        detail: snapshots
          ? `Snapshots are kept in ${snapshots.root}.`
          : "Snapshots need an installation made by the one-command installer.",
        retention: SNAPSHOT_RETENTION,
        snapshots: snapshots?.list() ?? [],
        restore: readRestoreStatus(),
      };
    },
    async takeSnapshot(options = {}) {
      if (!snapshots)
        throw new RestartRequestError("Snapshots are unavailable on this installation");
      return takeSafetySnapshot(snapshots, options.prune ?? true);
    },
    async restore(request) {
      if (!snapshots || !restoreDirectory)
        throw new RestartRequestError("Snapshots are unavailable on this installation");
      if (typeof services === "string") throw new RestartRequestError(services);
      if (upgrades?.active()?.status === "running" || sourceUpgrades?.dispatching())
        throw new RestartRequestError("Wait for the running upgrade to finish before restoring");
      if (readRestoreStatus()?.status === "running")
        throw new RestartRequestError("A restore is already running");
      const snapshot = snapshots.read(request.id);
      const confirmed = [
        ...new Set(request.parts.map((part) => SnapshotPartKindSchema.parse(part))),
      ].sort();
      if (JSON.stringify(confirmed) !== JSON.stringify(snapshotPartKinds(snapshot)))
        throw new RestartRequestError("The snapshot's contents changed. Review the restore again.");
      // An older snapshot can hold Dev's home; never write it into a Dev this installation
      // does not manage.
      if (!services.dev && snapshot.parts.some((part) => part.kind === "dev-home"))
        throw new RestartRequestError(
          "This snapshot holds Dev's home, but Dev is not managed by the installer here. Restore it by hand if needed.",
        );
      // Check every stored part before stopping anything.
      snapshots.storedParts(snapshot);
      // The current state stays restorable: take one more snapshot before replacing it.
      const before = await snapshots.take({ reason: "restore" });
      snapshots.prune([before.id, snapshot.id]);
      const id = randomUUID();
      const now = new Date().toISOString();
      const status: SnapshotRestoreStatus = {
        id,
        snapshotId: snapshot.id,
        status: "running",
        step: "Starting the restore helper",
        detail: `The state before this restore is saved as snapshot ${before.id}.`,
        startedAt: now,
        updatedAt: now,
      };
      const statusFile = path.join(restoreDirectory, "latest.json");
      writePrivateFileAtomicSync(statusFile, JSON.stringify(status, null, 2));
      const plan: RestorePlan = {
        kind: "restore",
        id,
        snapshotRoot: snapshots.root,
        snapshotId: snapshot.id,
        services,
        health,
        statusFile,
        timeoutMs: COORDINATOR_READY_TIMEOUT_MS,
      };
      launchHandoff({
        node: process.execPath,
        helper: helper(),
        planFile: path.join(restoreDirectory, `${id}.plan.json`),
        logFile: path.join(restoreDirectory, `${id}.log`),
        plan,
      });
      logger.info({ snapshotId: snapshot.id, restoreId: id }, "Snapshot restore started");
      return status;
    },
    upgradeStatus() {
      const commit = currentCommit();
      const installed = commit ? installedRelease(commit) : null;
      return {
        available: upgrades !== null,
        detail: upgradeDetail(),
        repository: VORTEO_RELEASE_REPOSITORY,
        current: commit
          ? {
              sourceCommit: commit,
              release: installed?.release ?? null,
              ...(installed?.aheadOf ? { aheadOf: installed.aheadOf } : {}),
            }
          : null,
        container: managedDev(config),
        upgrades: upgrades?.list() ?? [],
        ...(updates ? { policy: updates.policy(), check: updates.lastCheck() } : {}),
      };
    },
  };
}
