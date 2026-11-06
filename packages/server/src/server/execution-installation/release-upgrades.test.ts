import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { HandoffOutcome } from "./coordinator-handoff.js";
import {
  CoordinatorFollow,
  createCoordinatorFollowJournal,
  createUpgradeJournal,
  InstallationUpgrades,
  type CoordinatorFollowPorts,
  type AdoptionOutcome,
  type UpgradeJournal,
  type UpgradePorts,
} from "./release-upgrades.js";

const RELEASE_COMMIT = "b".repeat(40);
const INSTALLED_COMMIT = "a".repeat(40);

let directory: string;
let journal: UpgradeJournal;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "release-upgrades-"));
  journal = createUpgradeJournal(directory);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** Records every effect in order. Defaults describe a healthy upgrade. */
function fakePorts(changes: Partial<UpgradePorts> = {}) {
  const calls: string[] = [];
  let clock = Date.parse("2026-10-30T12:00:00Z");
  let hostJob: "running" | "succeeded" | "failed" = "running";
  let outcome: HandoffOutcome | null = null;
  let devImage = "sha256:old";
  let devRelease = "none";
  let adoption: AdoptionOutcome | null = null;
  const ports: UpgradePorts = {
    now: () => new Date(clock),
    conflict: () => null,
    adoptionRequired: false,
    launchAdoption: () => {
      calls.push("adopt");
    },
    adoptionOutcome: () => adoption,
    adoptionDeadlineMs: 60_000,
    hasContainer: true,
    coordinatorReplacement: null,
    currentCommit: () => INSTALLED_COMMIT,
    automaticAllowed: () => true,
    directHost: false,
    directHostBuild: false,
    launchHostBuild: () => {
      calls.push("host-build");
    },
    hostBuild: () => ({ status: "succeeded", detail: "Built" }),
    busy: async () => null,
    resolveRelease: async () => RELEASE_COMMIT,
    snapshot: async () => {
      calls.push("snapshot");
      return "20261030T120000000Z";
    },
    fetchRelease: async () => {
      calls.push("fetch");
    },
    requestHostUpdate: async () => {
      calls.push("host-request");
      return "00000000-0000-4000-8000-00000000000a";
    },
    hostUpdate: () => ({ status: hostJob, detail: `Host job ${hostJob}` }),
    hostRelease: () => "/releases/new",
    runningRelease: () => "/releases/old",
    coordinatorRelease: () => "/releases/old",
    launchCoordinatorSwap: (_upgrade, next, previous) => {
      calls.push(`swap ${previous} -> ${next}`);
    },
    coordinatorOutcome: () => outcome,
    coordinatorDeadlineMs: 60_000,
    prepareDev: async () => "image",
    devUpgradeMode: async () => "image",
    refreshDevScripts: async () => {
      calls.push("dev-refresh");
    },
    hasDevImage: async () => true,
    hostBuildDeadlineMs: 60_000,
    devRelease: async () => devRelease,
    buildDevRelease: async () => {
      calls.push("dev-release-build");
    },
    selectDevRelease: async (release) => {
      calls.push(`dev-select ${release}`);
      devRelease = release;
    },
    pruneDevReleases: async () => {
      calls.push("dev-prune");
    },
    devImage: async () => devImage,
    buildDevImage: async () => {
      calls.push("dev-build");
      return "sha256:new";
    },
    replaceDevImage: async (image) => {
      calls.push(`dev-replace ${image}`);
      devImage = image;
    },
    verifyDev: async () => {
      calls.push("dev-verify");
    },
    ...changes,
  };
  return {
    ports,
    calls,
    finishHost: (status: "succeeded" | "failed") => {
      hostJob = status;
    },
    reportCoordinator: (status: HandoffOutcome["status"]) => {
      outcome = {
        id: "00000000-0000-4000-8000-000000000000",
        status,
        detail: `Coordinator ${status}`,
        finishedAt: new Date(clock).toISOString(),
      };
    },
    advanceClock: (ms: number) => {
      clock += ms;
    },
    setDevImage: (image: string) => {
      devImage = image;
    },
    reportAdoption: (status: AdoptionOutcome["status"]) => {
      adoption = { status, detail: `Adoption ${status}` };
    },
  };
}

async function approved(upgrades: InstallationUpgrades) {
  const pending = await upgrades.request("release-26.10.3000");
  expect(pending).toMatchObject({ status: "pending", sourceCommit: RELEASE_COMMIT });
  return upgrades.decide(pending.id, pending.revision, "approve");
}

function statuses(upgrades: InstallationUpgrades) {
  const [upgrade] = upgrades.list();
  return { status: upgrade.status, steps: upgrade.steps.map((step) => step.status) };
}

test("keeps an installer-built Host job and requests it only once", async () => {
  // Installer-made Hosts return `installer-<upgrade id>`. The journal once refused that ID,
  // so every tick relaunched the Host build and the upgrade stayed running forever.
  const fake = fakePorts({
    requestHostUpdate: async (upgrade) => {
      fake.calls.push("host-request");
      return `installer-${upgrade.id}`;
    },
  });
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  await upgrades.drain();
  await upgrades.drain();
  expect(fake.calls.filter((call) => call === "host-request")).toHaveLength(1);
  fake.finishHost("failed");
  await upgrades.drain();
  expect(statuses(upgrades).status).toBe("failed");
});

test("runs every step in order and records each one", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  await upgrades.drain();
  expect(fake.calls).toEqual(["snapshot", "fetch", "host-request"]);
  expect(statuses(upgrades).steps).toEqual([
    "succeeded",
    "succeeded",
    "running",
    "pending",
    "pending",
  ]);
  fake.finishHost("succeeded");
  await upgrades.drain();
  expect(fake.calls.at(-1)).toBe("swap /releases/old -> /releases/new");
  fake.reportCoordinator("succeeded");
  await upgrades.drain();
  expect(fake.calls.slice(-3)).toEqual(["dev-build", "dev-replace sha256:new", "dev-verify"]);
  expect(statuses(upgrades)).toEqual({
    status: "succeeded",
    steps: ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"],
  });
  expect(upgrades.list()[0].snapshotId).toBe("20261030T120000000Z");
});

test("after current work, the Dev step waits for Dev agents until the owner installs now", async () => {
  let devBusy: string | null = "1 agent still working.";
  const fake = fakePorts({
    busy: async (target) => (target === "container-daemon" ? devBusy : null),
  });
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  const pending = await upgrades.request("release-26.10.3000");
  upgrades.decide(pending.id, pending.revision, "approve-after-work");
  fake.finishHost("succeeded");
  await upgrades.drain();
  fake.reportCoordinator("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  expect(fake.calls).not.toContain("dev-replace sha256:new");
  expect(upgrades.list()[0].steps[4]?.detail).toBe(
    "Waiting for current Dev work: 1 agent still working.",
  );
  // Waiting rewrites nothing, so the revision the owner decides on stays valid.
  const waiting = upgrades.list()[0];
  await upgrades.drain();
  expect(upgrades.list()[0].revision).toBe(waiting.revision);
  // Install now stops the wait without another approval.
  upgrades.decide(waiting.id, waiting.revision, "approve");
  devBusy = "still busy";
  await upgrades.drain();
  expect(fake.calls.slice(-2)).toEqual(["dev-replace sha256:new", "dev-verify"]);
  expect(statuses(upgrades).status).toBe("succeeded");
});

test("turning automatic updates off stops an automatic upgrade before the Host restart", async () => {
  const fake = fakePorts({ automaticAllowed: () => false });
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  const offer = await upgrades.request("release-26.10.3000", {
    origin: "update-check",
    notes: { summary: "", security: false, charterChanges: [], url: "https://github.com/x" },
  });
  upgrades.approveAutomatically(offer.id);
  await upgrades.drain();
  expect(fake.calls).not.toContain("host-request");
  expect(statuses(upgrades).status).toBe("failed");
});

test("a Dev the installer does not manage is skipped, never rebuilt", async () => {
  const fake = fakePorts({ devUnmanaged: true });
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  fake.reportCoordinator("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  expect(fake.calls.filter((call) => call.startsWith("dev-"))).toEqual([]);
  expect(upgrades.list()[0]).toMatchObject({ status: "succeeded" });
  expect(upgrades.list()[0].steps[4]).toMatchObject({ status: "skipped" });
});

test("a restarted coordinator resumes from the journal without repeating finished effects", async () => {
  const first = fakePorts();
  const upgrades = new InstallationUpgrades(journal, first.ports);
  await approved(upgrades);
  await upgrades.drain();
  first.finishHost("succeeded");
  await upgrades.drain();
  expect(first.calls.filter((call) => call.startsWith("swap"))).toHaveLength(1);

  // The helper restarted the coordinator onto the new release and reported success.
  const second = fakePorts({ runningRelease: () => "/releases/new" });
  second.finishHost("succeeded");
  second.reportCoordinator("succeeded");
  const resumed = new InstallationUpgrades(journal, second.ports);
  await resumed.drain();
  expect(second.calls).toEqual(["dev-build", "dev-replace sha256:new", "dev-verify"]);
  expect(statuses(resumed).status).toBe("succeeded");
});

test("a coordinator rollback fails the upgrade and leaves Dev untouched", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  fake.reportCoordinator("rolled-back");
  await upgrades.drain();
  expect(statuses(upgrades)).toEqual({
    status: "failed",
    steps: ["succeeded", "succeeded", "succeeded", "rolled-back", "skipped"],
  });
  expect(fake.calls).not.toContain("dev-build");
});

test("a silent coordinator helper is judged by the running release after its deadline", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  expect(statuses(upgrades).steps[3]).toBe("running");
  fake.advanceClock(61_000);
  await upgrades.drain();
  expect(statuses(upgrades)).toMatchObject({ status: "failed" });
  expect(upgrades.list()[0].steps[3].detail).toContain("did not report");
});

test("an unhealthy Dev image rolls back to the previous image", async () => {
  const fake = fakePorts();
  fake.ports.verifyDev = async () => {
    fake.calls.push("dev-verify");
    throw new Error("Dev did not answer");
  };
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  fake.reportCoordinator("succeeded");
  await upgrades.drain();
  expect(fake.calls.slice(-4)).toEqual([
    "dev-build",
    "dev-replace sha256:new",
    "dev-verify",
    "dev-replace sha256:old",
  ]);
  expect(statuses(upgrades)).toEqual({
    status: "failed",
    steps: ["succeeded", "succeeded", "succeeded", "succeeded", "rolled-back"],
  });
  expect(upgrades.list()[0].detail).toContain("previous image");
});

test("a Dev release swap keeps the image and rolls back to the previous release", async () => {
  const fake = fakePorts({ prepareDev: async () => "release" });
  let healthy = true;
  fake.ports.verifyDev = async () => {
    fake.calls.push("dev-verify");
    if (!healthy) throw new Error("Dev did not answer");
  };
  await fake.ports.selectDevRelease("a".repeat(40));
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  healthy = false;
  fake.reportCoordinator("succeeded");
  await upgrades.drain();
  expect(fake.calls.slice(-4)).toEqual([
    "dev-release-build",
    `dev-select ${RELEASE_COMMIT}`,
    "dev-verify",
    `dev-select ${"a".repeat(40)}`,
  ]);
  expect(fake.calls).not.toContain("dev-build");
  expect(statuses(upgrades).steps.at(-1)).toBe("rolled-back");
  expect(upgrades.list()[0].detail).toContain(`release ${"a".repeat(40)} again`);
  // Release-mode keys are dropped so an older coordinator can still read the journal.
  expect(journal.read()[0].private).not.toHaveProperty("devMode");
});

test.each([
  ["builds Host and Dev before the first restart", true],
  ["fails without restarting anything when Dev's build fails", false],
])("an upgrade %s", async (_name, devBuilds) => {
  const fake = fakePorts({
    directHost: true,
    directHostBuild: true,
    devUpgradeMode: async () => "release",
    hostUpdate: () => ({ status: "succeeded", detail: "Host restarted" }),
  });
  fake.ports.buildDevRelease = async () => {
    fake.calls.push("dev-release-build");
    if (!devBuilds) throw new Error("docker build failed");
  };
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  await upgrades.drain();
  await upgrades.drain();
  if (devBuilds) {
    expect(fake.calls).toEqual([
      "snapshot",
      "fetch",
      "host-build",
      "dev-release-build",
      "host-request",
    ]);
  } else {
    expect(fake.calls).not.toContain("host-request");
    expect(statuses(upgrades).status).toBe("failed");
    expect(upgrades.list()[0].detail).toMatch(/Nothing was restarted/);
    expect(journal.read()[0].private).not.toHaveProperty("devMode");
  }
});

test("a coordinator that restarted while Dev was recreated verifies before replacing again", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  fake.reportCoordinator("succeeded");
  // Crash inside replaceDevImage after Dev already runs the new image.
  fake.ports.replaceDevImage = async (image) => {
    fake.setDevImage(image);
    throw new Error("coordinator stopped");
  };
  fake.ports.devImage = async () => "sha256:old";
  await upgrades.drain().catch(() => undefined);
  const record = journal.read()[0];
  expect(record.private.devImage).toBe("sha256:new");

  const second = fakePorts({ runningRelease: () => "/releases/new" });
  second.setDevImage("sha256:new");
  // Rebuild the journal state as it was persisted just before the crash.
  journal.write([
    {
      ...record,
      status: "running",
      steps: record.steps.map((step, index) =>
        index === 4 ? { ...step, status: "running", detail: "" } : step,
      ),
      private: { ...record.private, devReplacing: true },
    },
  ]);
  const resumed = new InstallationUpgrades(journal, second.ports);
  await resumed.drain();
  expect(second.calls).toEqual(["dev-verify"]);
  expect(statuses(resumed).status).toBe("succeeded");
});

test("a Host-only installation skips the Dev step", async () => {
  const fake = fakePorts({ hasContainer: false });
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  fake.reportCoordinator("succeeded");
  await upgrades.drain();
  expect(statuses(upgrades)).toEqual({
    status: "succeeded",
    steps: ["succeeded", "succeeded", "succeeded", "succeeded", "skipped"],
  });
});

test("a failed Host build stops before the coordinator and Dev", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  await upgrades.drain();
  fake.finishHost("failed");
  await upgrades.drain();
  expect(statuses(upgrades)).toEqual({
    status: "failed",
    steps: ["succeeded", "succeeded", "failed", "skipped", "skipped"],
  });
  expect(fake.calls).toEqual(["snapshot", "fetch", "host-request"]);
});

test("approval names the reviewed revision and only one upgrade is active", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  const pending = await upgrades.request("release-26.10.3000");
  await expect(upgrades.request("release-26.10.3001")).rejects.toThrow("already pending");
  expect(() =>
    upgrades.decide(pending.id, "00000000-0000-4000-8000-0000000000ff", "approve"),
  ).toThrow("changed");
  await upgrades.drain();
  expect(fake.calls).toEqual([]);
  const rejected = upgrades.decide(pending.id, pending.revision, "reject");
  expect(rejected.status).toBe("rejected");
  const current = fakePorts({ currentCommit: () => RELEASE_COMMIT });
  await expect(
    new InstallationUpgrades(journal, current.ports).request("release-26.10.3000"),
  ).rejects.toThrow("already runs");
  expect(JSON.stringify(upgrades.list())).not.toContain("private");
});

test("an installation from before the installer adopts its layout before the snapshot", async () => {
  const legacy = fakePorts({ adoptionRequired: true });
  const upgrades = new InstallationUpgrades(journal, legacy.ports);
  await approved(upgrades);
  await upgrades.drain();
  await upgrades.drain();
  // Launched once, then waiting: the engine restarts this coordinator when it is done.
  expect(legacy.calls).toEqual(["adopt"]);
  expect(statuses(upgrades).steps[0]).toBe("running");
  expect(upgrades.list()[0].steps[0].detail).toContain("installer layout");

  // The restarted coordinator has the deployment block and finds the engine's outcome.
  const adopted = fakePorts();
  const resumed = new InstallationUpgrades(journal, adopted.ports);
  await resumed.drain();
  expect(adopted.calls).toEqual([]);
  adopted.reportAdoption("succeeded");
  await resumed.drain();
  expect(adopted.calls).toEqual(["snapshot", "fetch", "host-request"]);
});

test("a failed adoption fails the upgrade before any snapshot or Host change", async () => {
  const legacy = fakePorts({ adoptionRequired: true });
  const upgrades = new InstallationUpgrades(journal, legacy.ports);
  await approved(upgrades);
  await upgrades.drain();
  legacy.reportAdoption("failed");
  await upgrades.drain();
  expect(statuses(upgrades)).toEqual({
    status: "failed",
    steps: ["failed", "skipped", "skipped", "skipped", "skipped"],
  });
  expect(upgrades.list()[0].detail).toContain("Adoption failed");
  expect(legacy.calls).toEqual(["adopt"]);
});

test("an adoption that never reports fails after its deadline", async () => {
  const legacy = fakePorts({ adoptionRequired: true });
  const upgrades = new InstallationUpgrades(journal, legacy.ports);
  await approved(upgrades);
  await upgrades.drain();
  legacy.advanceClock(60_001);
  await upgrades.drain();
  expect(statuses(upgrades).status).toBe("failed");
  expect(upgrades.list()[0].detail).toContain("did not report");
});

/** A coordinator whose link and process are on /releases/old while the Host runs /releases/new. */
function followPorts(changes: Partial<CoordinatorFollowPorts> = {}) {
  const calls: string[] = [];
  let clock = Date.parse("2026-11-05T12:00:00Z");
  let outcome: HandoffOutcome | null = null;
  const ports: CoordinatorFollowPorts = {
    now: () => new Date(clock),
    replacement: null,
    conflict: () => null,
    hostRelease: () => "/releases/new",
    runningRelease: () => "/releases/old",
    coordinatorRelease: () => "/releases/old",
    coordinatorDeadlineMs: 60_000,
    hasCoordinator: () => true,
    launchSwap: (job, next, previous) => {
      // The helper restarts this process, so the launch must already be in the journal.
      const recorded = createCoordinatorFollowJournal(directory).read();
      calls.push(`swap ${previous} -> ${next} ${recorded.at(-1)?.status}`);
    },
    swapOutcome: () => outcome,
    ...changes,
  };
  return {
    ports,
    calls,
    report: (status: HandoffOutcome["status"]) => {
      outcome = {
        id: "00000000-0000-4000-8000-000000000000",
        status,
        detail: `Coordinator ${status}`,
        finishedAt: new Date(clock).toISOString(),
      };
    },
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}

function approvedFollow(follow: CoordinatorFollow) {
  const pending = follow.request("/releases/new");
  return follow.decide(pending.id, pending.revision, "approve");
}

test.each([
  {
    name: "is unavailable when the coordinator already runs the Host release",
    run: () => {
      const fake = followPorts({
        coordinatorRelease: () => "/releases/new",
        runningRelease: () => "/releases/new",
      });
      const follow = new CoordinatorFollow(createCoordinatorFollowJournal(directory), fake.ports);
      expect(follow.status()).toMatchObject({ available: false, job: null });
      expect(() => follow.request("/releases/new")).toThrow("already runs");
    },
  },
  {
    name: "launches the swap once, after recording it",
    run: () => {
      const fake = followPorts();
      const follow = new CoordinatorFollow(createCoordinatorFollowJournal(directory), fake.ports);
      approvedFollow(follow);
      follow.drain();
      follow.drain();
      expect(fake.calls).toEqual(["swap /releases/old -> /releases/new running"]);
    },
  },
  {
    name: "a restarted coordinator resumes and reads the helper's outcome",
    run: () => {
      const first = followPorts();
      approvedFollow(new CoordinatorFollow(createCoordinatorFollowJournal(directory), first.ports));
      new CoordinatorFollow(createCoordinatorFollowJournal(directory), first.ports).drain();
      const second = followPorts({ runningRelease: () => "/releases/new" });
      const resumed = new CoordinatorFollow(
        createCoordinatorFollowJournal(directory),
        second.ports,
      );
      resumed.drain();
      expect(resumed.status().job?.status).toBe("running");
      second.report("rolled-back");
      resumed.drain();
      expect(resumed.status().job?.status).toBe("rolled-back");
      expect(second.calls).toEqual([]);
    },
  },
  {
    name: "a reported success fails while the coordinator still runs its previous release",
    run: () => {
      // A service pinned to a release restarts on it however the link moves.
      const fake = followPorts();
      const follow = new CoordinatorFollow(createCoordinatorFollowJournal(directory), fake.ports);
      approvedFollow(follow);
      follow.drain();
      fake.report("succeeded");
      follow.drain();
      expect(follow.status().job).toMatchObject({ status: "failed" });
      expect(follow.status().job?.detail).toContain("release link");
    },
  },
  {
    name: "a helper that never reports is judged by the running release after the deadline",
    run: () => {
      const fake = followPorts();
      const follow = new CoordinatorFollow(createCoordinatorFollowJournal(directory), fake.ports);
      approvedFollow(follow);
      follow.drain();
      fake.advanceClock(60_001);
      follow.drain();
      expect(follow.status().job).toMatchObject({ status: "failed" });
    },
  },
  {
    name: "refuses approval when the Host release changed after review",
    run: () => {
      let host = "/releases/new";
      const fake = followPorts({ hostRelease: () => host });
      const follow = new CoordinatorFollow(createCoordinatorFollowJournal(directory), fake.ports);
      const pending = follow.request("/releases/new");
      host = "/releases/newer";
      expect(() => follow.decide(pending.id, pending.revision, "approve")).toThrow("changed");
      follow.drain();
      expect(fake.calls).toEqual([]);
      expect(follow.status().job?.status).toBe("cancelled");
    },
  },
])("coordinator follow $name", ({ run }) => run());
