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
  SourceUpgrades,
  type CoordinatorFollowPorts,
  type SourceFacts,
  type SourceUpgradePorts,
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

const SOURCE_COMMIT = "c".repeat(40);
const PASSING: SourceFacts = {
  onMain: true,
  containsInstalled: true,
  checks: { passed: true, detail: "changes, format, lint, typecheck, scan passed." },
  lastRelease: "release-26.10.3000",
};

/** Release ports plus source admission. Defaults admit SOURCE_COMMIT. */
function fakeSourcePorts(
  facts: Partial<SourceFacts> = {},
  changes: Partial<SourceUpgradePorts> = {},
) {
  const fake = fakePorts();
  const fetched: string[] = [];
  const ports: SourceUpgradePorts = {
    ...fake.ports,
    fetchRelease: async (upgrade) => {
      fake.calls.push("fetch");
      fetched.push(upgrade.sourceCommit);
    },
    inspectSource: async () => ({ ...PASSING, ...facts }),
    lastRelease: async () => "release-26.10.3000",
    rollbackBlocker: () => null,
    installationBlocker: async () => null,
    ...changes,
  };
  return { ...fake, ports, fetched };
}

const SOURCE_REQUEST = { commit: SOURCE_COMMIT, reason: "Hotfix", requestedBy: "Owner" };

test.each([
  { name: "a commit not on main", facts: { onMain: false }, refusal: "not on main" },
  { name: "a downgrade", facts: { containsInstalled: false }, refusal: "downgrade" },
  {
    name: "failed required checks",
    facts: { checks: { passed: false, detail: "failed: lint (failure)." } },
    refusal: "lint (failure)",
  },
  {
    name: "unverifiable required checks",
    facts: { checks: { passed: false, detail: "they could not be verified (HTTP 500)." } },
    refusal: "could not be verified",
  },
  {
    name: "a release upgrade already running",
    conflict: "Wait for the release upgrade to finish.",
    refusal: "release upgrade",
  },
  { name: "the installed commit itself", installed: SOURCE_COMMIT, refusal: "already runs" },
  { name: "an unknown installed commit", installed: null, refusal: "unknown" },
] as Array<{
  name: string;
  facts?: Partial<SourceFacts>;
  conflict?: string;
  installed?: string | null;
  refusal: string;
}>)("source upgrade admission refuses $name", async ({ facts, conflict, installed, refusal }) => {
  const fake = fakeSourcePorts(facts, {
    conflict: () => conflict ?? null,
    ...(installed !== undefined ? { currentCommit: () => installed } : {}),
  });
  const sources = new SourceUpgrades(journal, fake.ports);
  await expect(sources.request(SOURCE_REQUEST)).rejects.toThrow(refusal);
  expect(sources.list()).toEqual([]);
});

test("a second source upgrade is refused while one is pending", async () => {
  const sources = new SourceUpgrades(journal, fakeSourcePorts().ports);
  await sources.request(SOURCE_REQUEST);
  await expect(sources.request(SOURCE_REQUEST)).rejects.toThrow("already pending");
});

test("approval binds the reviewed commit and the installed commit it was reviewed against", async () => {
  let installed = INSTALLED_COMMIT;
  const fake = fakeSourcePorts({}, { currentCommit: () => installed });
  const sources = new SourceUpgrades(journal, fake.ports);
  const pending = await sources.request(SOURCE_REQUEST);
  expect(pending).toMatchObject({
    kind: "source-upgrade",
    status: "pending",
    sourceCommit: SOURCE_COMMIT,
    previousCommit: INSTALLED_COMMIT,
    lastRelease: "release-26.10.3000",
  });
  await expect(
    sources.decide(pending.id, "00000000-0000-4000-8000-0000000000ff", "approve"),
  ).rejects.toThrow("changed");
  installed = "d".repeat(40);
  await expect(sources.decide(pending.id, pending.revision, "approve")).rejects.toThrow(
    "Request it again",
  );
  expect(sources.list()[0]).toMatchObject({ status: "cancelled" });
  await sources.drain();
  expect(fake.calls).toEqual([]);
});

test("approval repeats admission and leaves the request pending when checks no longer pass", async () => {
  let facts: Partial<SourceFacts> = {};
  const fake = fakeSourcePorts({}, { inspectSource: async () => ({ ...PASSING, ...facts }) });
  const sources = new SourceUpgrades(journal, fake.ports);
  const pending = await sources.request(SOURCE_REQUEST);
  facts = { checks: { passed: false, detail: "missing or still running: scan." } };
  await expect(sources.decide(pending.id, pending.revision, "approve")).rejects.toThrow("scan");
  expect(sources.list()[0].status).toBe("pending");
  facts = {};
  await expect(sources.decide(pending.id, pending.revision, "approve")).resolves.toMatchObject({
    status: "approved",
  });
});

test("a Host change after approval fails the source upgrade before anything restarts", async () => {
  let installed = INSTALLED_COMMIT;
  const fake = fakeSourcePorts({}, { currentCommit: () => installed });
  const sources = new SourceUpgrades(journal, fake.ports);
  const pending = await sources.request(SOURCE_REQUEST);
  await sources.decide(pending.id, pending.revision, "approve-after-work");
  // A Host source update landed while the approved upgrade waited.
  installed = "d".repeat(40);
  await sources.drain();
  expect(fake.calls).toEqual(["snapshot", "fetch"]);
  expect(sources.list()[0]).toMatchObject({ status: "failed" });
  expect(sources.list()[0].detail).toContain("Host changed after");
});

test("an approved source upgrade resumes from its journal and fetches the reviewed commit", async () => {
  const first = fakeSourcePorts();
  const sources = new SourceUpgrades(journal, first.ports);
  const pending = await sources.request(SOURCE_REQUEST);
  await sources.decide(pending.id, pending.revision, "approve");
  await sources.drain();
  expect(first.calls).toEqual(["snapshot", "fetch", "host-request"]);
  expect(first.fetched).toEqual([SOURCE_COMMIT]);

  // The coordinator restarted while the Host job ran; the next one resumes without repeating.
  const second = fakeSourcePorts({}, { currentCommit: () => SOURCE_COMMIT });
  second.finishHost("succeeded");
  const resumed = new SourceUpgrades(journal, second.ports);
  await resumed.drain();
  second.reportCoordinator("succeeded");
  await resumed.drain();
  expect(second.calls).toEqual([
    "swap /releases/old -> /releases/new",
    "dev-build",
    "dev-replace sha256:new",
    "dev-verify",
  ]);
  expect(resumed.list()[0]).toMatchObject({ status: "succeeded" });
  expect(resumed.list()[0].detail).toContain(SOURCE_COMMIT.slice(0, 12));
  // A release journal in another folder never sees the source record.
  expect(JSON.stringify(resumed.list())).not.toContain("private");
});

test("an installation switched to Lab mid-upgrade stops before the next step restarts anything", async () => {
  let lab: string | null = null;
  const fake = fakeSourcePorts({}, { installationBlocker: async () => lab });
  const sources = new SourceUpgrades(journal, fake.ports);
  const pending = await sources.request(SOURCE_REQUEST);
  await sources.decide(pending.id, pending.revision, "approve");
  await sources.drain();
  expect(fake.calls).toEqual(["snapshot", "fetch", "host-request"]);
  // The Host restart already requested finishes; the owner switches the type meanwhile.
  lab = "The installation became Lab, so the source upgrade stopped.";
  fake.finishHost("succeeded");
  await sources.drain();
  expect(fake.calls).toEqual(["snapshot", "fetch", "host-request"]);
  expect(sources.list()[0]).toMatchObject({ status: "failed" });
  expect(sources.list()[0].steps.map((step) => step.status)).toEqual([
    "succeeded",
    "succeeded",
    "succeeded",
    "failed",
    "skipped",
  ]);
  expect(sources.list()[0].detail).toContain("became Lab");
});

test.each([
  { name: "restarts the Host only after the Host and Dev builds", changed: false },
  { name: "fails without a restart when the Host changed during the Dev build", changed: true },
])("a source upgrade on an installer-built Host $name", async ({ changed }) => {
  let installed = INSTALLED_COMMIT;
  const fake = fakeSourcePorts(
    {},
    {
      directHost: true,
      directHostBuild: true,
      currentCommit: () => installed,
      buildDevImage: async () => {
        fake.calls.push("dev-build");
        if (changed) installed = "d".repeat(40);
        return "sha256:new";
      },
    },
  );
  const sources = new SourceUpgrades(journal, fake.ports);
  const pending = await sources.request(SOURCE_REQUEST);
  await sources.decide(pending.id, pending.revision, "approve");
  await sources.drain();
  await sources.drain();
  if (changed) {
    expect(fake.calls).toEqual(["snapshot", "fetch", "host-build", "dev-build"]);
    expect(sources.list()[0]).toMatchObject({ status: "failed" });
    expect(sources.list()[0].detail).toContain("Host changed after");
  } else {
    expect(fake.calls).toEqual(["snapshot", "fetch", "host-build", "dev-build", "host-request"]);
    expect(sources.list()[0].status).toBe("running");
  }
});

/** A source upgrade whose Host step moved the Host, then whose coordinator rolled back. */
async function movedHost() {
  let installed = INSTALLED_COMMIT;
  const fake = fakeSourcePorts({}, { currentCommit: () => installed });
  const sources = new SourceUpgrades(journal, fake.ports);
  const pending = await sources.request(SOURCE_REQUEST);
  await sources.decide(pending.id, pending.revision, "approve");
  await sources.drain();
  fake.finishHost("succeeded");
  installed = SOURCE_COMMIT;
  await sources.drain();
  fake.reportCoordinator("rolled-back");
  await sources.drain();
  return { fake, sources, upgrade: sources.list()[0] };
}

test("the owner can roll the Host back for 24 hours, even after a later step failed", async () => {
  const { fake, sources, upgrade } = await movedHost();
  expect(upgrade.status).toBe("failed");
  expect(sources.rollbackOffer()).toMatchObject({
    available: true,
    upgradeId: upgrade.id,
    commit: INSTALLED_COMMIT,
  });
  const rollback = await sources.requestRollback(upgrade.id, "Owner");
  expect(rollback).toMatchObject({
    status: "pending",
    rollbackOf: upgrade.id,
    sourceCommit: INSTALLED_COMMIT,
    previousCommit: SOURCE_COMMIT,
    rollbackUntil: sources.rollbackOffer().until,
  });
  // The window ends before the owner answers: approval refuses and cancels the rollback.
  fake.advanceClock(24 * 60 * 60_000);
  await expect(sources.decide(rollback.id, rollback.revision, "approve")).rejects.toThrow(
    "24-hour",
  );
  expect(sources.list()[0].status).toBe("cancelled");
  expect(sources.rollbackOffer()).toMatchObject({ available: false });
  await expect(sources.requestRollback(upgrade.id, "Owner")).rejects.toThrow("24-hour");
});

test("an approved rollback whose window ends before it runs fails at the fetch step", async () => {
  const { fake, sources, upgrade } = await movedHost();
  const rollback = await sources.requestRollback(upgrade.id, "Owner");
  await sources.decide(rollback.id, rollback.revision, "approve");
  const before = fake.calls.length;
  fake.advanceClock(24 * 60 * 60_000);
  await sources.drain();
  expect(sources.list()[0]).toMatchObject({ status: "failed" });
  expect(sources.list()[0].steps.map((step) => step.status)).toEqual([
    "succeeded",
    "failed",
    "skipped",
    "skipped",
    "skipped",
  ]);
  expect(fake.calls.slice(before)).toEqual(["snapshot"]);
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
  {
    name: "leaves a Host-agent request pending for the owner without the full grant",
    run: () => {
      const fake = followPorts({ delegationGrant: () => null });
      const follow = new CoordinatorFollow(createCoordinatorFollowJournal(directory), fake.ports);
      follow.request("/releases/new", { requestedBy: "host-agent", requester: "Builds" });
      fake.advanceClock(60_000);
      follow.drain();
      expect(follow.status().job).toMatchObject({ status: "pending", requester: "Builds" });
      expect(follow.status().job?.delegatedApproval).toBeUndefined();
      expect(fake.calls).toEqual([]);
    },
  },
  {
    name: "starts a Host-agent request under the full grant only after the cancellation window",
    run: () => {
      const grant = {
        policyActivatedAt: "2026-11-01T00:00:00.000Z",
        authoritySha256: "a".repeat(64),
      };
      const fake = followPorts({ delegationGrant: () => grant, cancellationDelayMs: 30_000 });
      const follow = new CoordinatorFollow(createCoordinatorFollowJournal(directory), fake.ports);
      follow.request("/releases/new", { requestedBy: "host-agent" });
      follow.drain();
      const held = follow.status().job;
      expect(held).toMatchObject({
        status: "pending",
        delegatedApproval: { requestRevision: held?.revision },
      });
      fake.advanceClock(29_000);
      follow.drain();
      expect(fake.calls).toEqual([]);
      fake.advanceClock(1_000);
      follow.drain();
      expect(fake.calls).toEqual(["swap /releases/old -> /releases/new running"]);
    },
  },
  {
    name: "cancels a delegated request when the grant or the Host release changes before dispatch",
    run: () => {
      for (const change of ["revoked", "rotated", "release"] as const) {
        let grant: { policyActivatedAt: string; authoritySha256: string } | null = {
          policyActivatedAt: "2026-11-01T00:00:00.000Z",
          authoritySha256: "a".repeat(64),
        };
        let host = "/releases/new";
        const fake = followPorts({ delegationGrant: () => grant, hostRelease: () => host });
        rmSync(directory, { recursive: true, force: true });
        directory = mkdtempSync(path.join(tmpdir(), "release-upgrades-"));
        const follow = new CoordinatorFollow(createCoordinatorFollowJournal(directory), fake.ports);
        follow.request("/releases/new", { requestedBy: "host-agent" });
        follow.drain();
        if (change === "revoked") grant = null;
        else if (change === "rotated") grant = { ...grant!, authoritySha256: "b".repeat(64) };
        else host = "/releases/newer";
        fake.advanceClock(30_000);
        follow.drain();
        expect(follow.status().job?.status, change).toBe("cancelled");
        expect(fake.calls, change).toEqual([]);
      }
    },
  },
  {
    name: "rechecks the grant for a delegated approval recovered from the journal",
    run: () => {
      const grant = {
        policyActivatedAt: "2026-11-01T00:00:00.000Z",
        authoritySha256: "a".repeat(64),
      };
      const before = followPorts({ delegationGrant: () => grant });
      const followJournal = createCoordinatorFollowJournal(directory);
      const first = new CoordinatorFollow(followJournal, before.ports);
      first.request("/releases/new", { requestedBy: "host-agent" });
      first.drain();
      // The coordinator stopped after recording the approval and before dispatching it.
      followJournal.write([{ ...first.status().job!, status: "approved" }]);
      const after = followPorts({
        delegationGrant: () => ({ ...grant, authoritySha256: "b".repeat(64) }),
      });
      const recovered = new CoordinatorFollow(
        createCoordinatorFollowJournal(directory),
        after.ports,
      );
      recovered.drain();
      expect(recovered.status().job?.status).toBe("cancelled");
      expect(after.calls).toEqual([]);
    },
  },
])("coordinator follow $name", ({ run }) => run());
