import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { CoordinatorFollowJob } from "@getpaseo/protocol/installation-upgrades";
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
function started(state: ReturnType<typeof installation>, settings: CoordinatorSettings) {
  const job = requestRefresh(state, settings);
  settings.decide(job.id, job.revision, "approve");
  settings.drain();
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
    run: () => {
      const state = installation();
      const { settings } = settingsPorts(state);
      expect(() =>
        settings.request({
          patch: { ownerPasswordHash: "$2b$x" },
          baseSha256: sha256(state.disk.config),
        }),
      ).toThrow("not a coordinator setting");
    },
  },
  {
    name: "refuses an invalid value",
    run: () => {
      const state = installation();
      const { settings } = settingsPorts(state);
      expect(() =>
        settings.request({
          patch: { claudeHostRefresh: "yes" },
          baseSha256: sha256(state.disk.config),
        }),
      ).toThrow("invalid value");
    },
  },
  {
    name: "refuses a stale base hash at request and at dispatch",
    run: () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      expect(() =>
        settings.request({ patch: { claudeHostRefresh: true }, baseSha256: "0".repeat(64) }),
      ).toThrow("changed since");
      const job = requestRefresh(state, settings);
      settings.decide(job.id, job.revision, "approve");
      state.disk.config = `${JSON.stringify({ listenPort: 6001 })}\n`;
      settings.drain();
      expect(settings.status().job).toMatchObject({ status: "failed" });
      expect(calls).toEqual([]);
    },
  },
  {
    name: "journals before the write and launch, and launches once",
    run: () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      const job = requestRefresh(state, settings);
      expect(job.changes).toEqual([
        { key: "claudeHostRefresh", displaySafe: true, before: "false", after: "true" },
      ]);
      settings.decide(job.id, job.revision, "approve");
      settings.drain();
      settings.drain();
      expect(calls).toEqual(["write running", "launch running"]);
      expect(JSON.parse(state.disk.config)).toMatchObject({ claudeHostRefresh: true });
    },
  },
  {
    name: "a restarted coordinator resumes from the handoff outcome and records a rollback",
    run: () => {
      const state = installation();
      const first = settingsPorts(state);
      const job = requestRefresh(state, first.settings);
      first.settings.decide(job.id, job.revision, "approve");
      first.settings.drain();
      const second = settingsPorts(state);
      second.settings.drain();
      expect(second.settings.status().job?.status).toBe("running");
      second.report("rolled-back");
      second.settings.drain();
      expect(second.settings.status().job?.status).toBe("rolled-back");
      expect(second.calls).toEqual([]);
    },
  },
  {
    name: "a combined approval applies only after the coordinator update succeeds",
    run: () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      const job = requestRefresh(state, settings);
      state.follow.job = followJob("pending");
      const linked = settings.approveWithFollow(job.id, job.revision, () => {
        state.follow.job = followJob("approved");
        return state.follow.job;
      });
      expect(linked).toMatchObject({ status: "pending", approvedWith: state.follow.job.id });
      settings.drain();
      expect(calls).toEqual([]);
      state.follow.job = followJob("succeeded");
      settings.drain();
      expect(calls).toEqual(["write running", "launch running"]);
      expect(settings.status().job?.approvedWith).toBe(state.follow.job.id);
    },
  },
  {
    name: "a combined approval leaves the settings pending when the update rolls back",
    run: () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      const job = requestRefresh(state, settings);
      settings.approveWithFollow(job.id, job.revision, () => {
        state.follow.job = followJob("running");
        return state.follow.job;
      });
      state.follow.job = followJob("rolled-back");
      settings.drain();
      expect(settings.status().job).toMatchObject({ status: "pending" });
      expect(settings.status().job?.approvedWith).toBeUndefined();
      expect(calls).toEqual([]);
    },
  },
  {
    name: "refuses preview broker keys, which name what the coordinator executes",
    run: () => {
      const state = installation();
      const { settings } = settingsPorts(state);
      expect(() =>
        settings.request({
          patch: { previewBroker: { python: "/tmp/agent-python" } },
          baseSha256: sha256(state.disk.config),
        }),
      ).toThrow("not a coordinator setting");
    },
  },
  {
    name: "refuses a decision on a revision the owner did not review",
    run: () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      const job = requestRefresh(state, settings);
      expect(() =>
        settings.decide(job.id, "33333333-3333-4333-8333-333333333333", "approve"),
      ).toThrow("Review it again");
      settings.drain();
      expect(settings.status().job?.status).toBe("pending");
      expect(calls).toEqual([]);
    },
  },
  {
    name: "refuses a request while a custom domain change restarts the coordinator",
    run: () => {
      const state = installation();
      const { settings } = settingsPorts(state, {
        conflict: restartCheck({ customDomainRunning: true }),
      });
      expect(() => requestRefresh(state, settings)).toThrow("custom domain");
    },
  },
  {
    name: "refuses approval while a Host job is approved",
    run: () => {
      const state = installation();
      let busy = false;
      const conflict = restartCheck({ hostJobBusy: true });
      const { settings, calls } = settingsPorts(state, {
        conflict: () => (busy ? conflict() : null),
      });
      const job = requestRefresh(state, settings);
      busy = true;
      expect(() => settings.decide(job.id, job.revision, "approve")).toThrow("Host restart");
      expect(settings.status().job?.status).toBe("pending");
      expect(calls).toEqual([]);
    },
  },
  {
    name: "fails at dispatch when another restart started after approval",
    run: () => {
      const state = installation();
      let busy = false;
      const conflict = restartCheck({ followDispatching: true });
      const { settings, calls } = settingsPorts(state, {
        conflict: () => (busy ? conflict() : null),
      });
      const job = requestRefresh(state, settings);
      settings.decide(job.id, job.revision, "approve");
      busy = true;
      settings.drain();
      expect(settings.status().job).toMatchObject({
        status: "failed",
        detail: "Wait for the coordinator update to finish.",
      });
      expect(calls).toEqual([]);
    },
  },
  {
    name: "restores the previous configuration when the handoff fails to spawn",
    run: () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state, {
        launch: (_id, onError) => onError(new Error("spawn ENOENT")),
      });
      started(state, settings);
      expect(calls).toEqual(["write running", "restore"]);
      expect(settings.status().job).toMatchObject({ status: "failed" });
      expect(settings.status().job?.detail).toContain("spawn ENOENT");
    },
  },
  {
    name: "a handoff that never reports succeeds when the new configuration runs",
    run: () => {
      const state = installation();
      started(state, settingsPorts(state).settings);
      // The restarted coordinator parsed the new file at startup.
      const restarted = settingsPorts(state, { runningSha256: sha256(state.disk.config) });
      state.clock.now += 60_001;
      restarted.settings.drain();
      expect(restarted.settings.status().job?.status).toBe("succeeded");
      expect(restarted.calls).toEqual([]);
    },
  },
  {
    name: "a handoff that never reports fails and restores the file under the old coordinator",
    run: () => {
      const state = installation();
      const { settings, calls } = settingsPorts(state);
      started(state, settings);
      state.clock.now += 60_001;
      settings.drain();
      expect(settings.status().job?.status).toBe("failed");
      expect(calls).toEqual(["write running", "launch running", "restore"]);
    },
  },
  {
    name: "an unreadable handoff outcome fails the job instead of throwing on every drain",
    run: () => {
      const state = installation();
      const { settings } = settingsPorts(state, {
        outcome: () => {
          throw new Error("Unexpected token in JSON");
        },
      });
      started(state, settings);
      expect(() => settings.drain()).not.toThrow();
      expect(settings.status().job).toMatchObject({ status: "failed" });
      expect(settings.status().job?.detail).toContain("could not be followed");
    },
  },
  {
    name: "an unreadable journal is moved aside and changes stay unavailable",
    run: () => {
      const state = installation();
      writeFileSync(path.join(directory, "journal.json"), '{"version":2,"jobs":[]}');
      const { settings, calls } = settingsPorts(state);
      expect(settings.status().available).toBe(false);
      expect(() => requestRefresh(state, settings)).toThrow("journal could not be read");
      expect(existsSync(path.join(directory, "journal.json"))).toBe(false);
      expect(
        readdirSync(directory).some((name) => name.startsWith("journal.json.unreadable-")),
      ).toBe(true);
      expect(calls[0]).toContain("warn");
    },
  },
])("coordinator settings $name", ({ run }) => run());
