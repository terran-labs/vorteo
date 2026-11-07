import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { CoordinatorFollowJob } from "@getpaseo/protocol/installation-upgrades";
import { reviewBrokerSettings } from "./coordinator-broker-settings.js";
import type { InstallationConfig } from "./config.js";
import type { HandoffOutcome } from "./coordinator-handoff.js";
import {
  coordinatorRestartBlocker,
  type CoordinatorRestartState,
} from "./coordinator-restart-guard.js";
import {
  CoordinatorSettings,
  createCoordinatorSettingsJournal,
  sha256,
  type CoordinatorSettingsPorts,
} from "./coordinator-settings.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "coordinator-settings-"));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** A coordinator configuration on disk and a clock, shared by every process the test starts. */
function installation() {
  const disk = { config: `${JSON.stringify({ listenPort: 6000, claudeHostRefresh: false })}\n` };
  const follow: { job: CoordinatorFollowJob | null } = { job: null };
  const clock = { now: Date.parse("2026-11-05T12:00:00Z") };
  return { disk, follow, clock };
}

/** The shared restart check with nothing else in progress, apart from `busy`. */
function restartCheck(busy: Partial<Record<keyof CoordinatorRestartState, boolean>>) {
  const state = Object.fromEntries(
    [
      "upgradeActive",
      "followDispatching",
      "settingsDispatching",
      "customDomainRunning",
      "hostJobBusy",
      "coordinatorRequestOpen",
      "labUpdateActive",
    ].map((key) => [key, () => busy[key as keyof CoordinatorRestartState] === true]),
  ) as unknown as CoordinatorRestartState;
  return () => coordinatorRestartBlocker(state, "settings");
}

/** Records every effect with the journaled status at that moment. */
function settingsPorts(
  state: ReturnType<typeof installation>,
  changes: Partial<CoordinatorSettingsPorts> = {},
) {
  const calls: string[] = [];
  let outcome: HandoffOutcome | null = null;
  const recorded = () => createCoordinatorSettingsJournal(directory).read().at(-1)?.status;
  const ports: CoordinatorSettingsPorts = {
    now: () => new Date(state.clock.now),
    blocker: null,
    readConfig: () => state.disk.config,
    validate: () => {},
    runningSha256: sha256(state.disk.config),
    conflict: () => null,
    followJob: (id) => (state.follow.job?.id === id ? state.follow.job : null),
    writeConfig: (_id, _previous, next) => {
      calls.push(`write ${recorded()}`);
      state.disk.config = next;
    },
    restoreConfig: () => calls.push("restore"),
    launchBlocker: () => null,
    launch: () => calls.push(`launch ${recorded()}`),
    outcome: () => outcome,
    reviewBroker: async () => ({}),
    deadlineMs: 60_000,
    warn: (message) => calls.push(`warn ${message}`),
    ...changes,
  };
  const settings = new CoordinatorSettings(createCoordinatorSettingsJournal(directory), ports);
  return {
    settings,
    calls,
    report: (status: HandoffOutcome["status"]) => {
      outcome = {
        id: "00000000-0000-4000-8000-000000000000",
        status,
        detail: `Coordinator ${status}`,
        finishedAt: "2026-11-05T12:01:00.000Z",
      };
    },
  };
}

function requestRefresh(state: ReturnType<typeof installation>, settings: CoordinatorSettings) {
  return settings.request({
    patch: { claudeHostRefresh: true },
    baseSha256: sha256(state.disk.config),
  });
}

/** Requests, approves and starts the change, which leaves it running. */
async function started(state: ReturnType<typeof installation>, settings: CoordinatorSettings) {
  const job = await requestRefresh(state, settings);
  settings.decide(job.id, job.revision, "approve");
  await settings.drain();
  return job;
}

function followJob(status: CoordinatorFollowJob["status"]): CoordinatorFollowJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    revision: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-11-05T11:00:00.000Z",
    status,
    detail: "",
    next: "/releases/new",
  };
}

test.each([
  {
    name: "refuses an unregistered key",
    run: async () => {
      const state = installation();
      const { settings } = settingsPorts(state);
      await expect(
        settings.request({
          patch: { ownerPasswordHash: "$2b$x" },
          baseSha256: sha256(state.disk.config),
        }),
      ).rejects.toThrow("not a coordinator setting");
    },
  },
  {
    name: "refuses an invalid value",
    run: async () => {
      const state = installation();
      const { settings } = settingsPorts(state);
      await expect(
        settings.request({
          patch: { claudeHostRefresh: "yes" },
          baseSha256: sha256(state.disk.config),
        }),
      ).rejects.toThrow("invalid value");
    },
  },
  {
    name: "refuses a stale base hash at request and at dispatch",
    run: async () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      await expect(
        settings.request({ patch: { claudeHostRefresh: true }, baseSha256: "0".repeat(64) }),
      ).rejects.toThrow("changed since");
      const job = await requestRefresh(state, settings);
      settings.decide(job.id, job.revision, "approve");
      state.disk.config = `${JSON.stringify({ listenPort: 6001 })}\n`;
      await settings.drain();
      expect(settings.status().job).toMatchObject({ status: "failed" });
      expect(calls).toEqual([]);
    },
  },
  {
    name: "journals before the write and launch, and launches once",
    run: async () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      const job = await requestRefresh(state, settings);
      expect(job.changes).toEqual([
        { key: "claudeHostRefresh", displaySafe: true, before: "false", after: "true" },
      ]);
      settings.decide(job.id, job.revision, "approve");
      await settings.drain();
      await settings.drain();
      expect(calls).toEqual(["write running", "launch running"]);
      expect(JSON.parse(state.disk.config)).toMatchObject({ claudeHostRefresh: true });
    },
  },
  {
    name: "a restarted coordinator resumes from the handoff outcome and records a rollback",
    run: async () => {
      const state = installation();
      const first = settingsPorts(state);
      const job = await requestRefresh(state, first.settings);
      first.settings.decide(job.id, job.revision, "approve");
      await first.settings.drain();
      const second = settingsPorts(state);
      await second.settings.drain();
      expect(second.settings.status().job?.status).toBe("running");
      second.report("rolled-back");
      await second.settings.drain();
      expect(second.settings.status().job?.status).toBe("rolled-back");
      expect(second.calls).toEqual([]);
    },
  },
  {
    name: "a combined approval applies only after the coordinator update succeeds",
    run: async () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      const job = await requestRefresh(state, settings);
      state.follow.job = followJob("pending");
      const linked = settings.approveWithFollow(job.id, job.revision, () => {
        state.follow.job = followJob("approved");
        return state.follow.job;
      });
      expect(linked).toMatchObject({ status: "pending", approvedWith: state.follow.job.id });
      await settings.drain();
      expect(calls).toEqual([]);
      state.follow.job = followJob("succeeded");
      await settings.drain();
      expect(calls).toEqual(["write running", "launch running"]);
      expect(settings.status().job?.approvedWith).toBe(state.follow.job.id);
    },
  },
  {
    name: "a combined approval leaves the settings pending when the update rolls back",
    run: async () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      const job = await requestRefresh(state, settings);
      settings.approveWithFollow(job.id, job.revision, () => {
        state.follow.job = followJob("running");
        return state.follow.job;
      });
      state.follow.job = followJob("rolled-back");
      await settings.drain();
      expect(settings.status().job).toMatchObject({ status: "pending" });
      expect(settings.status().job?.approvedWith).toBeUndefined();
      expect(calls).toEqual([]);
    },
  },
  {
    name: "refuses a decision on a revision the owner did not review",
    run: async () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      const job = await requestRefresh(state, settings);
      expect(() =>
        settings.decide(job.id, "33333333-3333-4333-8333-333333333333", "approve"),
      ).toThrow("Review it again");
      await settings.drain();
      expect(settings.status().job?.status).toBe("pending");
      expect(calls).toEqual([]);
    },
  },
  {
    name: "refuses a request while a custom domain change restarts the coordinator",
    run: async () => {
      const state = installation();
      const { settings } = settingsPorts(state, {
        conflict: restartCheck({ customDomainRunning: true }),
      });
      await expect(requestRefresh(state, settings)).rejects.toThrow("custom domain");
    },
  },
  {
    name: "refuses approval while a Host job is approved",
    run: async () => {
      const state = installation();
      let busy = false;
      const conflict = restartCheck({ hostJobBusy: true });
      const { settings, calls } = settingsPorts(state, {
        conflict: () => (busy ? conflict() : null),
      });
      const job = await requestRefresh(state, settings);
      busy = true;
      expect(() => settings.decide(job.id, job.revision, "approve")).toThrow("Host restart");
      expect(settings.status().job?.status).toBe("pending");
      expect(calls).toEqual([]);
    },
  },
  {
    name: "fails at dispatch when another restart started after approval",
    run: async () => {
      const state = installation();
      let busy = false;
      const conflict = restartCheck({ followDispatching: true });
      const { settings, calls } = settingsPorts(state, {
        conflict: () => (busy ? conflict() : null),
      });
      const job = await requestRefresh(state, settings);
      settings.decide(job.id, job.revision, "approve");
      busy = true;
      await settings.drain();
      expect(settings.status().job).toMatchObject({
        status: "failed",
        detail: "Wait for the coordinator update to finish.",
      });
      expect(calls).toEqual([]);
    },
  },
  {
    name: "restores the previous configuration when the handoff fails to spawn",
    run: async () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state, {
        launch: (_id, onError) => onError(new Error("spawn ENOENT")),
      });
      await started(state, settings);
      expect(calls).toEqual(["write running", "restore"]);
      expect(settings.status().job).toMatchObject({ status: "failed" });
      expect(settings.status().job?.detail).toContain("spawn ENOENT");
    },
  },
  {
    name: "a handoff that never reports succeeds when the new configuration runs",
    run: async () => {
      const state = installation();
      await started(state, settingsPorts(state).settings);
      // The restarted coordinator parsed the new file at startup.
      const restarted = settingsPorts(state, { runningSha256: sha256(state.disk.config) });
      state.clock.now += 60_001;
      await restarted.settings.drain();
      expect(restarted.settings.status().job?.status).toBe("succeeded");
      expect(restarted.calls).toEqual([]);
    },
  },
  {
    name: "a handoff that never reports fails and restores the file under the old coordinator",
    run: async () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      await started(state, settings);
      state.clock.now += 60_001;
      await settings.drain();
      expect(settings.status().job?.status).toBe("failed");
      expect(calls).toEqual(["write running", "launch running", "restore"]);
    },
  },
  {
    name: "an unreadable handoff outcome fails the job instead of throwing on every drain",
    run: async () => {
      const state = installation();
      const { settings } = settingsPorts(state, {
        outcome: () => {
          throw new Error("Unexpected token in JSON");
        },
      });
      await started(state, settings);
      await expect(settings.drain()).resolves.toBeUndefined();
      expect(settings.status().job).toMatchObject({ status: "failed" });
      expect(settings.status().job?.detail).toContain("could not be followed");
    },
  },
  {
    name: "an unreadable journal is moved aside and changes stay unavailable",
    run: async () => {
      const state = installation();
      writeFileSync(path.join(directory, "journal.json"), '{"version":2,"jobs":[]}');
      const { settings, calls } = settingsPorts(state);
      expect(settings.status().available).toBe(false);
      await expect(requestRefresh(state, settings)).rejects.toThrow("journal could not be read");
      expect(existsSync(path.join(directory, "journal.json"))).toBe(false);
      expect(
        readdirSync(directory).some((name) => name.startsWith("journal.json.unreadable-")),
      ).toBe(true);
      expect(calls[0]).toContain("warn");
    },
  },
])("coordinator settings $name", ({ run }) => run());

/**
 * An installer layout on disk: a coordinator release holding the broker code and recovery
 * readers, plus the interpreters and broker placement the installation already records.
 */
function brokerInstallation() {
  const root = realpathSync(directory);
  const write = (file: string, text: string, mode = 0o644) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, { mode });
    chmodSync(file, mode);
    return { path: file, sha256: sha256(text) };
  };
  const release = path.join(root, "releases", "coordinator-1");
  const dist = path.join(release, "packages/server/dist/server/server/execution-installation");
  const tailscale = path.join(release, "docker/tailscale");
  mkdirSync(release, { recursive: true });
  symlinkSync(release, path.join(root, "releases", "coordinator-current"));
  const node = write(path.join(root, "bin/node"), "node", 0o755);
  const brokerRoots = [path.join(root, "brokers/native"), path.join(root, "brokers/dev")] as const;
  const binding = (broker: string, name: string) => ({
    root: broker,
    domain: "gui/501",
    label: `local.paseo.https-preview-broker.${name}`,
    plist: write(path.join(root, `agents/${name}.plist`), `plist ${name}`),
    interpreter: path.join(root, "bin/python"),
    argv: [path.join(root, "bin/python"), "-I", path.join(broker, "https_broker.py")],
  });
  const recorded = {
    docker: "/usr/local/bin/docker",
    socket: "/Users/owner/.docker/run/docker.sock",
    containerId: "a".repeat(64),
    roots: brokerRoots,
    bindings: [binding(brokerRoots[0], "native"), binding(brokerRoots[1], "dev")],
    scope: write(path.join(root, "task/participant-scope.json"), "{}"),
    nativeInspector: write(path.join(release, "scripts/inspect-coordinator-process.py"), "inspect"),
    python: write(path.join(root, "bin/python"), "python", 0o755),
    worker: write(path.join(tailscale, "broker_deployment_worker.py"), "worker v1"),
    modules: ["channel_identity", "broker_rebind", "broker_deployment"].map((name) =>
      write(path.join(tailscale, `${name}.py`), name),
    ),
    evidenceRoot: path.join(root, "task/evidence"),
    recovery: {
      node,
      journal: write(path.join(dist, "lifecycle-journal.js"), "journal"),
      queue: write(path.join(dist, "restarts.js"), "queue"),
      configModule: write(path.join(dist, "config.js"), "config"),
    },
  };
  const state = installation();
  state.disk.config = `${JSON.stringify({
    listenPort: 6000,
    stateDir: path.join(root, "state"),
    deployment: {
      installRoot: root,
      sourceDirectory: path.join(root, "source"),
      coordinator: {
        releaseLink: path.join(root, "releases", "coordinator-current"),
        service: { launchdService: "gui/501/local.vorteo.test.installation" },
      },
    },
    previewBrokerDeployment: recorded,
  })}\n`;
  const ports = settingsPorts(state, {
    reviewBroker: ({ keys, current, candidate }) =>
      reviewBrokerSettings(
        {
          keys,
          current: JSON.parse(current) as InstallationConfig,
          candidate: JSON.parse(candidate) as InstallationConfig,
          candidateFile: { path: path.join(root, "candidate.json"), sha256: "0".repeat(64) },
        },
        {
          writableMountRoots: async () => [],
          coordinatorNode: () => node.path,
          executorInputs: async () => {},
        },
      ),
  });
  /** A renewal that moves the worker to new bytes in the managed release. */
  const renewed = write(path.join(tailscale, "broker_deployment_worker.v2.py"), "worker v2");
  const request = (change: Record<string, unknown>) =>
    ports.settings.request({
      patch: { previewBrokerDeployment: { ...recorded, worker: renewed, ...change } },
      baseSha256: sha256(state.disk.config),
    });
  return { ...ports, root, release, renewed, write, request };
}

test.each([
  {
    name: "refuses a digest that does not match the file",
    change: (fx: BrokerFixture) => ({ worker: { ...fx.renewed, sha256: "b".repeat(64) } }),
    refused: "digest changed",
  },
  {
    name: "refuses a symlinked file",
    change: (fx: BrokerFixture) => {
      const link = path.join(fx.release, "docker/tailscale/linked_worker.py");
      symlinkSync(fx.renewed.path, link);
      return { worker: { ...fx.renewed, path: link } };
    },
    refused: "symbolic link",
  },
  {
    name: "refuses a file outside the managed release directories",
    change: (fx: BrokerFixture) => ({
      worker: fx.write(path.join(fx.root, "worktrees/task/broker_deployment_worker.py"), "x"),
    }),
    refused: "installer-managed release",
  },
  {
    name: "refuses a group-writable file",
    change: (fx: BrokerFixture) => ({
      worker: fx.write(path.join(fx.release, "docker/tailscale/open_worker.py"), "x", 0o664),
    }),
    refused: "writable by another account",
  },
  {
    name: "refuses a Docker socket other than the recorded one",
    change: () => ({ socket: "/tmp/agent.sock" }),
    refused: "must equal the installation's",
  },
  {
    name: "refuses a Dev container other than the recorded one",
    change: () => ({ containerId: "c".repeat(64) }),
    refused: "must equal the installation's",
  },
  {
    name: "refuses a Python other than the recorded one",
    change: (fx: BrokerFixture) => ({
      python: fx.write(path.join(fx.release, "bin/python"), "agent python", 0o755),
    }),
    refused: "python must stay",
  },
])("broker settings $name", async ({ change, refused }) => {
  const fx = brokerInstallation();
  await expect(fx.request(change(fx))).rejects.toThrow(refused);
  expect(fx.settings.status().job).toBeNull();
});

type BrokerFixture = ReturnType<typeof brokerInstallation>;

test("broker settings apply a verified change and refuse a file swapped after approval", async () => {
  const applied = brokerInstallation();
  const job = await applied.request({});
  expect(job.changes).toEqual([
    {
      key: "previewBrokerDeployment",
      displaySafe: true,
      fields: [
        {
          field: "worker",
          before: expect.stringMatching(/broker_deployment_worker\.py · sha256 [a-f0-9]{12}$/),
          after: `${applied.renewed.path} · sha256 ${applied.renewed.sha256.slice(0, 12)}`,
          verified: true,
        },
      ],
    },
  ]);
  applied.settings.decide(job.id, job.revision, "approve");
  await applied.settings.drain();
  expect(applied.calls).toEqual(["write running", "launch running"]);

  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory);
  const swapped = brokerInstallation();
  const pending = await swapped.request({});
  swapped.settings.decide(pending.id, pending.revision, "approve");
  writeFileSync(swapped.renewed.path, "worker swapped");
  await swapped.settings.drain();
  expect(swapped.settings.status().job).toMatchObject({ status: "failed" });
  expect(swapped.settings.status().job?.detail).toContain("no longer pass review");
  expect(swapped.calls).toEqual([]);
});
