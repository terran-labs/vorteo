import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import {
  BrokerReviewUnavailable,
  recordedConnection,
  reviewBrokerSettings,
  SCOPE_LIFETIME_MS,
} from "./coordinator-broker-settings.js";
import type { InstallationConfig } from "./config.js";
import type { HandoffOutcome } from "./coordinator-handoff.js";
import {
  coordinatorRestartBlocker,
  type CoordinatorRestartState,
} from "./coordinator-restart-guard.js";
import {
  CoordinatorSettings,
  createCoordinatorSettingsJournal,
  createScopeCustody,
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
    reviewBroker: async () => ({ fields: {}, values: {} }),
    keepScope: () => {},
    restoreScope: () => {},
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

/** The broker code files one release holds at their fixed paths. */
const DEPLOYMENT_MODULES = [
  "channel_identity",
  "broker_rebind",
  "broker_deployment",
  "broker_deployment_kernel",
  "broker_deployment_observation",
];

/**
 * An installer layout on disk: a running coordinator release holding the recorded broker code
 * and recovery readers, a newer installed Host release, an older retained release, and the
 * interpreters and broker placement the installation already records.
 */
function brokerInstallation() {
  const root = realpathSync(directory);
  const write = (file: string, text: string, mode = 0o644) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, { mode });
    chmodSync(file, mode);
    return { path: file, sha256: sha256(text) };
  };
  const release = (name: string, commit: string) => {
    const at = path.join(root, "releases", name);
    write(path.join(at, ".installation-source.json"), JSON.stringify({ sourceCommit: commit }));
    const code = (relative: string) => write(path.join(at, relative), `${name} ${relative}`);
    return {
      at,
      worker: code("docker/tailscale/broker_deployment_worker.py"),
      nativeInspector: code("scripts/inspect-coordinator-process.py"),
      modules: DEPLOYMENT_MODULES.map((module) => code(`docker/tailscale/${module}.py`)),
    };
  };
  const coordinator = release("coordinator-1", "c".repeat(40));
  const host = release("host-2", "d".repeat(40));
  const retained = release("old-0", "e".repeat(40));
  symlinkSync(coordinator.at, path.join(root, "releases", "coordinator-current"));
  symlinkSync(host.at, path.join(root, "releases", "host-current"));
  const dist = path.join(
    coordinator.at,
    "packages/server/dist/server/server/execution-installation",
  );
  const brokerRoots = [path.join(root, "brokers/native"), path.join(root, "brokers/dev")] as const;
  const python = write(path.join(root, "bin/python"), "python", 0o755);
  const binding = (broker: string, name: string) => ({
    root: broker,
    domain: "gui/501",
    label: `local.paseo.https-preview-broker.${name}`,
    plist: write(path.join(root, `agents/${name}.plist`), `plist ${name}`),
    interpreter: python.path,
    argv: [python.path, "-I", path.join(broker, "https_broker.py")],
  });
  const recorded = {
    docker: "/usr/local/bin/docker",
    socket: "/Users/owner/.docker/run/docker.sock",
    containerId: "a".repeat(64),
    roots: brokerRoots,
    bindings: [binding(brokerRoots[0], "native"), binding(brokerRoots[1], "dev")],
    scope: write(path.join(root, "task/participant-scope.json"), "{}", 0o600),
    nativeInspector: coordinator.nativeInspector,
    python,
    worker: coordinator.worker,
    modules: coordinator.modules,
    evidenceRoot: path.join(root, "task/evidence"),
    recovery: {
      node: write(path.join(root, "bin/node"), "node", 0o755),
      journal: write(path.join(dist, "lifecycle-journal.js"), "journal"),
      queue: write(path.join(dist, "restarts.js"), "queue"),
      configModule: write(path.join(dist, "config.js"), "config"),
    },
  };
  const state = installation();
  state.disk.config = `${JSON.stringify({
    public: { installationId: "7785796d-d4b1-445a-a2ad-b673a4dd6683" },
    listenPort: 6000,
    stateDir: path.join(root, "state"),
    deployment: {
      installRoot: root,
      sourceDirectory: path.join(root, "source"),
      hostReleaseLink: path.join(root, "releases", "host-current"),
      coordinator: {
        releaseLink: path.join(root, "releases", "coordinator-current"),
        service: { launchdService: "gui/501/local.vorteo.test.installation" },
      },
    },
    previewBrokerDeployment: recorded,
  })}\n`;
  const ports = settingsPorts(state, {
    ...createScopeCustody((jobId) => path.join(root, "state/work", jobId)),
    reviewBroker: ({ keys, current, candidate, phase }) =>
      reviewBrokerSettings(
        {
          keys,
          current: JSON.parse(current) as InstallationConfig,
          candidate: JSON.parse(candidate) as InstallationConfig,
          phase,
        },
        {
          writableMountRoots: async () => [],
          coordinatorNode: () => recorded.recovery.node.path,
          executorInputs: async () => {},
          now: () => new Date(state.clock.now),
          randomUUID,
          bootUUID: async () => "11111111-2222-4333-8444-555555555555",
          writeScope: async (file, text) => void write(file, text, 0o600),
          reviewScopeFile: () => path.join(root, "state/participant-scope.review.json"),
          removeFile: async (file) => rmSync(file, { force: true }),
        },
      ),
  });
  /** A renewal onto the installed Host release's code. */
  const renewal = (change: Record<string, unknown> = {}) => ({
    ...recorded,
    worker: host.worker,
    nativeInspector: host.nativeInspector,
    modules: host.modules,
    ...change,
  });
  const request = (change: Record<string, unknown> = {}) =>
    ports.settings.request({
      patch: { previewBrokerDeployment: renewal(change) },
      baseSha256: sha256(state.disk.config),
    });
  return { ...ports, state, root, host, coordinator, retained, recorded, write, request };
}

type BrokerFixture = ReturnType<typeof brokerInstallation>;

test.each([
  {
    name: "a digest that does not match the file",
    change: (fx: BrokerFixture) => ({ worker: { ...fx.host.worker, sha256: "b".repeat(64) } }),
    refused: "digest changed",
  },
  {
    name: "a symlinked file",
    change: (fx: BrokerFixture) => {
      rmSync(fx.host.worker.path);
      symlinkSync(fx.coordinator.worker.path, fx.host.worker.path);
      return { worker: { ...fx.coordinator.worker, path: fx.host.worker.path } };
    },
    refused: "symbolic link",
  },
  {
    name: "a downgrade to a retained release that is not installed",
    change: (fx: BrokerFixture) => ({
      worker: fx.retained.worker,
      nativeInspector: fx.retained.nativeInspector,
      modules: fx.retained.modules,
    }),
    refused: "installed Host or running coordinator release",
  },
  {
    name: "a module mixed in from another release",
    change: (fx: BrokerFixture) => ({
      modules: fx.host.modules.map((pin, index) => (index === 1 ? fx.coordinator.modules[1] : pin)),
    }),
    refused: "modules[1] must be",
  },
  {
    name: "a worker outside any release",
    change: (fx: BrokerFixture) => ({
      worker: fx.write(path.join(fx.root, "worktrees/task/broker_deployment_worker.py"), "x"),
    }),
    refused: "installed Host or running coordinator release",
  },
  {
    name: "a group-writable file",
    change: (fx: BrokerFixture) => {
      chmodSync(fx.host.worker.path, 0o664);
      return {};
    },
    refused: "writable by another account",
  },
  {
    name: "recovery readers from the named release rather than the running coordinator",
    change: (fx: BrokerFixture) => ({
      recovery: {
        ...fx.recorded.recovery,
        journal: fx.write(
          path.join(
            fx.host.at,
            "packages/server/dist/server/server/execution-installation/lifecycle-journal.js",
          ),
          "journal",
        ),
      },
    }),
    refused: "recovery readers",
  },
  {
    name: "a Docker socket other than the recorded one",
    change: () => ({ socket: "/tmp/agent.sock" }),
    refused: "must equal the installation's",
  },
  {
    name: "a Dev container other than the recorded one",
    change: () => ({ containerId: "f".repeat(64) }),
    refused: "must equal the installation's",
  },
  {
    name: "a Python other than the recorded one",
    change: (fx: BrokerFixture) => ({
      python: fx.write(path.join(fx.host.at, "bin/python"), "agent python", 0o755),
    }),
    refused: "python must stay",
  },
  {
    name: "other broker roots",
    change: (fx: BrokerFixture) => ({ roots: [fx.recorded.roots[1], fx.recorded.roots[0]] }),
    refused: "roots must stay",
  },
  {
    name: "other launchd bindings",
    change: (fx: BrokerFixture) => ({
      bindings: [
        { ...fx.recorded.bindings[0], label: "local.agent.broker" },
        fx.recorded.bindings[1],
      ],
    }),
    refused: "bindings must stay",
  },
  {
    name: "another scope path",
    change: (fx: BrokerFixture) => ({
      scope: fx.write(path.join(fx.root, "task/agent-scope.json"), "{}", 0o600),
    }),
    refused: "scope must stay",
  },
  {
    name: "another evidence root",
    change: (fx: BrokerFixture) => ({ evidenceRoot: path.join(fx.root, "tmp/evidence") }),
    refused: "evidenceRoot must stay",
  },
])("broker settings refuse $name", async ({ change, refused }) => {
  const fx = brokerInstallation();
  await expect(fx.request(change(fx))).rejects.toThrow(refused);
  expect(fx.settings.status().job).toBeNull();
});

test("broker settings show the release commit and mint a bounded scope only when applied", async () => {
  const fx = brokerInstallation();
  const job = await fx.request();
  const fields = job.changes[0]?.fields ?? [];
  expect(fields[0]).toMatchObject({
    field: "release",
    after: expect.stringMatching(/^release dddddddddddd \(Host release/),
  });
  expect(fields.find((field) => field.field === "worker")).toMatchObject({
    after: `${fx.host.worker.path} · sha256 ${fx.host.worker.sha256.slice(0, 12)}`,
    verified: true,
  });
  // Before approval the recorded scope is untouched and the review copy is gone.
  expect(readFileSync(fx.recorded.scope.path, "utf8")).toBe("{}");
  expect(existsSync(path.join(fx.root, "state/participant-scope.review.json"))).toBe(false);
  // An interface that cannot show the fields may not approve them.
  expect(() => fx.settings.decide(job.id, job.revision, "approve")).toThrow("Update Vorteo");
  fx.settings.decide(job.id, job.revision, "approve", { reviewedFields: true });
  fx.state.clock.now += 60_000;
  await fx.settings.drain();
  expect(fx.calls).toEqual(["write running", "launch running"]);
  const scope = JSON.parse(readFileSync(fx.recorded.scope.path, "utf8"));
  expect(scope).toMatchObject({
    manualParticipants: [],
    bindings: fx.recorded.bindings,
    bootUUID: "11111111-2222-4333-8444-555555555555",
  });
  expect(Date.parse(scope.validUntil)).toBe(fx.state.clock.now + SCOPE_LIFETIME_MS);
  expect(JSON.parse(fx.state.disk.config).previewBrokerDeployment.scope.sha256).toBe(
    sha256(readFileSync(fx.recorded.scope.path, "utf8")),
  );
});

test.each([
  {
    name: "a file swapped after approval",
    after: (fx: BrokerFixture) => writeFileSync(fx.host.worker.path, "worker swapped"),
    detail: "digest changed",
  },
  {
    name: "a restart that starts after the scope was minted",
    after: (fx: BrokerFixture) => {
      let busy = false;
      const review = fx.settings["ports"].reviewBroker;
      fx.settings["ports"].reviewBroker = async (input) => {
        const result = await review(input);
        busy = input.phase === "dispatch";
        return result;
      };
      fx.settings["ports"].conflict = () =>
        busy ? "Wait for the coordinator update to finish." : null;
    },
    detail: "Wait for the coordinator update",
  },
])("broker settings fail at dispatch for $name", async ({ after, detail }) => {
  const fx = brokerInstallation();
  const job = await fx.request();
  fx.settings.decide(job.id, job.revision, "approve", { reviewedFields: true });
  after(fx);
  await fx.settings.drain();
  expect(fx.settings.status().job).toMatchObject({ status: "failed" });
  expect(fx.settings.status().job?.detail).toContain(detail);
  expect(fx.calls).toEqual([]);
  // Nothing applied, so the recorded scope keeps its exact bytes.
  expect(readFileSync(fx.recorded.scope.path, "utf8")).toBe("{}");
});

test("broker settings retry a review that could not run, and stop after a cancel during review", async () => {
  const fx = brokerInstallation();
  const job = await fx.request();
  fx.settings.decide(job.id, job.revision, "approve", { reviewedFields: true });
  let before = async (): Promise<void> => {
    throw new BrokerReviewUnavailable("Docker mount inspection failed: timed out");
  };
  const review = fx.settings["ports"].reviewBroker;
  fx.settings["ports"].reviewBroker = async (input) => {
    if (input.phase === "dispatch") await before();
    return review(input);
  };
  await fx.settings.drain();
  expect(fx.settings.status().job).toMatchObject({ status: "approved" });
  expect(fx.settings.status().job?.detail).toContain("Waiting to check");
  // The owner cancels while the next review runs; nothing is applied.
  before = async () => {
    fx.settings.decide(job.id, fx.settings.status().job!.revision, "cancel");
  };
  await fx.settings.drain();
  expect(fx.settings.status().job).toMatchObject({ status: "cancelled" });
  expect(fx.calls).toEqual([]);
  expect(readFileSync(fx.recorded.scope.path, "utf8")).toBe("{}");
  // An unchanged broker key is dropped, so the remaining plain change needs no field review.
  const plain = await fx.settings.request({
    patch: { previewBrokerDeployment: fx.recorded, claudeHostRefresh: true },
    baseSha256: sha256(fx.state.disk.config),
  });
  expect(plain.changes.map((change) => change.key)).toEqual(["claudeHostRefresh"]);
  expect(fx.settings.decide(plain.id, plain.revision, "approve").status).toBe("approved");
});

test("broker settings refuse a request when the configuration changed during review", async () => {
  const fx = brokerInstallation();
  const review = fx.settings["ports"].reviewBroker;
  fx.settings["ports"].reviewBroker = async (input) => {
    const result = await review(input);
    fx.state.disk.config = fx.state.disk.config.replace('"listenPort":6000', '"listenPort":6001');
    return result;
  };
  await expect(fx.request()).rejects.toThrow("changed since");
  expect(fx.settings.status().job).toBeNull();
});

test("broker connection pins come from one recorded section", () => {
  const engine = {
    docker: "/engine/docker",
    socket: "/engine/docker.sock",
    containers: {
      dev: "a".repeat(64),
      gatewayTailscale: "b".repeat(64),
      gatewayCaddy: "c".repeat(64),
    },
  };
  const config = (extra: Record<string, unknown>) => extra as unknown as InstallationConfig;
  // Without a broker section, the Dev engine section supplies all three, never a mix.
  expect(
    recordedConnection(
      config({
        containerSourceUpdates: { docker: "/other/docker", containerId: "d".repeat(64) },
        container: { engineRestart: engine },
      }),
    ),
  ).toEqual({
    docker: "/engine/docker",
    socket: "/engine/docker.sock",
    containerId: "a".repeat(64),
  });
  expect(() =>
    recordedConnection(
      config({ containerSourceUpdates: { docker: "/other/docker", containerId: "d".repeat(64) } }),
    ),
  ).toThrow("operator must set them");
});
