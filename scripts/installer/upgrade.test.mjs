import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { detect } from "./detect.mjs";
import { fakeContext, fakeRunner } from "./fakes.mjs";
import { AGENT_SCRIPT, INSTALLATION_SKILL } from "./host-installation.mjs";
import { pointLink } from "./steps.mjs";
import {
  UPGRADE_JOURNAL,
  applyUpgrade,
  compareVersions,
  createUpgradePlan,
  describeInstalled,
} from "./upgrade.mjs";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const ID = "00000000-0000-4000-8000-0000000000aa";

const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};

function release(directory, { revision, version, marker = "installer" }) {
  mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "package.json"), { version });
  if (marker === "installer")
    writeJson(path.join(directory, ".installer-release.json"), { revision });
  if (marker === "receipt")
    writeJson(path.join(directory, ".installation-source.json"), { sourceCommit: revision });
  return directory;
}

/**
 * An installation as release 26.11.103's installer leaves it: the journal and plan, a
 * release behind both service links, the coordinator configuration and its state. The
 * plan and layout have not changed since that release (plan.mjs PLAN_VERSION 1).
 * `adoptHost` lays it out the way an in-place upgrade of a pre-installer Host does: the
 * root is its own host folder and the release folder is named by commit, without a marker.
 */
function oldInstallation(context, { devContainer = false, adoptHost = false, sourceUpdates } = {}) {
  const root = context.root;
  const host = adoptHost ? root : path.join(root, "host");
  const releases = path.join(host, "releases");
  const paths = {
    home: context.home,
    root,
    source: path.join(root, "source"),
    host,
    state: path.join(root, "state"),
    journal: path.join(root, "state", "install.json"),
    ownerPassword: path.join(host, "owner-password"),
    record: path.join(host, "installation.json"),
    coordinatorConfig: path.join(host, "coordinator.json"),
    coordinatorState: path.join(host, "state", "coordinator"),
    hostHome: path.join(host, "state", "host"),
    release: path.join(releases, OLD),
    hostReleaseLink: path.join(releases, "host-current"),
    coordinatorReleaseLink: path.join(releases, "coordinator-current"),
    logs: path.join(host, "logs"),
    projectsFolder: path.join(context.home, "dev"),
    ...(devContainer ? { container: path.join(root, "container") } : {}),
  };
  release(paths.release, {
    revision: OLD,
    version: "26.11.103",
    marker: adoptHost ? "none" : "installer",
  });
  symlinkSync(paths.release, paths.hostReleaseLink);
  symlinkSync(paths.release, paths.coordinatorReleaseLink);
  mkdirSync(path.join(paths.source, ".git"), { recursive: true });
  mkdirSync(paths.coordinatorState, { recursive: true });
  mkdirSync(paths.hostHome, { recursive: true });
  writeJson(paths.record, { version: 1, installationId: ID, phase: "started" });
  writeJson(paths.coordinatorConfig, {
    public: { installationId: ID, origin: "http://localhost:6790" },
    stateDir: paths.coordinatorState,
    listenPort: 6790,
    deployment: {
      installRoot: root,
      sourceDirectory: paths.source,
      hostHome: paths.hostHome,
      hostReleaseLink: paths.hostReleaseLink,
      coordinator: { releaseLink: paths.coordinatorReleaseLink },
      ...(devContainer ? { containerDirectory: paths.container } : {}),
    },
    ...(devContainer ? { container: {} } : {}),
    ...(sourceUpdates ? { sourceUpdates } : {}),
  });
  writeJson(path.join(paths.host, "host-agent.json"), { token: "host-token", kind: "host-agent" });
  if (devContainer) {
    mkdirSync(paths.container, { recursive: true });
    writeFileSync(
      path.join(paths.container, ".env"),
      "PASEO_INSTANCE=paseo-old\nPASEO_IMAGE=sha256:old\n",
    );
    writeFileSync(path.join(paths.container, ".container-installation"), "1\n");
    writeJson(path.join(paths.host, "container-agent.json"), { token: "dev-token" });
  }
  const label = `local.vorteo.${ID}`;
  const plan = {
    version: 1,
    installationId: ID,
    createdAt: "2026-11-01T18:30:00.000Z",
    platform: context.platform,
    kind: adoptHost ? "adopt-host" : "new",
    name: "Vorteo",
    revision: OLD,
    releaseVersion: "release-26.11.103",
    devContainer,
    remote: { mode: "local" },
    ports: { coordinator: 6790, host: 6791, ...(devContainer ? { devRelay: 6792 } : {}) },
    paths,
    services: { manager: "launchd", host: `${label}.host`, coordinator: `${label}.installation` },
    executables: {
      node: "/opt/node/bin/node",
      git: "/usr/bin/git",
      npm: "/opt/node/bin/npm",
      ...(devContainer ? { docker: "/usr/bin/docker" } : {}),
    },
    ...(devContainer
      ? { dev: { user: "paseo", cli: "paseo", daemonHome: "/home/paseo/.paseo" } }
      : {}),
    steps: ["prepare", "finish"],
  };
  writeJson(paths.journal, {
    version: 1,
    installationId: ID,
    startedAt: "2026-11-01T18:30:00.000Z",
    completedAt: "2026-11-01T18:50:00.000Z",
    plan,
    steps: {},
    outputs: {
      origin: "http://localhost:6790",
      ...(devContainer ? { instance: "paseo-old" } : {}),
    },
  });
  return paths;
}

/**
 * A machine where the target release builds, every service restarts on request and the
 * coordinator answers health with a new pid after each restart. `policy` makes the new
 * coordinator offer in-app updates.
 */
function machine({
  devContainer = false,
  targetHasPolicy = true,
  coordinatorStarts = true,
  devHealthy = () => true,
  ...options
} = {}) {
  const state = { pid: 100, restarts: [], devImage: "sha256:old", snapshots: 0, coordinatorStarts };
  let paths;
  const context = fakeContext({
    rules: [
      ["git show", JSON.stringify({ version: "26.11.302" })],
      [
        (command, args) =>
          command === "git" && args[0] === "cat-file" && args[2].includes("release-updates.ts"),
        () => (targetHasPolicy ? "" : new Error("missing")),
      ],
      ["git cat-file", ""],
      [
        "tar -xf",
        (args) => {
          // The archive of the target release: its manifest and the files steps copy.
          const target = args[3];
          if (!target.endsWith(NEW)) return;
          writeJson(path.join(target, "package.json"), { version: "26.11.302" });
          for (const file of [INSTALLATION_SKILL, AGENT_SCRIPT]) {
            mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
            writeFileSync(path.join(target, file), "INSTALLATION_SETTINGS_URL\n");
          }
        },
      ],
      [
        "launchctl kickstart",
        (args) => {
          state.restarts.push(args[2]);
          // Only the new release can be broken: the previous one always starts again.
          const onPrevious = realpathSync(paths.coordinatorReleaseLink).endsWith(OLD);
          if (args[2].endsWith(".installation") && (state.coordinatorStarts || onPrevious))
            state.pid += 1;
        },
      ],
      ["docker info", "27.0.0"],
      // No Host build from an interface upgrade is running.
      ["pgrep", new Error("no process")],
      ["launchctl print", new Error("Could not find service")],
      [
        "launchctl bootstrap",
        (args) => {
          const onPrevious = realpathSync(paths.coordinatorReleaseLink).endsWith(OLD);
          if (args[2].endsWith(".installation.plist") && (state.coordinatorStarts || onPrevious))
            state.pid += 1;
        },
      ],
      ["docker image inspect", new Error("No such image")],
      [
        "docker build",
        (args) => writeFileSync(args[args.indexOf("--iidfile") + 1], "sha256:new\n"),
      ],
      [
        (command, args) => command === "bash" && args[0].endsWith("update.sh"),
        (args) => {
          state.devImage = args[1];
          writeFileSync(
            path.join(paths.container, ".env"),
            `PASEO_INSTANCE=paseo-old\nPASEO_IMAGE=${args[1]}\n`,
          );
        },
      ],
      [
        (command, args) => command === "docker" && args.includes("curl"),
        () => JSON.stringify({ installationId: ID }),
      ],
      [
        (command, args) => command === "docker" && args[0] === "exec" && args.includes("-p"),
        "/home/paseo",
      ],
    ],
    fetch: async (url) => {
      if (String(url).endsWith("/update-status"))
        return targetHasPolicy
          ? {
              ok: true,
              status: 200,
              json: async () => ({ policy: { mode: "manual", channel: "stable" } }),
            }
          : { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({ installationId: ID, pid: state.pid }) };
    },
    readyTimeoutMs: 30,
    upgradeModules: {
      connectInstallationDaemon: async (_config, target) => ({
        getDaemonStatus: async () => {
          if (target === "container" && !devHealthy(state.devImage)) throw new Error("Dev is down");
          return {};
        },
        close: async () => {},
      }),
      snapshots: {
        snapshotRoot: (config) => path.join(config.deployment.installRoot, "state", "snapshots"),
        snapshotSources: () => [],
        dockerSnapshotPorts: {},
        createInstallationSnapshots: () => ({
          take: async () => ({ id: `20261104T00000${++state.snapshots}Z` }),
          prune: () => [],
        }),
      },
    },
  });
  paths = oldInstallation(context, { devContainer, ...options });
  return { context, state, paths };
}

async function upgradePlan(context, extra = {}) {
  return createUpgradePlan(context, {
    source: path.join(context.root, "source"),
    revision: NEW,
    release: "release-26.11.302",
    ...extra,
  });
}

async function apply(context, plan) {
  const events = [];
  const ok = await applyUpgrade(plan, context, (event) => events.push(event));
  return { ok, events, failure: events.find((event) => event.status === "fail") };
}

describe("installed version", () => {
  test.each([
    ["26.11.206", "26.11.103", 1],
    ["26.11.103", "26.11.206", -1],
    ["26.11.302", "26.11.302", 0],
    ["26.12.101", "26.11.999", 1],
    ["26.11.103", "unknown", null],
  ])("compareVersions(%s, %s) is %s", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  test("detect reports the release, version and commit of an installer-made installation", async () => {
    const { context } = machine();
    const found = await detect(context, { docker: false });
    expect(found.existing).toMatchObject({
      kind: "current",
      installed: {
        version: "26.11.103",
        revision: OLD,
        release: "release-26.11.103",
        coordinator: { version: "26.11.103", revision: OLD },
      },
    });
  });

  test("an in-place upgraded pre-installer Host is read from its commit-named release", () => {
    const { context } = machine({ adoptHost: true });
    expect(describeInstalled(context.root)).toMatchObject({ version: "26.11.103", revision: OLD });
  });

  test("a release installed from the interface is named from the coordinator's journal", () => {
    const { context, paths } = machine();
    const next = release(path.join(paths.host, "releases", NEW), {
      revision: NEW,
      version: "26.11.206",
    });
    for (const link of [paths.hostReleaseLink, paths.coordinatorReleaseLink]) pointLink(link, next);
    writeJson(path.join(paths.coordinatorState, "upgrades", "journal.json"), {
      version: 1,
      upgrades: [{ status: "succeeded", sourceCommit: NEW, release: "release-26.11.206" }],
    });
    expect(describeInstalled(context.root)).toMatchObject({
      version: "26.11.206",
      revision: NEW,
      release: "release-26.11.206",
    });
  });
});

describe("upgrade plan", () => {
  test("a newer release plans the whole upgrade and offers the update settings", async () => {
    const { context } = machine({ devContainer: true });
    const result = await upgradePlan(context);
    expect(result.comparison).toBe("newer");
    expect(result.settings).toEqual({
      name: "Vorteo",
      updateMode: "manual",
      updateChannel: "stable",
    });
    expect(result.plan.steps).toEqual([
      "upgrade-check",
      "upgrade-release",
      "upgrade-snapshot",
      "upgrade-host",
      "upgrade-coordinator",
      "upgrade-dev",
      "upgrade-guest-client",
      "upgrade-verify",
      "upgrade-finish",
    ]);
    expect(result.summary.join("\n")).toMatch(
      /from 26\.11\.103 \(release-26\.11\.103\) to 26\.11\.302/,
    );
  });

  test("a commit passed as the release names no release", async () => {
    const { context } = machine();
    const result = await upgradePlan(context, { release: NEW });
    expect(result.target.release).toBeNull();
    expect(result.plan.to.release).toBeNull();
  });

  test("the same, an older and an unchanged-settings run plan nothing", async () => {
    const { context } = machine();
    const same = await upgradePlan(context, { revision: OLD });
    expect(same.comparison).toBe("same");
    expect(same.plan).toBeUndefined();
    const older = machine();
    older.context.run = fakeRunner([["git show", JSON.stringify({ version: "26.10.900" })]]);
    const result = await upgradePlan(older.context);
    expect(result.comparison).toBe("older");
    expect(result.plan).toBeUndefined();
  });

  test("settings the target cannot change are dropped, and unchanged ones plan nothing", async () => {
    const { context } = machine({ targetHasPolicy: false });
    const result = await upgradePlan(context, {
      settingsOnly: true,
      settings: { name: "Vorteo", updateMode: "automatic" },
    });
    expect(result.settings).toEqual({ name: "Vorteo" });
    expect(result.plan).toBeUndefined();
  });

  test("Host source updates keep the installation on the interface's upgrade path", async () => {
    const { context } = machine({ sourceUpdates: { currentReleaseLink: "/x" } });
    const result = await upgradePlan(context);
    expect(result.unsupported.fix).toMatch(/Settings/);
    expect(result.plan).toBeUndefined();
  });
});

describe("upgrade", () => {
  test("moves Host and coordinator to the new release, keeping the previous one", async () => {
    const { context, state, paths } = machine();
    const { plan } = await upgradePlan(context, {
      settings: { name: "Studio", updateMode: "automatic", updateChannel: "beta" },
    });
    const { ok, events, failure } = await apply(context, plan);
    expect(failure).toBeUndefined();
    expect(ok).toBe(true);
    const next = realpathSync(path.join(paths.host, "releases", NEW));
    expect(realpathSync(paths.hostReleaseLink)).toBe(next);
    expect(realpathSync(paths.coordinatorReleaseLink)).toBe(next);
    expect(existsSync(paths.release)).toBe(true);
    expect(state.restarts).toEqual([
      `gui/501/local.vorteo.${ID}.host`,
      `gui/501/local.vorteo.${ID}.installation`,
    ]);
    expect(
      JSON.parse(readFileSync(path.join(paths.coordinatorState, "update-policy.json"), "utf8")),
    ).toEqual({
      version: 1,
      policy: { mode: "automatic", channel: "beta" },
    });
    expect(events.at(-1).result).toMatchObject({
      name: "Studio",
      upgraded: { to: { revision: NEW } },
    });
    expect(describeInstalled(context.root)).toMatchObject({
      version: "26.11.302",
      revision: NEW,
      release: "release-26.11.302",
    });
    const journal = JSON.parse(readFileSync(path.join(context.root, UPGRADE_JOURNAL), "utf8"));
    expect(journal.completedAt).toBeTruthy();
    expect(journal.outputs).toMatchObject({
      snapshotId: "20261104T000001Z",
      previousHost: realpathSync(paths.release),
    });
  });

  test("a coordinator that does not start returns to the previous release, and a rerun resumes", async () => {
    const box = machine({ coordinatorStarts: false });
    const { plan } = await upgradePlan(box.context);
    const first = await apply(box.context, plan);
    expect(first.ok).toBe(false);
    expect(first.failure.step).toBe("upgrade-coordinator");
    expect(first.failure.message).toMatch(/runs .*aaaa.* again/);
    expect(realpathSync(box.paths.coordinatorReleaseLink)).toBe(realpathSync(box.paths.release));
    expect(describeInstalled(box.context.root).unfinishedUpgrade.to.revision).toBe(NEW);
    expect((await upgradePlan(box.context)).comparison).toBe("unfinished");

    // The coordinator starts on the rerun; finished steps are skipped.
    box.state.coordinatorStarts = true;
    const second = await apply(box.context, plan);
    expect(second.ok).toBe(true);
    expect(
      second.events.filter((event) => event.status === "skip").map((event) => event.step),
    ).toEqual(
      expect.arrayContaining([
        "upgrade-check",
        "upgrade-release",
        "upgrade-snapshot",
        "upgrade-host",
      ]),
    );
    expect(realpathSync(box.paths.coordinatorReleaseLink)).toBe(
      realpathSync(path.join(box.paths.host, "releases", NEW)),
    );
  });

  test("Dev that fails on the new image runs the previous image again", async () => {
    const { context, state } = machine({
      devContainer: true,
      devHealthy: (image) => image !== "sha256:new",
    });
    const { plan } = await upgradePlan(context);
    const { ok, failure } = await apply(context, plan);
    expect(ok).toBe(false);
    expect(failure.step).toBe("upgrade-dev");
    expect(failure.message).toMatch(/previous image again/);
    expect(state.devImage).toBe("sha256:old");
  });

  test.each([
    ["stuck in a release without the fix, it is replaced", false, true],
    ["running in a release that can finish it, the installer waits", true, false],
  ])("an interface upgrade %s", async (_name, fixed, replaced) => {
    const { context, paths } = machine();
    const dist = path.join(
      paths.release,
      "packages/server/dist/server/server/execution-installation",
    );
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      path.join(dist, "release-upgrades.js"),
      fixed ? "z.string().regex(/^installer-[0-9a-f]{8}/)" : "z.string().uuid()",
    );
    const journal = path.join(paths.coordinatorState, "upgrades", "journal.json");
    writeJson(journal, {
      version: 1,
      upgrades: [
        {
          id: "u1",
          release: "release-26.11.206",
          status: "running",
          steps: [{ name: "host", status: "running" }],
        },
      ],
    });
    const { plan } = await upgradePlan(context);
    const { ok, failure } = await apply(context, plan);
    expect(ok).toBe(replaced);
    const [record] = JSON.parse(readFileSync(journal, "utf8")).upgrades;
    if (replaced) {
      expect(failure).toBeUndefined();
      expect(record).toMatchObject({ status: "failed", steps: [{ status: "failed" }] });
      // Stopped and started, not kickstarted, so the journal was ended while it was down.
      expect(context.run.commands()).toContainEqual(
        expect.stringMatching(/^launchctl bootstrap .*\.installation\.plist$/),
      );
    } else {
      expect(failure.message).toMatch(/started from the interface is running/);
      expect(record.status).toBe("running");
    }
  });

  test("a resumed Dev step recreates Dev when only its .env names the new image", async () => {
    const { context, state, paths } = machine({ devContainer: true });
    // update.sh wrote .env, then stopped before recreating the container.
    writeFileSync(
      path.join(paths.container, ".env"),
      "PASEO_INSTANCE=paseo-old\nPASEO_IMAGE=sha256:new\n",
    );
    context.run = fakeRunner([
      ["docker inspect", () => state.devImage],
      ["docker image inspect", (args) => args.at(-1)],
      ...context.run.rules,
    ]);
    const { plan } = await upgradePlan(context);
    writeJson(path.join(context.root, UPGRADE_JOURNAL), {
      version: 1,
      installationId: ID,
      startedAt: "2026-11-04T00:00:00.000Z",
      plan,
      steps: Object.fromEntries(
        [
          "upgrade-check",
          "upgrade-release",
          "upgrade-snapshot",
          "upgrade-host",
          "upgrade-coordinator",
        ].map((step) => [step, { status: "done" }]),
      ),
      outputs: { devPreviousImage: "sha256:old", devImage: "sha256:new" },
    });
    const { events } = await apply(context, plan);
    expect(events).toContainEqual(expect.objectContaining({ step: "upgrade-dev", status: "done" }));
    expect(context.run.commands()).toContainEqual(expect.stringMatching(/update\.sh sha256:new$/));
  });

  test.each([
    ["a running installer", () => process.ppid, /Another installer/],
    ["a killed installer", () => 999_999_999, /without releasing .*upgrade\.lock/],
    ["a lock still being written", () => undefined, /without releasing .*upgrade\.lock/],
  ])("an upgrade lock held by %s is never taken over", async (_name, pid, message) => {
    const { context } = machine();
    const { plan } = await upgradePlan(context);
    const lock = path.join(context.root, "state", "upgrade.lock");
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, pid() ? JSON.stringify({ pid: pid() }) : "");
    await expect(applyUpgrade(plan, context, () => {})).rejects.toThrow(message);
    expect(existsSync(lock)).toBe(true);
  });

  test("a finished upgrade releases its lock", async () => {
    const { context } = machine();
    const { plan } = await upgradePlan(context);
    expect((await apply(context, plan)).ok).toBe(true);
    expect(existsSync(path.join(context.root, "state", "upgrade.lock"))).toBe(false);
  });

  test("a release without update offers upgrades and says so", async () => {
    const { context } = machine({ devContainer: true, targetHasPolicy: false });
    const { plan } = await upgradePlan(context);
    const { ok, events, failure } = await apply(context, plan);
    expect(failure).toBeUndefined();
    expect(ok).toBe(true);
    expect(
      events.find((event) => event.step === "upgrade-verify" && event.status === "done").message,
    ).toMatch(/predates in-app update offers/);
  });
});
