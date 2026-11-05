// Upgrades an installation this engine made, from any release since the first one
// (26.11.103), to another release in place. install.sh runs it from the target release's
// checkout, so this code reads every older layout itself and never asks the installed
// engine for anything.
//
// The order mirrors the interface upgrade (packages/server/.../release-upgrades.ts): build
// the new release beside the running one, snapshot, then move the Host daemon, the
// coordinator and Dev, each with its own rollback. Identity, owner password, homes,
// agents, ports, routes and data stay where they are; the previous release stays in
// host/releases, so a rollback only repoints a link. The journal at state/upgrade.json
// lets a rerun resume at the step that failed.
import { linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServiceManager, installResult, runSteps } from "./apply.mjs";
import { hostClientFile } from "./coordinator-config.mjs";
import { JOURNAL, readEnvFile } from "./detect.mjs";
import { releaseRevision } from "./host-adoption.mjs";
import { buildRelease, loadServerModules, waitForInstallation } from "./host-installation.mjs";
import { createJournalHandle, readJournal } from "./journal.mjs";
import { PLAN_VERSION } from "./plan.mjs";
import { InstallerError, build, writeJson } from "./primitives.mjs";
import { STEPS, pointLink } from "./steps.mjs";
import { writeSystemSource } from "../lib/system-source.mjs";
import { compareVersions as compareCalendarVersions, parseTag } from "../vorteo-version.mjs";

export const UPGRADE_JOURNAL = path.join("state", "upgrade.json");
const COMMIT = /^[0-9a-f]{40}$/;
const SERVER_DIST = "packages/server/dist/server/server";
// Present in releases whose coordinator offers release updates and update policies.
const RELEASE_UPDATES = "packages/server/src/server/execution-installation/release-updates.ts";
const COORDINATOR_READY_MS = 120_000;

export const UPGRADE_STEP_TITLES = {
  "upgrade-check": "Checking the installation",
  "upgrade-release": "Building the new release beside the running one",
  "upgrade-snapshot": "Taking a snapshot",
  "upgrade-settings": "Saving the installation settings",
  "upgrade-host": "Restarting the Host daemon on the new release",
  "upgrade-coordinator": "Restarting the coordinator on the new release",
  "upgrade-dev": "Recreating Dev on the new release",
  "upgrade-guest-client": "Refreshing the installation client in Dev",
  "upgrade-verify": "Checking readiness and in-app updates",
  "upgrade-finish": "Finishing",
};

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Orders two Vorteo versions such as 26.11.103; null when either is not one. */
export function compareVersions(a, b) {
  try {
    return compareCalendarVersions(a, b);
  } catch {
    return null;
  }
}

/** The release a service link selects: its folder, commit and package version. */
export function linkedRelease(link) {
  let release;
  try {
    release = realpathSync(link);
  } catch {
    return null;
  }
  return {
    release,
    revision: releaseRevision(release),
    version: readJson(path.join(release, "package.json"))?.version ?? null,
  };
}

/** The installer journal of a finished or unfinished installation at `root`. */
function loadInstall(root) {
  const file = path.join(root, JOURNAL);
  const data = readJournal(file);
  if (!data?.plan?.paths)
    throw new InstallerError(
      `No installation journal in ${root}.`,
      "Pass the installation folder with --root.",
    );
  return { file, data };
}

/** The release tag of an installed commit, when anything recorded it. */
function installedTag(install, revision) {
  if (!revision) return null;
  const history = install.data.outputs?.upgrades ?? [];
  const upgraded = history.findLast((item) => item.revision === revision)?.release;
  if (upgraded) return upgraded;
  // Upgrades from the interface record their release in the coordinator's journal.
  const journal = readJson(
    path.join(install.data.plan.paths.coordinatorState, "upgrades", "journal.json"),
  );
  const fromInterface = (journal?.upgrades ?? []).findLast(
    (item) => item.status === "succeeded" && item.sourceCommit === revision,
  )?.release;
  if (fromInterface) return fromInterface;
  const { plan } = install.data;
  // install.sh records the tag it installed; a test checkout records a commit instead.
  if (plan.revision === revision && plan.releaseVersion && !COMMIT.test(plan.releaseVersion))
    return plan.releaseVersion;
  return null;
}

/** Why the installer cannot upgrade this installation, or null. */
function unsupportedReason(install) {
  const { plan } = install.data;
  const config = readJson(plan.paths.coordinatorConfig);
  if (!install.data.completedAt)
    return {
      reason: "This installation never finished installing.",
      fix: "Rerun the installer to finish it, then upgrade.",
    };
  if (!config?.deployment)
    return {
      reason: "The coordinator configuration has no installer deployment record.",
      fix: "Run the installer with --repair, then rerun it.",
    };
  // A Host installation upgraded in place that kept Host source updates moves its Host
  // through those updates; repointing its link here would desynchronize them.
  if (config.sourceUpdates)
    return {
      reason: "This installation installs Host releases through Host source updates.",
      fix: "Upgrade it from Settings, Installation, in the Vorteo interface.",
    };
  return null;
}

/** The current name and update policy, with the settings the target release can change. */
function currentSettings(plan, targetHasPolicy) {
  const name =
    readJson(path.join(plan.paths.coordinatorState, "installation-name.json"))?.name ?? "Vorteo";
  const settings = { name };
  if (targetHasPolicy) {
    const policy = readJson(path.join(plan.paths.coordinatorState, "update-policy.json"))?.policy;
    settings.updateMode = policy?.mode === "automatic" ? "automatic" : "manual";
    settings.updateChannel = policy?.channel === "beta" ? "beta" : "stable";
  }
  return settings;
}

/** What is installed at `root`, for detect, or undefined without a journal. Reads files only. */
export function describeInstalled(root) {
  let install;
  try {
    install = loadInstall(root);
  } catch {
    return undefined;
  }
  const { plan } = install.data;
  const host = linkedRelease(plan.paths.hostReleaseLink);
  const coordinator = linkedRelease(plan.paths.coordinatorReleaseLink);
  const upgrade = readJournal(path.join(root, UPGRADE_JOURNAL));
  return {
    version: host?.version ?? null,
    revision: host?.revision ?? null,
    release: installedTag(install, host?.revision),
    coordinator: coordinator
      ? { version: coordinator.version, revision: coordinator.revision }
      : null,
    ...(upgrade && !upgrade.completedAt
      ? { unfinishedUpgrade: { to: upgrade.plan.to, startedAt: upgrade.startedAt } }
      : {}),
  };
}

async function git(context, args, cwd) {
  return (await context.run(context.which("git") ?? "git", args, { cwd })).trim();
}

/** The version and update capability of `revision` in the source checkout. */
async function targetRelease(context, source, revision, release) {
  if (!COMMIT.test(revision ?? ""))
    throw new InstallerError("A 40-character revision is required.", "Pass --revision <commit>.");
  try {
    await git(context, ["cat-file", "-e", `${revision}^{commit}`], source);
  } catch {
    throw new InstallerError(
      `${source} does not hold commit ${revision}.`,
      "Rerun the installer; it fetches the release first.",
    );
  }
  let version = null;
  try {
    version = JSON.parse(await git(context, ["show", `${revision}:package.json`], source)).version;
  } catch {
    /* an unreadable manifest leaves the version unknown */
  }
  let updatePolicy = true;
  try {
    await git(context, ["cat-file", "-e", `${revision}:${RELEASE_UPDATES}`], source);
  } catch {
    updatePolicy = false;
  }
  // Only a release tag names a release; a test checkout passes its commit instead.
  return { revision, version, release: parseTag(release ?? "") ? release : null, updatePolicy };
}

/**
 * newer: the target is a later release. older: it is earlier. same: Host and coordinator
 * already run it. different: same version number, another build. unfinished: an earlier
 * upgrade to this target stopped part way.
 */
export function compareInstalled(installed, target) {
  if (installed.unfinishedUpgrade?.to?.revision === target.revision) return "unfinished";
  if (installed.revision === target.revision && installed.coordinator?.revision === target.revision)
    return "same";
  const order = compareVersions(target.version, installed.version);
  if (order === 1) return "newer";
  if (order === -1) return "older";
  return "different";
}

const SETTING_KEYS = ["name", "updateMode", "updateChannel"];

/** The requested settings that differ from the current ones and the target can change. */
function changedSettings(current, requested = {}) {
  const changes = {};
  for (const key of SETTING_KEYS) {
    if (!(key in current) || requested[key] === undefined) continue;
    if (requested[key] !== current[key]) changes[key] = requested[key];
  }
  if (changes.name !== undefined && (!changes.name || changes.name.length > 64))
    throw new InstallerError(
      "The installation name must have 1 to 64 characters.",
      "Choose another name.",
    );
  if (changes.updateMode && !["manual", "automatic"].includes(changes.updateMode))
    throw new InstallerError("The update mode is manual or automatic.", "Choose one of them.");
  if (changes.updateChannel && !["stable", "beta"].includes(changes.updateChannel))
    throw new InstallerError("The update channel is stable or beta.", "Choose one of them.");
  return changes;
}

export function upgradeSteps({ devContainer, upgrade, settings, restartCoordinator }) {
  if (!upgrade)
    return [
      ...(settings ? ["upgrade-settings"] : []),
      ...(restartCoordinator ? ["upgrade-coordinator", "upgrade-verify"] : []),
      "upgrade-finish",
    ];
  return [
    "upgrade-check",
    "upgrade-release",
    "upgrade-snapshot",
    ...(settings ? ["upgrade-settings"] : []),
    "upgrade-host",
    "upgrade-coordinator",
    ...(devContainer ? ["upgrade-dev", "upgrade-guest-client"] : []),
    "upgrade-verify",
    "upgrade-finish",
  ];
}

function label(side) {
  if (side?.version) return `${side.version}${side.release ? ` (${side.release})` : ""}`;
  return side?.revision ? side.revision.slice(0, 12) : "an unknown release";
}

export function summarizeUpgrade(plan) {
  const lines = [];
  if (plan.upgrade) {
    lines.push(
      `Upgrade ${plan.paths.root} from ${label(plan.from)} to ${label(plan.to)}, in place`,
    );
    lines.push(
      `Build ${label(plan.to)} in ${plan.release}; the running release stays until the switch`,
    );
    lines.push("Take a snapshot first, restorable from Settings in the interface");
    lines.push(
      plan.devContainer
        ? "Restart the Host daemon and coordinator, then recreate Dev on the new image; running agent turns stop and agents resume later"
        : "Restart the Host daemon and coordinator; running agent turns stop and agents resume later",
    );
    lines.push(
      "Keep the identity, owner password, homes, agents, Projects folder, ports, routes and data",
    );
  }
  const { settings } = plan;
  if (settings.name !== undefined) lines.push(`Rename the installation to "${settings.name}"`);
  if (settings.updateMode || settings.updateChannel)
    lines.push(
      `In-app updates: ${[settings.updateMode, settings.updateChannel].filter(Boolean).join(", ")}`,
    );
  if (plan.upgrade)
    lines.push(
      "If a step fails, that part returns to the previous release and a rerun resumes the upgrade",
    );
  return lines;
}

/**
 * @returns {Promise<object>} what is installed, the target, how they compare, the current
 *   settings, and a plan when one is asked for and possible
 */
export async function createUpgradePlan(
  context,
  { source, revision, release, settings: requested, settingsOnly = false },
) {
  const install = loadInstall(context.root);
  const { plan: installPlan } = install.data;
  const installed = describeInstalled(context.root);
  const sourceDirectory = path.resolve(source ?? installPlan.paths.source);
  const target = await targetRelease(context, sourceDirectory, revision, release);
  const comparison = compareInstalled(installed, target);
  const current = currentSettings(installPlan, target.updatePolicy);
  const unsupported = unsupportedReason(install);
  const report = { installed, target, comparison, settings: current };
  if (unsupported) return { ...report, unsupported };
  const upgrade = !settingsOnly && ["newer", "different", "unfinished"].includes(comparison);
  const settings = changedSettings(current, requested);
  const policyChanged = Boolean(settings.updateMode || settings.updateChannel);
  const hasSettings = Object.keys(settings).length > 0;
  if (!upgrade && !hasSettings) return report;
  // Settings alone apply to what runs now, so a policy change needs a running release
  // that reads it.
  if (!upgrade && policyChanged && comparison !== "same")
    throw new InstallerError(
      "Update settings need the coordinator to run a release that has them.",
      "Upgrade the installation first.",
    );
  const plan = {
    version: PLAN_VERSION,
    kind: "upgrade",
    installationId: installPlan.installationId,
    createdAt: context.now().toISOString(),
    platform: context.platform,
    upgrade,
    from: { version: installed.version, revision: installed.revision, release: installed.release },
    to: { version: target.version, revision: target.revision, release: target.release },
    devContainer: Boolean(installPlan.devContainer),
    updatePolicy: target.updatePolicy,
    // Settings alone keep the release the coordinator runs now.
    release: upgrade
      ? path.join(installPlan.paths.host, "releases", target.revision)
      : linkedRelease(installPlan.paths.coordinatorReleaseLink).release,
    paths: {
      root: context.root,
      journal: path.join(context.root, UPGRADE_JOURNAL),
      source: sourceDirectory,
      work: path.join(context.root, "state", "upgrade-work"),
    },
    settings,
    steps: upgradeSteps({
      devContainer: Boolean(installPlan.devContainer),
      upgrade,
      settings: hasSettings,
      restartCoordinator: policyChanged,
    }),
  };
  return { ...report, plan, summary: summarizeUpgrade(plan) };
}

// Steps -------------------------------------------------------------------------------

async function modules(s) {
  if (!s.context.upgradeModules) {
    const server = await loadServerModules(s.plan.release);
    const snapshots = await import(
      pathToFileURL(path.join(s.plan.release, SERVER_DIST, "execution-installation/snapshots.js"))
    );
    s.context.upgradeModules = { ...server, snapshots };
  }
  return s.context.upgradeModules;
}

const config = (s) => JSON.parse(readFileSync(s.install.plan.paths.coordinatorConfig, "utf8"));
const interfaceJournal = (s) =>
  path.join(s.install.plan.paths.coordinatorState, "upgrades", "journal.json");
const UPGRADES_DIST = path.join(SERVER_DIST, "execution-installation", "release-upgrades.js");

/**
 * True when an interface upgrade that looks active can never finish: the coordinator runs
 * a release from before 26.11.300, whose upgrade journal refused the installer's Host build
 * ID so the upgrade stayed running, and no Host build it launched is still running.
 */
async function stuckInterfaceUpgrade(s) {
  const coordinator = linkedRelease(s.install.plan.paths.coordinatorReleaseLink);
  let code = "";
  try {
    code = readFileSync(path.join(coordinator.release, UPGRADES_DIST), "utf8");
  } catch {
    return false;
  }
  if (code.includes("installer-[0-9a-f]")) return false;
  try {
    await s.context.run("pgrep", ["-f", `host-release --root ${s.install.plan.paths.root}`]);
    return false;
  } catch {
    return true;
  }
}

const activeInterfaceUpgrades = (s) =>
  (readJson(interfaceJournal(s))?.upgrades ?? []).filter(
    (item) =>
      ["approved", "running"].includes(item.status) && !s.outputs.supersede?.includes(item.id),
  );

/**
 * An interface upgrade approved while this one built would change the same links. Old
 * coordinators cannot be told to hold off, so each restart checks again first.
 */
function assertNoInterfaceUpgrade(s) {
  const [active] = activeInterfaceUpgrades(s);
  if (active)
    throw new InstallerError(
      `An upgrade to ${active.release} was started from the interface and is ${active.status}.`,
      "Wait for it to finish or cancel it in Settings, then rerun the installer to resume.",
    );
}

async function check(s) {
  const { install, context } = s;
  // Two upgrades at once would fight over the links; the interface's goes first, unless
  // it is stuck, when this upgrade replaces it.
  const active = activeInterfaceUpgrades(s);
  if (active.length && !(await stuckInterfaceUpgrade(s)))
    throw new InstallerError(
      `An upgrade to ${active[0].release} started from the interface is ${active[0].status}.`,
      "Wait for it to finish or cancel it in Settings, then rerun the installer.",
    );
  if (active.length) s.journal.output({ supersede: active.map((item) => item.id) });
  if (s.plan.devContainer) {
    try {
      await context.run(install.plan.executables.docker, [
        "info",
        "--format",
        "{{.ServerVersion}}",
      ]);
    } catch {
      throw new InstallerError(
        "Docker is not running, and Dev needs it for the upgrade.",
        "Start Docker, then rerun the installer.",
      );
    }
  }
  for (const link of [
    install.plan.paths.hostReleaseLink,
    install.plan.paths.coordinatorReleaseLink,
  ])
    if (!linkedRelease(link))
      throw new InstallerError(
        `${link} does not point at a release.`,
        "Run the installer with --repair, then rerun it.",
      );
  return {
    message: `Upgrading from ${label(s.plan.from)} to ${label(s.plan.to)}.${active.length ? ` The stuck interface upgrade to ${active[0].release} is replaced.` : ""}`,
  };
}

async function releaseStep(s) {
  const { plan, install, context } = s;
  const marker = path.join(plan.release, ".installer-release.json");
  if (readJson(marker)?.revision === plan.to.revision)
    return { skip: "The new release is already built." };
  // A build that stopped part way leaves a folder without its marker; start it again.
  rmSync(plan.release, { recursive: true, force: true });
  const nodeDirectory = path.dirname(install.plan.executables.node);
  const tools = {
    npm: install.plan.executables.npm,
    git: context.which("git") ?? install.plan.executables.git,
  };
  await buildRelease({
    release: plan.release,
    revision: plan.to.revision,
    sourceDirectory: plan.paths.source,
    logDir: install.plan.paths.logs,
    runCommand: (command, args, options = {}) =>
      context.run(tools[command] ?? command, args, {
        ...options,
        env: { ...process.env, ...options.env, PATH: `${nodeDirectory}:${process.env.PATH ?? ""}` },
      }),
  });
  writeJson(marker, { revision: plan.to.revision, builtAt: context.now().toISOString() });
  return { message: `Built ${label(plan.to)} in ${plan.release}.` };
}

async function snapshot(s) {
  if (s.outputs.snapshotId) return { skip: `Snapshot ${s.outputs.snapshotId} already saved.` };
  const { snapshots } = await modules(s);
  const current = config(s);
  const root = snapshots.snapshotRoot(current);
  if (!root) return { skip: "This installation has no snapshot folder." };
  const store = snapshots.createInstallationSnapshots({
    root,
    sources: () => {
      const sources = snapshots.snapshotSources(current, s.install.plan.paths.coordinatorConfig);
      // Releases before this one copy Dev's home as a folder, which Linux keeps private.
      return snapshots.devHomeThroughContainer
        ? snapshots.devHomeThroughContainer(sources, {
            platform: s.install.plan.platform,
            docker: s.install.plan.executables.docker ?? null,
            container: s.install.outputs.instance ? `${s.install.outputs.instance}-paseo-1` : null,
          })
        : sources;
    },
    ports: { now: () => s.context.now(), ...snapshots.dockerSnapshotPorts },
  });
  const taken = await store.take({
    reason: "upgrade",
    ...(s.plan.to.release ? { release: s.plan.to.release } : {}),
  });
  store.prune([taken.id]);
  s.journal.output({ snapshotId: taken.id });
  return { message: `Snapshot ${taken.id} saved; restore it from Settings if you need to.` };
}

async function settingsStep(s) {
  const { plan, install } = s;
  const state = install.plan.paths.coordinatorState;
  const done = [];
  if (plan.settings.name !== undefined) {
    writeJson(path.join(state, "installation-name.json"), { name: plan.settings.name });
    done.push(`named "${plan.settings.name}"`);
  }
  if (plan.settings.updateMode || plan.settings.updateChannel) {
    // The format of release-updates.ts createUpdatePolicyStore; the coordinator reads it
    // when it starts, which the next step does.
    const file = path.join(state, "update-policy.json");
    const policy = readJson(file)?.policy ?? {};
    const next = {
      mode: plan.settings.updateMode ?? (policy.mode === "automatic" ? "automatic" : "manual"),
      channel: plan.settings.updateChannel ?? (policy.channel === "beta" ? "beta" : "stable"),
    };
    writeJson(file, { version: 1, policy: next });
    done.push(`in-app updates ${next.mode} on the ${next.channel} channel`);
  }
  return { message: `Saved the settings: ${done.join(", ")}.` };
}

/**
 * Points `link` at the new release and restarts `service`, remembering the previous
 * release once. When `ready` fails, the link and service go back and the step fails.
 * `between` runs while the service is stopped, instead of a plain restart.
 */
async function switchService(s, { link, service, output, ready, name, between }) {
  const { plan, journal, manager } = s;
  // Compared resolved: a home or temporary folder can itself sit behind a symlink.
  const target = realpathSync(plan.release);
  const current = realpathSync(link);
  if (!s.outputs[output] && current !== target) journal.output({ [output]: current });
  const previous = s.outputs[output];
  try {
    pointLink(link, plan.release);
    if (between) {
      await manager.stop(service);
      // launchd unloads after bootout returns; bootstrapping the label sooner fails.
      for (
        let wait = 0;
        manager.kind === "launchd" && wait < 40 && (await manager.isRegistered(service));
        wait += 1
      )
        await s.context.sleep(250);
      between();
      await manager.start(service);
    } else await manager.restart(service);
    await ready();
  } catch (error) {
    let restored = "";
    if (previous && previous !== target) {
      try {
        pointLink(link, previous);
        // A stop that succeeded before the failure left launchd without the job.
        if (await manager.isRegistered(service)) await manager.restart(service);
        else await manager.start(service);
        await ready();
        restored = ` It runs ${previous} again.`;
      } catch (rollbackError) {
        restored = ` Returning it to ${previous} failed too (${rollbackError.message}); run the installer with --repair.`;
      }
    }
    throw new InstallerError(
      `The ${name} did not become ready on ${label(plan.to)}: ${error.message}.${restored}`,
      `Its logs are in ${s.install.plan.paths.logs}. Fix the problem, then rerun the installer to resume the upgrade.`,
      { cause: error },
    );
  }
}

async function waitFor(s, probe, timeoutMs) {
  const deadline = Date.now() + (s.context.readyTimeoutMs ?? timeoutMs);
  let last;
  for (;;) {
    try {
      return await probe();
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw last;
    await s.context.sleep(s.context.readyTimeoutMs ? 10 : 1000);
  }
}

async function hostStep(s) {
  assertNoInterfaceUpgrade(s);
  const { connectInstallationDaemon } = await modules(s);
  const current = config(s);
  await switchService(s, {
    link: s.install.plan.paths.hostReleaseLink,
    service: s.install.plan.services.host,
    output: "previousHost",
    name: "Host daemon",
    ready: () =>
      waitFor(
        s,
        async () => {
          const client = await connectInstallationDaemon(current, "host");
          try {
            await client.getDaemonStatus({ timeout: 5000 });
          } finally {
            await client.close();
          }
        },
        COORDINATOR_READY_MS,
      ),
  });
  return { message: `The Host daemon runs ${label(s.plan.to)}.` };
}

async function coordinatorHealth(s, port) {
  const response = await s.context.fetch(`http://127.0.0.1:${port}/api/installation/health`, {
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (!response.ok || body.installationId !== s.install.plan.installationId)
    throw new Error("the coordinator answered for another installation");
  return body;
}

function supersede(s) {
  const file = interfaceJournal(s);
  const journal = readJson(file);
  if (!journal) return;
  const detail = `Replaced by the installer's upgrade to ${label(s.plan.to)}.`;
  for (const item of journal.upgrades)
    if (s.outputs.supersede.includes(item.id) && ["approved", "running"].includes(item.status)) {
      item.status = "failed";
      item.detail = detail;
      for (const step of item.steps ?? [])
        if (["pending", "running"].includes(step.status))
          Object.assign(step, { status: "failed", detail });
    }
  writeJson(file, journal);
}

async function coordinatorStep(s) {
  assertNoInterfaceUpgrade(s);
  const port = s.install.plan.ports.coordinator;
  let before = null;
  try {
    before = (await coordinatorHealth(s, port)).pid ?? null;
  } catch {
    /* not running; any answer after the restart is the new one */
  }
  await switchService(s, {
    link: s.install.plan.paths.coordinatorReleaseLink,
    service: s.install.plan.services.coordinator,
    output: "previousCoordinator",
    name: "coordinator",
    // A stuck interface upgrade would resume in the new coordinator and move the Host back
    // to its older target. End it while no coordinator runs to rewrite the journal.
    between: s.outputs.supersede?.length ? () => supersede(s) : undefined,
    ready: () =>
      waitFor(
        s,
        async () => {
          const health = await coordinatorHealth(s, port);
          if (before !== null && health.pid === before)
            throw new Error("the previous coordinator is still answering");
        },
        COORDINATOR_READY_MS,
      ),
  });
  return { message: `The coordinator runs ${label(s.plan.to)}.` };
}

function devEnvironment(s) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  const docker = s.install.plan.executables.docker;
  env.PATH = `${path.dirname(docker)}:${env.PATH ?? "/usr/bin:/bin"}`;
  return env;
}

const devImage = (s) =>
  readEnvFile(path.join(s.install.plan.paths.container, ".env")).PASEO_IMAGE ?? null;

/**
 * The image ID Dev's container runs, or null. update.sh writes .env before it recreates
 * the container, so after an interruption only the container tells what runs.
 */
async function runningImage(s) {
  try {
    return await s.context.run(s.install.plan.executables.docker, [
      "inspect",
      "--format",
      "{{.Image}}",
      `${s.install.outputs.instance}-paseo-1`,
    ]);
  } catch {
    return null;
  }
}

async function imageId(s, reference) {
  try {
    return await s.context.run(s.install.plan.executables.docker, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      reference,
    ]);
  } catch {
    return reference;
  }
}

/**
 * Builds Dev's image from the release and recreates Dev with the deployment's update.sh,
 * which waits for health and restores the previous image itself when the new one fails;
 * the same commands as the interface upgrade (release-upgrade-runtime.ts).
 */
async function devStep(s) {
  const { plan, install, context, journal } = s;
  const docker = install.plan.executables.docker;
  const deployment = install.plan.paths.container;
  if (!s.outputs.devPreviousImage) journal.output({ devPreviousImage: devImage(s) });
  const previous = s.outputs.devPreviousImage;
  let image = s.outputs.devImage;
  if (image) {
    try {
      await context.run(docker, ["image", "inspect", image]);
    } catch {
      image = undefined;
    }
  }
  if (!image) {
    const work = path.join(plan.paths.work, plan.to.revision);
    const sourceContext = path.join(work, "dev-source");
    rmSync(sourceContext, { recursive: true, force: true });
    mkdirSync(sourceContext, { recursive: true, mode: 0o700 });
    const archive = path.join(work, "dev-source.tar");
    await context.run(context.which("git") ?? install.plan.executables.git, [
      "-C",
      plan.paths.source,
      "archive",
      "--format=tar",
      `--output=${archive}`,
      plan.to.revision,
    ]);
    await context.run("tar", ["-xf", archive, "-C", sourceContext], { timeout: 300_000 });
    const iid = path.join(work, "dev-image.iid");
    rmSync(iid, { force: true });
    await build(
      docker,
      [
        "build",
        "--build-arg",
        `PASEO_BUILD_COMMIT=${plan.to.revision}`,
        "--iidfile",
        iid,
        "-f",
        path.join(sourceContext, "docker/base/Dockerfile"),
        sourceContext,
      ],
      sourceContext,
      path.join(install.plan.paths.logs, "dev-image-upgrade.log"),
      {},
      context.run,
    );
    image = readFileSync(iid, "utf8").trim();
    journal.output({ devImage: image });
    rmSync(work, { recursive: true, force: true });
  }
  const { connectInstallationDaemon } = await modules(s);
  const current = config(s);
  // After the build, which takes minutes, and outside the rollback below, so a refusal
  // never touches another upgrade's Dev.
  assertNoInterfaceUpgrade(s);
  try {
    if ((await runningImage(s)) !== (await imageId(s, image)))
      await context.run("/bin/bash", [path.join(deployment, "update.sh"), image], {
        env: devEnvironment(s),
        timeout: 15 * 60_000,
      });
    await waitFor(
      s,
      async () => {
        const client = await connectInstallationDaemon(current, "container");
        try {
          await client.getDaemonStatus({ timeout: 15_000 });
        } finally {
          await client.close();
        }
      },
      COORDINATOR_READY_MS,
    );
  } catch (error) {
    let restored = "Dev runs the previous image again.";
    try {
      if (previous && (await runningImage(s)) !== (await imageId(s, previous)))
        await context.run("/bin/bash", [path.join(deployment, "update.sh"), previous], {
          env: devEnvironment(s),
          timeout: 15 * 60_000,
        });
    } catch (rollbackError) {
      restored = `The previous image ${previous} did not come back either: ${rollbackError.message}`;
    }
    throw new InstallerError(
      `Dev failed on the new image: ${error.message}. ${restored}`,
      `Dev's deployment and logs are in ${deployment}. Fix the problem, then rerun the installer to resume the upgrade.`,
      { cause: error },
    );
  }
  // Later repairs that recreate Dev use the new image.
  s.installJournal.output({ devImage: image });
  return { message: `Dev runs ${label(plan.to)}.` };
}

async function guestClientStep(s) {
  // The install step copies the client and skill from the Host release link, which now
  // names the new release, then checks Dev's route to the coordinator.
  return STEPS["guest-client"]({ ...s, plan: s.install.plan, outputs: s.install.outputs });
}

/**
 * Readiness of the Host and coordinator, and, on a release that has them, the update
 * status that the interface's update offers come from.
 */
async function verify(s) {
  const { connectInstallationDaemon } = await modules(s);
  const current = config(s);
  await waitForInstallation(current, connectInstallationDaemon, {
    fetchImpl: s.context.fetch,
    ...(s.context.readyTimeoutMs ? { timeoutMs: s.context.readyTimeoutMs, intervalMs: 10 } : {}),
  });
  if (!s.plan.updatePolicy)
    return {
      message: `The installation is ready. ${label(s.plan.to)} predates in-app update offers; upgrade again to a later release for them.`,
    };
  const client = readJson(hostClientFile(s.install.plan));
  const response = await s.context.fetch(
    `http://127.0.0.1:${s.install.plan.ports.coordinator}/api/installation/update-status`,
    {
      headers: { Authorization: `Bearer ${client?.token ?? ""}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.policy) {
    // Test machines run services as plain processes, which the coordinator cannot restart,
    // so it rightly offers no upgrades there.
    if (s.install.plan.services.manager === "process")
      return {
        message: "The installation is ready. Process-managed services offer no in-app updates.",
      };
    throw new InstallerError(
      `The coordinator runs ${label(s.plan.to)} but does not offer in-app updates: ${body.error ?? `HTTP ${response.status}`}.`,
      "Rerun the installer to check again. If it fails again, report the message above.",
    );
  }
  s.journal.output({ updatePolicy: body.policy });
  return {
    message: `The installation is ready and offers in-app updates (${body.policy.mode}, ${body.policy.channel} channel).`,
  };
}

async function finish(s) {
  const { plan, install, context } = s;
  if (plan.upgrade) {
    // New System project workspaces branch from the installed release.
    writeSystemSource({
      paseoHome: install.plan.paths.hostHome,
      checkout: install.plan.paths.source,
      ref: plan.to.revision,
    });
    const history = install.outputs.upgrades ?? [];
    s.installJournal.output({
      upgrades: [
        ...history,
        {
          from: plan.from,
          revision: plan.to.revision,
          version: plan.to.version,
          release: plan.to.release,
          ...(s.outputs.snapshotId ? { snapshotId: s.outputs.snapshotId } : {}),
          completedAt: context.now().toISOString(),
        },
      ].slice(-20),
    });
  }
  s.journal.complete();
  return {
    message: plan.upgrade
      ? `Upgraded to ${label(plan.to)}. The previous release stays in ${s.outputs.previousHost ?? path.dirname(plan.release)}.`
      : "Saved the settings.",
  };
}

export const UPGRADE_STEPS = {
  "upgrade-check": check,
  "upgrade-release": releaseStep,
  "upgrade-snapshot": snapshot,
  "upgrade-settings": settingsStep,
  "upgrade-host": hostStep,
  "upgrade-coordinator": coordinatorStep,
  "upgrade-dev": devStep,
  "upgrade-guest-client": guestClientStep,
  "upgrade-verify": verify,
  "upgrade-finish": finish,
};

/**
 * Opens state/upgrade.json for `plan`. An unfinished upgrade to the same release resumes;
 * any other starts afresh, keeping the releases an unfinished one recorded as previous
 * so a rollback still returns to what ran before either.
 */
function openUpgradeJournal(plan, context) {
  const existing = readJournal(plan.paths.journal);
  if (existing && existing.installationId !== plan.installationId)
    throw new InstallerError(
      `${plan.paths.journal} belongs to installation ${existing.installationId}.`,
      "Pass this installation's folder with --root.",
    );
  if (existing && !existing.completedAt && existing.plan.to.revision === plan.to.revision)
    return createJournalHandle(plan.paths.journal, existing, context.now);
  const carried = existing && !existing.completedAt ? existing.outputs : {};
  const keep = ["previousHost", "previousCoordinator", "devPreviousImage"];
  const data = {
    version: 1,
    installationId: plan.installationId,
    startedAt: context.now().toISOString(),
    plan,
    steps: {},
    outputs: Object.fromEntries(
      keep.filter((key) => carried[key]).map((key) => [key, carried[key]]),
    ),
  };
  const handle = createJournalHandle(plan.paths.journal, data, context.now);
  handle.save();
  return handle;
}

export function validateUpgradePlan(plan, context) {
  if (
    !plan ||
    plan.kind !== "upgrade" ||
    plan.version !== PLAN_VERSION ||
    !Array.isArray(plan.steps)
  )
    throw new InstallerError(
      "This is not an upgrade plan.",
      "Create one with `main.mjs plan --upgrade`.",
    );
  if (plan.platform !== context.platform || path.resolve(plan.paths.root) !== context.root)
    throw new InstallerError(
      `The plan upgrades ${plan.paths.root} on ${plan.platform}, not ${context.root} on ${context.platform}.`,
      "Plan again on this machine with this --root.",
    );
  const unknown = plan.steps.filter((step) => !UPGRADE_STEPS[step]);
  if (unknown.length)
    throw new InstallerError(`Unknown upgrade steps: ${unknown.join(", ")}.`, "Plan again.");
  return plan;
}

/** Applies an upgrade plan, resuming an unfinished one. Returns false on failure. */
export async function applyUpgrade(plan, context, emit) {
  validateUpgradePlan(plan, context);
  const install = loadInstall(context.root);
  if (install.data.installationId !== plan.installationId)
    throw new InstallerError(
      `${context.root} holds installation ${install.data.installationId}, not ${plan.installationId}.`,
      "Plan again for this installation.",
    );
  const installJournal = createJournalHandle(install.file, install.data, context.now);
  const release = lockUpgrade(context.root);
  try {
    return await runUpgrade(plan, context, emit, install, installJournal);
  } finally {
    release();
  }
}

/**
 * One installer upgrade at a time per installation. The lock appears complete in one step,
 * a hard link of a written file, and is never taken from another run: one left by a run
 * that was killed outright is reported with the file to remove. It is released on any exit
 * of this process, including Ctrl-C, which main.mjs turns into process.exit.
 */
function lockUpgrade(root) {
  const file = path.join(root, "state", "upgrade.lock");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid }) + "\n", { mode: 0o600 });
  try {
    linkSync(temporary, file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const holder = readJson(file)?.pid;
    let alive = true;
    try {
      process.kill(holder, 0);
    } catch {
      alive = false;
    }
    throw new InstallerError(
      alive
        ? `Another installer (process ${holder}) is upgrading ${root}.`
        : `An earlier installer run${holder ? ` (process ${holder})` : ""} stopped without releasing ${file}.`,
      alive
        ? "Wait for it to finish, then rerun the installer."
        : `Check that no installer is running, remove ${file}, then rerun the installer to resume.`,
    );
  } finally {
    rmSync(temporary, { force: true });
  }
  const release = () => {
    if (readJson(file)?.pid === process.pid) rmSync(file, { force: true });
  };
  process.once("exit", release);
  return () => {
    process.removeListener("exit", release);
    release();
  };
}

async function runUpgrade(plan, context, emit, install, installJournal) {
  const journal = openUpgradeJournal(plan, context);
  const state = {
    plan: journal.data.plan,
    install: { plan: install.data.plan, outputs: install.data.outputs },
    installJournal,
    context,
    journal,
    outputs: journal.data.outputs,
    manager: createServiceManager(install.data.plan.services.manager, context),
  };
  if (!(await runSteps(state.plan.steps, state, emit))) return false;
  emit({
    result: {
      ...installResult(install.data.plan, install.data.outputs),
      ...(plan.settings.name !== undefined ? { name: plan.settings.name } : {}),
      ...(plan.upgrade ? { upgraded: { from: plan.from, to: plan.to } } : {}),
    },
  });
  return true;
}
