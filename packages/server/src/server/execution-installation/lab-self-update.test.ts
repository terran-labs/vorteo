import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { HandoffOutcome } from "./coordinator-handoff.js";
import {
  changeInstallationType,
  installationTypeFile,
  readInstallationType,
  reportedInstallationType,
  UNREADABLE_INSTALLATION_TYPE_REVISION,
} from "./installation-type.js";
import {
  createLabUpdateJournal,
  LabSelfUpdates,
  type LabHostRestartState,
  type LabUpdatePorts,
} from "./lab-self-update.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "lab-self-update-"));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("installation type defaults to Stable and an unreadable record only repairs to Stable", async () => {
  expect(await readInstallationType(directory)).toMatchObject({ type: "stable", revision: "none" });
  const lab = await changeInstallationType(directory, { expectedRevision: "none", type: "lab" });
  expect(lab.type).toBe("lab");
  await expect(
    changeInstallationType(directory, { expectedRevision: "none", type: "stable" }),
  ).rejects.toThrow(/changed elsewhere/);

  writeFileSync(installationTypeFile(directory), "{not json");
  // Never read as Lab, which would auto-approve self-updates.
  expect(await reportedInstallationType(directory)).toMatchObject({
    type: "stable",
    unreadable: true,
  });
  const unreadable = { expectedRevision: UNREADABLE_INSTALLATION_TYPE_REVISION };
  await expect(changeInstallationType(directory, { ...unreadable, type: "lab" })).rejects.toThrow(
    /unreadable/,
  );
  expect((await changeInstallationType(directory, { ...unreadable, type: "stable" })).type).toBe(
    "stable",
  );
});

/** Records every effect in order. Defaults describe a healthy Lab installation. */
function fakePorts(changes: Partial<LabUpdatePorts> = {}) {
  const calls: string[] = [];
  const state = {
    blocker: null as string | null,
    host: "/releases/old",
    coordinator: "/releases/old",
    restarts: [] as Array<{ id: string; state: LabHostRestartState }>,
    outcome: null as HandoffOutcome | null,
    finishBuild: null as null | ((release: string) => void),
    failBuild: null as null | ((error: Error) => void),
  };
  const ports: LabUpdatePorts = {
    now: () => new Date("2026-11-05T12:00:00Z"),
    blocker: async () => state.blocker,
    conflict: () => null,
    inspectSource: async () => ({
      checkout: "/live/source",
      branch: "live/main",
      head: "c".repeat(40),
      dirty: [{ file: "packages/server/src/a.ts", claimedBy: "Other thread" }],
    }),
    build: (_update, signal) =>
      new Promise((resolve, reject) => {
        calls.push("build");
        state.finishBuild = resolve;
        state.failBuild = reject;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    hostRelease: async () => state.host,
    coordinatorRelease: async () => state.coordinator,
    runningRelease: async () => state.coordinator,
    pointHostLink: async (release) => {
      calls.push(`host-link ${release}`);
      state.host = release;
    },
    requestHostRestart: () => {
      const id = `00000000-0000-4000-8000-00000000000${state.restarts.length}`;
      state.restarts.push({ id, state: { status: "running", detail: "Waiting" } });
      calls.push("host-restart");
      return id;
    },
    hostRestart: (id) => state.restarts.find((item) => item.id === id)!.state,
    cancelHostRestart: () => true,
    launchCoordinatorSwap: (_update, next, previous) => {
      calls.push(`swap ${previous} -> ${next}`);
    },
    coordinatorOutcome: () => state.outcome,
    coordinatorDeadlineMs: 60_000,
    prune: async () => {
      calls.push("prune");
    },
    ...changes,
  };
  return { ports, calls, state };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Stable refuses; Lab approves, builds, restarts Host, then swaps the coordinator", async () => {
  const { ports, calls, state } = fakePorts();
  const updates = new LabSelfUpdates(createLabUpdateJournal(directory), ports);
  state.blocker = "Lab self-updates run only when the installation type is Lab.";
  await expect(updates.request({}, "host-agent")).rejects.toThrow(
    /only when the installation type is Lab/,
  );
  state.blocker = null;

  const requested = await updates.request({ requester: "Lab thread" }, "host-agent");
  expect(requested).toMatchObject({
    status: "approved",
    approval: { policy: "lab-installation-type", installationType: "lab" },
  });
  await updates.drain();
  expect((await updates.active())?.source?.dirty).toEqual([
    { file: "packages/server/src/a.ts", claimedBy: "Other thread" },
  ]);
  state.finishBuild!("/releases/lab-new");
  await settle();
  await updates.drain();
  expect(state.host).toBe("/releases/lab-new");
  state.restarts[0].state = { status: "succeeded", detail: "Restarted" };
  await updates.drain();
  expect(calls).toContain("swap /releases/old -> /releases/lab-new");
  state.outcome = {
    id: requested.id,
    status: "succeeded",
    detail: "The coordinator now runs /releases/lab-new.",
    finishedAt: "2026-11-05T12:01:00.000Z",
  };
  await updates.drain();
  const finished = (await updates.get(requested.id))!;
  expect(finished.status).toBe("succeeded");
  expect(finished.previous).toEqual({ host: "/releases/old", coordinator: "/releases/old" });
  expect(calls).toContain("prune");
});

test("a failed Host restart reselects the previous release and never swaps the coordinator", async () => {
  const { ports, calls, state } = fakePorts();
  const updates = new LabSelfUpdates(createLabUpdateJournal(directory), ports);
  const requested = await updates.request({}, "owner");
  await updates.drain();
  state.finishBuild!("/releases/lab-new");
  await settle();
  await updates.drain();
  state.restarts[0].state = { status: "failed", detail: "Host did not become ready" };
  await updates.drain();
  expect(state.host).toBe("/releases/old");
  expect(state.restarts).toHaveLength(2);
  const failed = (await updates.get(requested.id))!;
  expect(failed.status).toBe("failed");
  expect(failed.steps.map((step) => step.status)).toEqual(["succeeded", "rolled-back", "skipped"]);
  expect(calls.some((call) => call.startsWith("swap"))).toBe(false);
});

test("cancelling during the build stops it and leaves both releases selected", async () => {
  const { ports, calls, state } = fakePorts();
  const updates = new LabSelfUpdates(createLabUpdateJournal(directory), ports);
  const requested = await updates.request({}, "owner");
  await updates.drain();
  const running = (await updates.get(requested.id))!;
  expect((await updates.cancel(requested.id, running.revision)).status).toBe("cancelled");
  await settle();
  await updates.drain();
  expect(state.host).toBe("/releases/old");
  expect(calls).toEqual(["build"]);
  expect(await updates.active()).toBeNull();
});
