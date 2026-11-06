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
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServiceManager, installResult, runSteps } from "./apply.mjs";
import { hostClientFile } from "./coordinator-config.mjs";
import { JOURNAL, readEnvFile } from "./detect.mjs";
import { releaseRevision } from "./host-adoption.mjs";
import { buildRelease, loadServerModules, waitForInstallation } from "./host-installation.mjs";
import {
  buildDevImage,
  buildDevRelease,
  currentDevRelease,
  devUpgradeMode,
  pruneDevReleases,
  refreshDeploymentScripts,
} from "./dev-release.mjs";
import { createJournalHandle, readJournal } from "./journal.mjs";
import { PLAN_VERSION } from "./plan.mjs";
import { InstallerError, writeJson } from "./primitives.mjs";
import { STEPS, pointLink } from "./steps.mjs";
import { writeSystemSource } from "../lib/system-source.mjs";
import { compareVersions as compareCalendarVersions, parseTag } from "../vorteo-version.mjs";

export const UPGRADE_JOURNAL = path.join("state", "upgrade.json");
export const FOLLOW_JOURNAL = path.join("state", "coordinator-follow.json");
// True because the follow restarts only the coordinator's own service: the Host daemon,
// session host and Dev run as separate services that keep running.
export const FOLLOW_RESTART_NOTICE =
  "Restarting the coordinator now. Running Host and Dev agents keep working; Installation controls and agent maintenance requests pause until it answers.";
export const FOLLOW_KEEP_OPEN =
  "Keep this terminal open; if it is interrupted, run the same command again.";
// A coordinator that answers once and then crashes must not count as ready.
const COORDINATOR_STABLE_MS = 15_000;

// custom-domain.ts CHANGE_DEADLINE_MS: two readiness windows and a minute.
const CUSTOM_DOMAIN_DEADLINE_MS = 300_000;

let switching = 0;
let hungUp = false;

/**
 * True when a closed terminal must wait: a service switch is under way, and leaving now would
 * strand its link without the readiness check or rollback. The process exits once it ends.
 */
export function deferHangup() {
  if (!switching) return false;
  hungUp = true;
  return true;
}
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
  "upgrade-dev-build": "Building Dev's release from the new Host release",
  "upgrade-dev": "Moving Dev to the new release",
  "upgrade-guest-client": "Refreshing the installation client in Dev",
  "upgrade-verify": "Checking readiness and in-app updates",
  "upgrade-finish": "Finishing",
  "follow-check": "Checking the coordinator and Host releases",
  "follow-finish": "Finishing",
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
    // Dev builds from the Host release before anything restarts.
    ...(devContainer ? ["upgrade-dev-build"] : []),
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
  // Last checks run before the link moves: a refusal after it would restart the service.
  await s.beforeSwitch?.(name);
  switching += 1;
  try {
    pointLink(link, plan.release);
    s.beforeRestart?.(name);
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
  } finally {
    // The terminal closed during the switch, which has now finished either way. The run
    // exits once the step is journaled (exitAfterHangup), so a rerun never repeats it.
    switching -= 1;
  }
}

/**
 * Ends the process after a deferred hangup, called by runSteps once a step is journaled.
 * Exiting earlier would leave a finished switch recorded as unfinished, and the rerun would
 * restart that service again, interrupting the Host's agents a second time after a Host switch.
 */
function exitAfterHangup() {
  if (!switching && hungUp) process.exit(129);
  return false;
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
    ready: async () => {
      // As coordinator-handoff.ts waitForCoordinator: a new process, not fenced by a
      // coordinator update. A fenced one answers without a top-level pid.
      const pid = await waitFor(
        s,
        async () => {
          const health = await coordinatorHealth(s, port);
          if (typeof health.pid !== "number" || health.bootstrap?.fenced)
            throw new Error("the coordinator answers but is not ready");
          if (before !== null && health.pid === before)
            throw new Error("the previous coordinator is still answering");
          return health.pid;
        },
        COORDINATOR_READY_MS,
      );
      // The same process must still answer a little later; launchd restarts one that crashes.
      await s.context.sleep(s.context.readyTimeoutMs ? 10 : COORDINATOR_STABLE_MS);
      // A busy coordinator may miss one probe; only a new pid, a fence or silence fails it.
      let again;
      for (let attempt = 0; attempt < 3 && !again; attempt += 1) {
        try {
          again = await coordinatorHealth(s, port);
        } catch {
          if (attempt < 2) await s.context.sleep(s.context.readyTimeoutMs ? 1 : 2_000);
        }
      }
      if (again?.pid !== pid || again.bootstrap?.fenced)
        throw new Error("the coordinator stopped answering after it started");
    },
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

/** Waits until the coordinator reaches Dev's daemon. */
async function waitForDev(s) {
  const { connectInstallationDaemon } = await modules(s);
  const current = config(s);
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
}

/**
 * Moves Dev to the release, refreshing the deployment's lifecycle scripts first. When the
 * image is unchanged and Dev mounts its releases, only Dev's daemon restarts on a
 * Host-built release (dev-release.mjs); otherwise the image is rebuilt.
 */
/** What dev-release.mjs needs for this upgrade. */
function devInput(s) {
  const { plan, install, context } = s;
  return {
    run: (command, args, options = {}) =>
      context.run(command, args, { env: devEnvironment(s), ...options }),
    docker: install.plan.executables.docker,
    git: context.which("git") ?? install.plan.executables.git,
    npm: install.plan.executables.npm,
    node: install.plan.executables.node,
    // The Host release this upgrade built; Dev installs its compiled packages.
    hostRelease: plan.release,
    source: plan.paths.source,
    commit: plan.to.revision,
    deployment: install.plan.paths.container,
  };
}

/**
 * Builds Dev's release, or its image when the image itself changed, from the Host release
 * the previous step built. It runs before the snapshot and every restart, so agents are
 * interrupted only once all builds have passed. The Dev step reuses what it recorded.
 */
async function devBuildStep(s) {
  const { journal } = s;
  const input = devInput(s);
  // An interface upgrade would build into the same release folder.
  assertNoInterfaceUpgrade(s);
  if (!s.outputs.devMode) journal.output({ devMode: (await devUpgradeMode(input)).mode });
  if (s.outputs.devMode === "release") {
    if (!s.outputs.devPreviousRelease)
      journal.output({ devPreviousRelease: currentDevRelease(input.deployment) });
    const { packedFrom } = await buildDevRelease(input);
    return { message: `Built Dev's release from ${packedFrom}.` };
  }
  if (!s.outputs.devPreviousImage) journal.output({ devPreviousImage: devImage(s) });
  if (!s.outputs.devImage) {
    const { image, packedFrom } = await buildDevImage(input);
    journal.output({ devImage: image });
    return { message: `Built Dev's image from ${packedFrom}.` };
  }
  return { skip: "Dev's image is already built." };
}

async function devStep(s) {
  const { journal } = s;
  const input = devInput(s);
  // Before touching the deployment: an interface upgrade may be running its update.sh.
  assertNoInterfaceUpgrade(s);
  await refreshDeploymentScripts(input);
  if (!s.outputs.devMode) journal.output({ devMode: (await devUpgradeMode(input)).mode });
  return s.outputs.devMode === "release" ? devReleaseStep(s, input) : devImageStep(s, input);
}

/**
 * Builds the Dev release and restarts Dev's daemon on it with update.sh --release, which
 * restores the previous selection itself when Dev is not healthy on the new one.
 */
async function devReleaseStep(s, input) {
  const { plan, context, journal } = s;
  const { deployment, commit } = input;
  if (!s.outputs.devPreviousRelease)
    journal.output({ devPreviousRelease: currentDevRelease(deployment) });
  const previous = s.outputs.devPreviousRelease;
  await buildDevRelease(input);
  // After the build and outside the rollback below, so a refusal never touches another
  // upgrade's Dev.
  assertNoInterfaceUpgrade(s);
  const swap = (release) =>
    context.run("/bin/bash", [path.join(deployment, "update.sh"), "--release", release], {
      env: devEnvironment(s),
      timeout: 15 * 60_000,
    });
  try {
    // A resumed step restarts again: the link can be repointed before the restart ran.
    if (!s.outputs.devReleaseSwapped) {
      await swap(commit);
      journal.output({ devReleaseSwapped: true });
    }
    await waitForDev(s);
  } catch (error) {
    // A rerun must swap again, never trust a swap this rollback undid.
    journal.output({ devReleaseSwapped: false });
    let restored = `Dev runs ${previous === "none" ? "its image's daemon" : `release ${previous}`} again.`;
    try {
      if (currentDevRelease(deployment) !== previous) await swap(previous);
    } catch (rollbackError) {
      restored = `The previous release did not come back either: ${rollbackError.message}`;
    }
    throw new InstallerError(
      `Dev failed on the new release: ${error.message}. ${restored}`,
      `Dev's deployment and releases are in ${deployment}. Fix the problem, then rerun the installer to resume the upgrade.`,
      { cause: error },
    );
  }
  pruneDevReleases(deployment);
  return { message: `Dev's daemon runs ${label(plan.to)}; its image was kept.` };
}

/**
 * Builds Dev's image from the release and recreates Dev with the deployment's update.sh,
 * which waits for health and restores the previous image itself when the new one fails;
 * the same commands as the interface upgrade (release-upgrade-runtime.ts).
 */
async function devImageStep(s, input) {
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
    ({ image } = await buildDevImage(input));
    journal.output({ devImage: image });
  }
  // After the build, which takes minutes, and outside the rollback below, so a refusal
  // never touches another upgrade's Dev.
  assertNoInterfaceUpgrade(s);
  try {
    if ((await runningImage(s)) !== (await imageId(s, image)))
      await context.run("/bin/bash", [path.join(deployment, "update.sh"), image], {
        env: devEnvironment(s),
        timeout: 15 * 60_000,
      });
    await waitForDev(s);
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

// Coordinator follow ------------------------------------------------------------------

/**
 * The first job the coordinator would fail or strand when it restarts (restarts.ts activate):
 * approved or running work, including restarts approved to wait for idle agents, and
 * preparation still under way.
 */
function lifecycleJobConflict(state) {
  for (const job of readJson(path.join(state, "restart-jobs.json")) ?? []) {
    const what = `A ${job.target ?? job.kind ?? "maintenance"} job`;
    if (job.status === "approved" && job.whenIdle)
      return `${what} is approved to run once agents are idle.`;
    if (["approved", "running"].includes(job.status)) return `${what} is ${job.status}.`;
    if (job.status === "pending" && job.stage === "preparing") return `${what} is preparing.`;
    if (job.status === "pending" && job.devRepairs?.at(-1)?.status === "preparing")
      return "A Dev repair is preparing.";
  }
  return null;
}

/** Custom domain changes, lab updates and coordinator updates from Installation controls. */
function interfaceWorkConflict(s, state) {
  const domain = path.join(state, "custom-domain");
  const change = readJson(path.join(domain, "last.json"));
  // Without an outcome the change runs until custom-domain.ts treats it as abandoned.
  if (
    change &&
    !existsSync(path.join(domain, change.id, "outcome.json")) &&
    s.context.now().getTime() - Date.parse(change.startedAt) <= CUSTOM_DOMAIN_DEADLINE_MS
  )
    return "A custom domain change is in progress.";
  const active = (items, statuses) => (items ?? []).find((item) => statuses.includes(item.status));
  const lab = active(readJson(path.join(state, "lab-updates", "journal.json"))?.updates, [
    "approved",
    "running",
  ]);
  if (lab) return `A lab update is ${lab.status}.`;
  const follow = active(readJson(path.join(state, "coordinator-follow", "journal.json"))?.jobs, [
    "pending",
    "approved",
    "running",
  ]);
  return follow ? `A coordinator update from Installation controls is ${follow.status}.` : null;
}

/** Open owner-reviewed coordinator requests, read with the release's own journal code. */
async function coordinatorRequestConflict(s, state) {
  const files = ["coordinator-bootstrap.json", "coordinator-bootstrap-pending.json"];
  if (!files.some((file) => existsSync(path.join(state, file)))) return null;
  // The release's own reader: it merges unpromoted claims and closes recovered failures.
  const directory = path.join(s.plan.release, SERVER_DIST, "execution-installation");
  const { openBootstrapRequests, FileBootstrapRequestJournal } = s.context
    .coordinatorRequestModules ?? {
    ...(await import(pathToFileURL(path.join(directory, "coordinator-bootstrap.js")))),
    ...(await import(pathToFileURL(path.join(directory, "coordinator-bootstrap-journal.js")))),
  };
  const open = openBootstrapRequests(new FileBootstrapRequestJournal(state).read());
  return open.length ? `${open.length} coordinator request(s) are still open.` : null;
}

/** Lifecycle work the coordinator drives, which restarting it would interrupt. */
async function coordinatorLifecycleConflict(s) {
  const state = config(s).stateDir;
  return (
    lifecycleJobConflict(state) ??
    interfaceWorkConflict(s, state) ??
    (await coordinatorRequestConflict(s, state))
  );
}

/**
 * Refuses unless the coordinator can move by its link alone: the Host release still is the
 * planned one and holds a coordinator, the service starts through the link, and no work the
 * coordinator drives is in flight.
 */
async function followCheck(s) {
  const { plan, install, manager } = s;
  const { paths, services } = install.plan;
  if (realpathSync(paths.hostReleaseLink) !== plan.release)
    throw new InstallerError(
      "The Host release changed since this coordinator update started.",
      "Rerun the command to move the coordinator to the current Host release.",
    );
  if (!existsSync(path.join(plan.release, SERVER_DIST, "execution-installation", "main.js")))
    throw new InstallerError(
      `${plan.release} has no built coordinator.`,
      "Install a Host release that includes the coordinator, then rerun the command.",
    );
  if (manager.file) {
    const definition = readFileSync(manager.file(services.coordinator), "utf8");
    if (!definition.includes(`${paths.coordinatorReleaseLink}/`))
      throw new InstallerError(
        "The coordinator service starts a fixed release, not its release link, so moving the link would not move it.",
        `Report this. The service file ${manager.file(services.coordinator)} must start main.js through ${paths.coordinatorReleaseLink}.`,
      );
  }
  const conflict = await coordinatorLifecycleConflict(s);
  if (conflict)
    throw new InstallerError(
      conflict,
      "Wait for it to finish in Installation controls, then rerun the command.",
    );
  assertNoInterfaceUpgrade(s);
  return { message: `Moving the coordinator from ${label(plan.from)} to ${label(plan.to)}.` };
}

function followFinish(s) {
  s.journal.complete();
  return {
    message: `The coordinator runs ${label(s.plan.to)}. The previous release stays in ${s.outputs.previousCoordinator}.`,
  };
}

/** The Host and coordinator releases of an installation whose coordinator follows its link. */
function followReleases(install) {
  const { paths } = install.data.plan;
  const deployment = readJson(paths.coordinatorConfig)?.deployment;
  if (
    !install.data.completedAt ||
    deployment?.coordinator?.releaseLink !== paths.coordinatorReleaseLink
  )
    throw new InstallerError(
      "This installation has no recorded coordinator release link.",
      "Run the installer with --repair, then rerun the command.",
    );
  const host = linkedRelease(paths.hostReleaseLink);
  const coordinator = linkedRelease(paths.coordinatorReleaseLink);
  if (!host || !coordinator)
    throw new InstallerError(
      "The Host or coordinator release link does not point at a release.",
      "Run the installer with --repair, then rerun the command.",
    );
  return { host, coordinator };
}

/** The unfinished follow journal, if any, refusing one that belongs to another installation. */
function unfinishedFollow(file, installationId) {
  const existing = readJournal(file);
  if (!existing || existing.completedAt) return undefined;
  if (existing.installationId !== installationId)
    throw new InstallerError(
      `${file} belongs to installation ${existing.installationId}.`,
      "Pass this installation's folder with --root.",
    );
  return existing;
}

/** A fresh journal, keeping what ran before a follow that stopped part way as the rollback. */
function newFollowJournal(context, plan, unfinished) {
  const previous = unfinished?.outputs.previousCoordinator;
  return {
    version: 1,
    installationId: plan.installationId,
    startedAt: context.now().toISOString(),
    plan,
    steps: {},
    outputs: previous ? { previousCoordinator: previous } : {},
  };
}

/**
 * Moves the coordinator onto the release the Host runs, without touching the Host or Dev.
 * Host source updates repoint only the Host link, and the coordinator's own requests cannot
 * replace a coordinator that starts through its link; later moves use the coordinator update
 * in Installation controls. The owner runs this from a terminal, like install.sh. It shares
 * the upgrade's coordinator step and lock, so a coordinator that does not become ready runs
 * the previous release again, and a rerun resumes from state/coordinator-follow.json.
 * `checkOnly` runs the checks alone and changes nothing.
 */
export async function followHostRelease(context, emit, { checkOnly = false } = {}) {
  const install = loadInstall(context.root);
  const { plan: installPlan } = install.data;
  const { host, coordinator } = followReleases(install);
  const file = path.join(context.root, FOLLOW_JOURNAL);
  const unfinished = unfinishedFollow(file, installPlan.installationId);
  const resume = unfinished?.plan.release === host.release;
  if (!resume && host.release === coordinator.release) {
    emit({
      result: { coordinator: { revision: host.revision, version: host.version }, moved: false },
    });
    return true;
  }
  const side = (release) => ({ version: release.version, revision: release.revision });
  const plan = resume
    ? unfinished.plan
    : {
        version: 1,
        kind: "coordinator-follow",
        installationId: installPlan.installationId,
        release: host.release,
        from: side(coordinator),
        to: side(host),
        steps: ["follow-check", "upgrade-coordinator", "follow-finish"],
      };
  const manager = createServiceManager(installPlan.services.manager, context);
  if (checkOnly) {
    await followCheck({ plan, install: { plan: installPlan }, context, outputs: {}, manager });
    emit({ result: { ready: true, from: plan.from, to: plan.to } });
    return true;
  }
  const unlock = lockUpgrade(context.root);
  try {
    const data = resume ? unfinished : newFollowJournal(context, plan, unfinished);
    // The checks hold for one run only.
    delete data.steps["follow-check"];
    const journal = createJournalHandle(file, data, context.now);
    journal.save();
    const state = {
      plan,
      install: { plan: installPlan, outputs: install.data.outputs },
      context,
      journal,
      outputs: data.outputs,
      manager,
      // The checks run again right before the link moves; work may have started meanwhile.
      beforeSwitch: async () => {
        const conflict = await coordinatorLifecycleConflict(state);
        if (conflict)
          throw new InstallerError(
            conflict,
            "Wait for it to finish in Installation controls, then rerun the command.",
          );
      },
      // Announced once, before the first restart; a rollback restarts the same service.
      beforeRestart: (service) => {
        if (service !== "coordinator" || state.announced) return;
        state.announced = true;
        emit({ step: "upgrade-coordinator", status: "progress", message: FOLLOW_RESTART_NOTICE });
      },
    };
    emit({ status: "note", message: FOLLOW_KEEP_OPEN });
    if (!(await runSteps(plan.steps, state, emit, { stopAfter: exitAfterHangup }))) return false;
    emit({ result: { coordinator: plan.to, moved: true } });
    return true;
  } finally {
    unlock();
  }
}

export const UPGRADE_STEPS = {
  "upgrade-check": check,
  "upgrade-release": releaseStep,
  "upgrade-snapshot": snapshot,
  "upgrade-settings": settingsStep,
  "upgrade-host": hostStep,
  "upgrade-coordinator": coordinatorStep,
  "upgrade-dev-build": devBuildStep,
  "upgrade-dev": devStep,
  "upgrade-guest-client": guestClientStep,
  "upgrade-verify": verify,
  "upgrade-finish": finish,
  "follow-check": followCheck,
  "follow-finish": followFinish,
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
  const keep = ["previousHost", "previousCoordinator", "devPreviousImage", "devPreviousRelease"];
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
  if (!(await runSteps(state.plan.steps, state, emit, { stopAfter: exitAfterHangup })))
    return false;
  emit({
    result: {
      ...installResult(install.data.plan, install.data.outputs),
      ...(plan.settings.name !== undefined ? { name: plan.settings.name } : {}),
      ...(plan.upgrade ? { upgraded: { from: plan.from, to: plan.to } } : {}),
    },
  });
  return true;
}
