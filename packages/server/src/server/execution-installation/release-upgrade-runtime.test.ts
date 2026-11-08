import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import { createHash } from "node:crypto";
import { hashDaemonPassword } from "../auth.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createInstallationServer } from "./server.js";
import type { InstallationConfig } from "./config.js";
import {
  adoptionRequired,
  createReleaseUpgradeRuntime,
  legacyHostCommit,
  upgradeBlocker,
} from "./release-upgrade-runtime.js";
import type { InstallationRestarts } from "./restarts.js";
import type { CommandRunner } from "./service-control.js";

// Host snapshots and upgrades run only on macOS and Linux Hosts; Windows Hosts are #35.
const posixTest = test.skipIf(process.platform === "win32");

const INSTALLED = "1".repeat(40);
const SUPERVISOR = "packages/server/dist/scripts/supervisor-entrypoint.js";
const COORDINATOR = "packages/server/dist/server/server/execution-installation/main.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "release-upgrade-runtime-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function touch(file: string, content = "") {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * The configuration scripts/install-execution-host.mjs wrote, beside its installation.json,
 * with a release folder named by its commit. Its installer engine records each run.
 */
function legacyInstallation(): { config: InstallationConfig; configFile: string; release: string } {
  const release = path.join(root, "releases", INSTALLED);
  touch(path.join(release, SUPERVISOR));
  touch(path.join(release, COORDINATOR));
  touch(
    path.join(release, "scripts/installer/main.mjs"),
    'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.ENGINE_LOG ?? "/dev/null", JSON.stringify(process.argv.slice(2)) + "\\n");\n',
  );
  touch(
    path.join(root, "installation.json"),
    JSON.stringify({ installationId: "791360b7-0000-4000-8000-000000000001" }),
  );
  const configFile = path.join(root, "coordinator.json");
  const config = {
    public: {
      version: 1,
      installationId: "791360b7-0000-4000-8000-000000000001",
      origin: "https://box.example.ts.net:44444",
      environments: [
        { kind: "host", serverId: "srv_host", endpoint: "box.example.ts.net:44445", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: path.join(release, "packages/server/dist/server/web-ui"),
    stateDir: path.join(root, "state", "coordinator"),
    ownerPasswordHash: "$2b$10$owner",
    hostAgentTokenHash: "c".repeat(64),
    containerAgentTokenHash: "d".repeat(64),
    host: {
      endpoint: "127.0.0.1:6771",
      password: "host-password",
      launchdService: "gui/501/local.vorteo.791360b7-0000-4000-8000-000000000001.host",
      startupValidation: {
        node: process.execPath,
        entrypoint: path.join(release, SUPERVISOR),
        home: path.join(root, "state", "host"),
      },
    },
  } as InstallationConfig;
  touch(configFile, JSON.stringify(config));
  return { config, configFile, release };
}

function hostUpdate(id: string, status: RestartJob["status"]): RestartJob {
  return {
    id,
    target: "host",
    status,
    reason: "Builds source update",
    update: {
      sourceCommit: "2".repeat(40),
      baseCommit: INSTALLED,
      sha256: "e".repeat(64),
      bytes: 1,
    },
  } as RestartJob;
}

function runtime(jobs: RestartJob[], legacy = legacyInstallation(), run?: CommandRunner) {
  return createReleaseUpgradeRuntime({
    config: legacy.config,
    configFile: legacy.configFile,
    restarts: { list: () => jobs } as unknown as InstallationRestarts,
    hostUpdates: null,
    logger: createTestLogger(),
    entrypoint: path.join(legacy.release, COORDINATOR),
    ...(run ? { run } : {}),
  });
}

posixTest("an installation from before the installer offers upgrades, which adopt it first", () => {
  const { config, configFile } = legacyInstallation();
  expect(adoptionRequired(config, configFile)).toBe(true);
  expect(upgradeBlocker(config)).toContain("one-command installer");
  expect(upgradeBlocker(config, true)).toBeNull();
  expect(legacyHostCommit(config)).toBe(INSTALLED);
  const status = runtime([]).upgradeStatus();
  expect(status).toMatchObject({ available: true, current: { sourceCommit: INSTALLED } });
  expect(status.detail).toContain("predates the one-command installer");
});

test("the coordinator update is unavailable while the service starts a fixed release", () => {
  const legacy = legacyInstallation();
  const link = path.join(root, "releases", "coordinator-current");
  legacy.config.deployment = {
    installRoot: root,
    sourceDirectory: path.join(root, "source"),
    hostHome: path.join(root, "state", "host"),
    hostReleaseLink: path.join(root, "current"),
    coordinator: {
      releaseLink: link,
      service: {
        launchdService: "gui/501/local.vorteo.791360b7-0000-4000-8000-000000000001.installation",
      },
    },
  } as InstallationConfig["deployment"];
  // `runtime` starts the coordinator from the release folder itself, not through `link`.
  const status = runtime([], legacy).coordinatorFollow.status();
  expect(status.available).toBe(false);
  expect(status.detail).toContain("fixed release");
});

test("only a configuration under the old installer's record is adopted, plan copies included", () => {
  const { config } = legacyInstallation();
  const elsewhere = mkdtempSync(path.join(tmpdir(), "not-an-installation-"));
  try {
    expect(adoptionRequired(config, path.join(elsewhere, "coordinator.json"))).toBe(false);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
  // A coordinator updated through a reviewed plan runs a copy inside its root's plan folder.
  const plan = path.join(root, "coordinator-plans", "ordinary-prepared-1", "candidate-config.json");
  expect(adoptionRequired(config, plan)).toBe(true);
});

test("a Host source update seen to succeed starts adoption once, detached", async () => {
  const log = path.join(root, "engine.log");
  process.env.ENGINE_LOG = log;
  try {
    const jobs = [hostUpdate("00000000-0000-4000-8000-000000000001", "succeeded")];
    const legacy = legacyInstallation();
    const upgrades = runtime(jobs, legacy);
    // Updates that finished before this coordinator started never trigger it.
    upgrades.adoptAfterSourceUpdate();
    expect(existsSync(path.join(legacy.config.stateDir, "adoption", "launch.json"))).toBe(false);
    jobs.push(hostUpdate("00000000-0000-4000-8000-000000000002", "succeeded"));
    upgrades.adoptAfterSourceUpdate();
    upgrades.adoptAfterSourceUpdate();
    const launch = JSON.parse(
      readFileSync(path.join(legacy.config.stateDir, "adoption", "launch.json"), "utf8"),
    );
    expect(launch.jobId).toBe("00000000-0000-4000-8000-000000000002");
    await expect.poll(() => existsSync(log), { timeout: 10_000 }).toBe(true);
    await expect
      .poll(() => readFileSync(log, "utf8").trim().split("\n").length, { timeout: 2000 })
      .toBe(1);
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([
      "adopt",
      "--root",
      root,
      "--outcome",
      path.join(legacy.config.stateDir, "adoption", "adoption.json"),
    ]);
  } finally {
    delete process.env.ENGINE_LOG;
  }
});

/** An installation the one-command installer made, with its deployment block. */
function installerInstallation() {
  const legacy = legacyInstallation();
  legacy.config.deployment = {
    installRoot: root,
    sourceDirectory: path.join(root, "source"),
    hostHome: path.join(root, "state", "host"),
    hostReleaseLink: path.join(root, "releases", "host-current"),
    coordinator: {
      releaseLink: path.join(root, "releases", "coordinator-current"),
      service: {
        launchdService: "gui/501/local.vorteo.791360b7-0000-4000-8000-000000000001.installation",
      },
    },
  } as InstallationConfig["deployment"];
  return legacy;
}

/** An installer-made installation with one approved upgrade journaled as `kind`. */
function installerWithApproved(kind: "release" | "source") {
  const legacy = installerInstallation();
  const record = {
    id: "00000000-0000-4000-8000-0000000000a1",
    revision: "00000000-0000-4000-8000-0000000000a2",
    sourceCommit: "2".repeat(40),
    previousCommit: INSTALLED,
    createdAt: "2026-11-07T12:00:00.000Z",
    status: "approved",
    detail: "Approved. Starting.",
    steps: ["snapshot", "fetch", "host", "coordinator", "dev"].map((name) => ({
      name,
      status: "pending",
      detail: "",
    })),
    private: {},
    ...(kind === "release"
      ? { release: "release-26.11.3001" }
      : { kind: "source-upgrade", reason: "Hotfix", requestedBy: "Owner", lastRelease: null }),
  };
  touch(
    path.join(
      legacy.config.stateDir,
      kind === "release" ? "upgrades" : "source-upgrades",
      "journal.json",
    ),
    JSON.stringify({ version: 1, upgrades: [record] }),
  );
  return runtime([], legacy);
}

test("an approved source upgrade holds off release upgrades and snapshot restores", async () => {
  const upgrades = installerWithApproved("source");
  expect(upgrades.sourceUpgrades?.dispatching()).toBe(true);
  // Refused by the conflict check before the release tag is ever resolved on GitHub.
  await expect(upgrades.upgrades?.request("release-26.11.3002")).rejects.toThrow("source upgrade");
  await expect(
    upgrades.restore({ id: "20261107T120000Z", parts: ["coordinator-state"] }),
  ).rejects.toThrow("running upgrade");
});

test("an approved release upgrade holds off source upgrades", async () => {
  const upgrades = installerWithApproved("release");
  // Refused before main is fetched.
  await expect(
    upgrades.sourceUpgrades?.request({
      commit: "3".repeat(40),
      reason: "Hotfix",
      requestedBy: "Owner",
    }),
  ).rejects.toThrow("release upgrade");
});

test("source upgrade routes accept only the owner of a Stable installation", async () => {
  const installation = installerInstallation();
  // The coordinator keeps its state in a private directory under its canonical path.
  const stateDir = path.join(realpathSync(root), "state", "coordinator");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const config = {
    ...installation.config,
    stateDir,
    ownerPasswordHash: hashDaemonPassword("owner-pass"),
    hostAgentTokenHash: createHash("sha256").update("host-agent-key").digest("hex"),
  } as InstallationConfig;
  touch(
    path.join(config.stateDir, "installation-type.json"),
    JSON.stringify({ version: 1, type: "lab", changedAt: "2026-11-07T12:00:00.000Z" }),
  );
  const app = createInstallationServer(
    config,
    { restart: async () => Promise.reject(new Error("No daemon restart")) } as never,
    createTestLogger(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { configFile: installation.configFile },
  );
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  config.listenPort = address.port;
  const post = (route: string, token: string, body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api/installation/owner/source-upgrades${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        // Loopback requests carry the local origin.
        origin: `http://127.0.0.1:${address.port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const request = { commit: "3".repeat(40), reason: "Hotfix" };
  try {
    // Agent request keys never reach owner routes.
    expect((await post("", "host-agent-key", request)).status).toBe(401);
    expect((await post("/query", "host-agent-key", {})).status).toBe(401);
    // The owner of a Lab installation is refused before anything is fetched.
    const refused = await post("", "owner-pass", request);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await refused.json())).toContain("Stable installations");
    const status = await post("/query", "owner-pass", {});
    expect(status.status).toBe(200);
    expect((await status.json()).upgrades).toEqual([]);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test("a release upgrade that would drop a source-upgraded Host commit fails at its fetch step", async () => {
  const installation = installerInstallation();
  const release = "release-26.11.3002";
  const releaseCommit = "4".repeat(40);
  // The installer-built Host runs INSTALLED, which a source upgrade installed.
  const hostRelease = path.join(root, "releases", INSTALLED);
  touch(path.join(hostRelease, ".installer-release.json"), JSON.stringify({ revision: INSTALLED }));
  symlinkSync(hostRelease, path.join(root, "releases", "host-current"));
  touch(
    path.join(installation.config.stateDir, "source-upgrades", "journal.json"),
    JSON.stringify({
      version: 1,
      upgrades: [
        {
          id: "00000000-0000-4000-8000-0000000000b1",
          revision: "00000000-0000-4000-8000-0000000000b2",
          kind: "source-upgrade",
          reason: "Hotfix",
          requestedBy: "Owner",
          lastRelease: null,
          sourceCommit: INSTALLED,
          previousCommit: "5".repeat(40),
          createdAt: "2026-11-07T12:00:00.000Z",
          status: "succeeded",
          detail: "Upgraded.",
          steps: ["snapshot", "fetch", "host", "coordinator", "dev"].map((name) => ({
            name,
            status: "succeeded",
            detail: "",
          })),
          private: {},
        },
      ],
    }),
  );
  const commands: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const line = [command, ...args].join(" ");
    commands.push(line);
    if (line.includes("ls-remote")) return `${releaseCommit}\trefs/tags/${release}\n`;
    if (line.includes("rev-parse")) return releaseCommit;
    if (line.includes("merge-base")) throw new Error("not an ancestor");
    return "";
  };
  const upgrades = runtime([], installation, run).upgrades;
  if (!upgrades) throw new Error("Release upgrades are unavailable");
  const pending = await upgrades.request(release);
  upgrades.decide(pending.id, pending.revision, "approve");
  await upgrades.drain();
  const [upgrade] = upgrades.list();
  expect(upgrade.status).toBe("failed");
  expect(upgrade.steps.map((step) => step.status)).toEqual([
    "succeeded",
    "failed",
    "skipped",
    "skipped",
    "skipped",
  ]);
  expect(upgrade.detail).toContain("which a source upgrade installed");
  expect(commands).toContainEqual(
    expect.stringContaining(`merge-base --is-ancestor ${INSTALLED} ${releaseCommit}`),
  );
});
