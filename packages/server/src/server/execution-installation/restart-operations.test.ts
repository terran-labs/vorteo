import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  REVIEWED_CONFIGURATION_SETTINGS,
  type ReviewedConfigurationSetting,
} from "@getpaseo/protocol/coordinator-configuration-settings";
import type { InstallationConfig } from "./config.js";
import { createInstallationRestartExecutor, hostLauncherTarget } from "./daemon.js";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import {
  automaticPermitted,
  legacyOperationReplies,
  operationFor,
  RESTART_OPERATIONS,
  type RestartPlanField,
} from "./restart-operations.js";
import { delegableUnderGrant, OWNER_ONLY_OPERATIONS } from "./delegated-admission.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One valid value per registered setting that backs a restart operation. The digests
 * check real files, so executables and the Factory plan exist on disk. */
function samples(): Partial<Record<ReviewedConfigurationSetting, unknown>> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "restart-settings-")));
  roots.push(root);
  const script = path.join(root, "adopt.mjs");
  writeFileSync(script, "// fixture adoption plan\n", { mode: 0o700 });
  const docker = path.join(root, "docker");
  const dockerBytes = "#!/bin/sh\nexit 99\n";
  writeFileSync(docker, dockerBytes, { mode: 0o700 });
  return {
    supervisorMaintenance: {
      node: process.execPath,
      script,
      sha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
    },
    factoryRuntimeAdoption: {
      node: process.execPath,
      script,
      sha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
    },
    engineRestart: {
      docker: process.execPath,
      socket: path.join(root, "docker.sock"),
      containers: {
        dev: "a".repeat(64),
        gatewayTailscale: "b".repeat(64),
        gatewayCaddy: "c".repeat(64),
      },
    },
    engineRecovery: {
      deadlineSeconds: 420,
      docker,
      dockerSha256: createHash("sha256").update(dockerBytes).digest("hex"),
      socket: path.join(root, "docker.sock"),
      containers: {
        dev: "a".repeat(64),
        gatewayTailscale: "b".repeat(64),
        gatewayCaddy: "c".repeat(64),
      },
      factoryVerify: {
        script,
        sha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
        lockInode: 1,
        ownerMode: "paused",
      },
      baseline: {
        observedAt: "2026-10-28T00:00:00Z",
        evidenceSha256: "d".repeat(64),
        startedAt: {
          dev: "2026-10-28T00:00:00Z",
          gatewayTailscale: "2026-10-28T00:00:00Z",
          gatewayCaddy: "2026-10-28T00:00:00Z",
        },
        factory: {
          epoch: 1,
          supervisorPid: 2,
          ownerMode: "paused",
          ownerSequence: 1,
          custodyCount: 0,
          custodyDigest: "e".repeat(64),
        },
      },
    },
    hostLauncherUpdate: { candidate: path.join(root, "candidate.plist"), sha256: "c".repeat(64) },
    bootEntrySwitch: {
      docker: process.execPath,
      socket: path.join(root, "docker.sock"),
      container: "a".repeat(64),
      current: { pointer: pinned(root, "pointer", "/old/entry\n"), entry: pinned(root, "old") },
      target: pinned(root, "new"),
      node: pinned(root, "node"),
      supervisorEntry: pinned(root, "supervisor"),
      supervisor: { config: path.join(root, "supervisord.conf"), program: "paseo-server" },
      expectBootForm: "plain",
      factoryVerify: {
        script,
        sha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
        lockInode: 1,
        ownerMode: "paused",
      },
    },
  };
}

function pinned(root: string, name: string, bytes = `// ${name}\n`) {
  const file = path.join(root, name);
  writeFileSync(file, bytes, { mode: 0o600 });
  return { path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function baseConfig(): Record<string, unknown> {
  return {
    stateDir: "/fixture/state",
    public: { environments: [] },
    host: { launchdService: "gui/501/local.vorteo.fixture.host", endpoint: "127.0.0.1:1" },
    container: { endpoint: "127.0.0.1:2" },
    sourceUpdates: { currentReleaseLink: "/fixture/current", releaseRoot: "/fixture/releases" },
  };
}

function withSetting(location: readonly string[], value: unknown): Record<string, unknown> {
  const config = baseConfig();
  const section =
    location.length === 1 ? config : (config[location[0]!] as Record<string, unknown>);
  section[location[location.length - 1]!] = value;
  return config;
}

function planOf(operation: (typeof RESTART_OPERATIONS)[number], config: Record<string, unknown>) {
  return operation.plan(createInstallationRestartExecutor(config as unknown as InstallationConfig));
}

// The restart executor and its plans use POSIX paths; it runs only on the macOS Host and Linux Dev.
test.skipIf(process.platform === "win32")(
  "every reviewed restart operation's plan comes from the registered setting of the same name",
  () => {
    for (const operation of RESTART_OPERATIONS) {
      expect(
        Object.hasOwn(REVIEWED_CONFIGURATION_SETTINGS, operation.capability),
        operation.capability,
      ).toBe(true);
      const name = operation.capability as ReviewedConfigurationSetting;
      const setting = REVIEWED_CONFIGURATION_SETTINGS[name];
      const value = setting.value.parse(samples()[name]);
      const configured = withSetting(setting.path, value);
      if (name === "hostLauncherUpdate") {
        // Its digest also reads the live launch file, so check the plan's input instead:
        // the executor's launcher target is built from exactly this setting.
        const target = hostLauncherTarget(configured as unknown as InstallationConfig);
        const update = value as { candidate: string; sha256: string };
        expect(target?.candidate).toEqual({ path: update.candidate, sha256: update.sha256 });
        expect(hostLauncherTarget(baseConfig() as unknown as InstallationConfig)).toBeUndefined();
        continue;
      }
      if (name === "factoryRuntimeAdoption") {
        // Retired with the Factory controller: a recorded plan is never advertised.
        expect(planOf(operation, configured), name).toBeUndefined();
        continue;
      }
      // The executor advertises a plan exactly when the setting is present at its registry path.
      expect(planOf(operation, configured), name).toMatch(/^[a-f0-9]{64}$/);
      expect(planOf(operation, baseConfig()), name).toBeUndefined();
    }
  },
);

test("full owner delegation covers every plan by default except the named owner-only ones", () => {
  for (const operation of RESTART_OPERATIONS) {
    const job = { [operation.field]: "a".repeat(64) };
    expect(automaticPermitted(job, false, RESTART_OPERATIONS, true)).toBe(
      !OWNER_ONLY_OPERATIONS.includes(`restart-plan:${operation.field}`),
    );
    if (operation.automatic !== "allowed") expect(automaticPermitted(job, false)).toBe(false);
  }
  // A newly registered operation needs no opt-in: the grant covers it, and only the
  // exclusion list removes it.
  const added = {
    ...operationFor("engineRestartPlanSha256"),
    field: "newPlanSha256" as RestartPlanField,
    automatic: "never" as const,
  };
  const job = { newPlanSha256: "a".repeat(64) } as Parameters<typeof automaticPermitted>[0];
  expect(automaticPermitted(job, false, [added], true)).toBe(true);
  expect(automaticPermitted(job, false, [added], false)).toBe(false);
  expect(delegableUnderGrant("restart-plan:newPlanSha256")).toBe(true);
  expect(delegableUnderGrant("restart-plan:newPlanSha256", ["restart-plan:newPlanSha256"])).toBe(
    false,
  );
});

test("the Dev boot-entry switch is never automatic, but full delegation approves it", () => {
  const job = { bootEntrySwitchPlanSha256: "a".repeat(64) };
  expect(operationFor("bootEntrySwitchPlanSha256").automatic).toBe("never");
  expect(automaticPermitted(job, true)).toBe(false);
  // Owner decision 2026-11-07: the full grant covers it; dispatch still checks every pin.
  expect(automaticPermitted(job, true, RESTART_OPERATIONS, true)).toBe(true);
});

test("the Dev boot-entry switch refuses another plan, registration-bound Dev and stale Factory pins", async () => {
  const sample = samples().bootEntrySwitch as { factoryVerify: { sha256: string } };
  const switchJob = (sha256: string) =>
    ({ id: "job", target: "container-daemon", bootEntrySwitchPlanSha256: sha256 }) as RestartJob;
  const executorFor = (config: Record<string, unknown>) =>
    createInstallationRestartExecutor(config as unknown as InstallationConfig, () => undefined);
  const configured = withSetting(["container", "bootEntrySwitch"], sample);
  const executor = executorFor(configured);
  const digest = executor.bootEntrySwitchPlan!()!;
  // Each refusal comes before any Dev command; the fixture Docker binary is never run.
  await expect(executor.switchBootEntry!(switchJob("b".repeat(64)))).rejects.toThrow(
    "Dev boot-entry switch plan is unavailable or changed",
  );
  const stale = withSetting(["container", "bootEntrySwitch"], sample);
  (stale.container as Record<string, unknown>).factoryGate = {
    docker: process.execPath,
    socket: "/fixture/docker.sock",
    container: "a".repeat(64),
    verify: { ...sample.factoryVerify, sha256: "9".repeat(64) },
  };
  // A stale pin withholds the capability, and dispatch refuses it again.
  expect(executorFor(stale).bootEntrySwitchPlan!()).toBeUndefined();
  await expect(executorFor(stale).switchBootEntry!(switchJob(digest))).rejects.toThrow(
    "factoryGate must pin the same Factory check as the switch before it runs",
  );
  const bound = withSetting(["container", "bootEntrySwitch"], sample);
  (bound.container as Record<string, unknown>).persistentRegistration = {};
  const boundExecutor = executorFor(bound);
  expect(boundExecutor.bootEntrySwitchPlan!()).toBeUndefined();
  await expect(boundExecutor.switchBootEntry!(switchJob(digest))).rejects.toThrow(
    "Dev boot-entry switch requires an independently bound Dev operation",
  );
});

test("a client that did not negotiate an operation sees an ordinary restart it can only cancel", () => {
  for (const operation of RESTART_OPERATIONS) {
    if (!operation.legacyReply) continue;
    const job = {
      id: "job",
      target: operation.target,
      reason: "Reviewed",
      [operation.field]: "a".repeat(64),
    } as unknown as RestartJob;
    const legacy = legacyOperationReplies(job, {});
    expect(legacy[operation.field], operation.capability).toBeUndefined();
    expect(legacy.reason).toBe(operation.legacyReply.reason);
    expect(legacyOperationReplies(job, { [operation.capability]: true })).toBe(job);
  }
});
