import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import {
  digestBootstrapArtifact,
  withBootstrapArtifactReuse,
} from "./coordinator-bootstrap-artifact.js";
import { createDispatchingBootstrapReview } from "./coordinator-bootstrap-launch.js";
import {
  CoordinatorBootstrapRequests,
  coordinatorPlanDigest,
  type BootstrapRequestJournal,
} from "./coordinator-bootstrap.js";
import type {
  CoordinatorBootstrapPlan,
  CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: vi.fn(function (...args: ConstructorParameters<typeof actual.Worker>) {
      return new actual.Worker(...args);
    }),
  };
});

// Runtime launch evidence is covered by the runner suites; this file isolates
// which tree proofs an owner decision may carry into dispatch.
vi.mock("./coordinator-bootstrap-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coordinator-bootstrap-runner.js")>()),
  verifyBootstrapExecutionRuntime: vi.fn(async () => {}),
}));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function treeScans(directory: string): number {
  return vi
    .mocked(Worker)
    .mock.calls.filter(
      ([, options]) =>
        options?.workerData?.role === "vorteo-artifact-scan" &&
        options.workerData.directory === directory,
    ).length;
}

async function dispatchFixture(options: { launch?: boolean; dispatchWaitTimeoutMs?: number } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "bootstrap-dispatch-")));
  roots.push(root);
  const release = path.join(root, "release");
  await mkdir(release, { mode: 0o700 });
  await writeFile(path.join(release, "entry.js"), "export {};", { mode: 0o600 });
  await writeFile(
    path.join(release, ".installation-source.json"),
    JSON.stringify({ sourceCommit: "a".repeat(40) }),
    { mode: 0o600 },
  );
  const pinned = async (name: string, text: string, mode = 0o600) => {
    await writeFile(path.join(root, name), text, { mode });
    return { path: path.join(root, name), sha256: sha(text) };
  };
  const candidate = {
    sourceCommit: "a".repeat(40),
    directory: release,
    artifactSha256: await digestBootstrapArtifact(release),
    node: await pinned("node", "fixture executable", 0o700),
    entrypoint: { path: path.join(release, "entry.js"), sha256: sha("export {};") },
    configuration: await pinned("coordinator.json", "{}"),
    launcher: await pinned("launcher.plist", "fixture launcher"),
  };
  // A mismatched owner launcher stops dispatch after its candidate verification
  // and before any process launch.
  const ownerPin = await pinned("owner.py", "owner");
  const ownerLauncher = options.launch ? ownerPin : { ...ownerPin, sha256: "0".repeat(64) };
  const request = {
    id: randomUUID(),
    revision: randomUUID(),
    planSha256: "b".repeat(64),
    status: "approved",
    plan: { candidate, state: { directory: root } },
  };
  const decide = vi.fn(async () => request);
  const closeFailedDispatch = vi.fn(() => null);
  const requests = { list: () => [request], decide, closeFailedDispatch };
  const review = createDispatchingBootstrapReview({
    setup: {
      admissionSetupFile: path.join(root, "admission.json"),
      daemonId: "host-id",
      node: candidate.node,
      entrypoint: candidate.entrypoint,
      ownerLauncher,
      ownershipVerifier: ownerLauncher,
      runtimeDirectory: release,
      runtimeSha256: candidate.artifactSha256,
    },
    setupFile: path.join(root, "setup.json"),
    requests: requests as unknown as Parameters<
      typeof createDispatchingBootstrapReview
    >[0]["requests"],
    verifySetup: async () => [],
    dispatchWaitTimeoutMs: options.dispatchWaitTimeoutMs,
  });
  const approval = {
    id: request.id,
    revision: request.revision,
    planSha256: request.planSha256,
    decision: "approve" as const,
  };
  const identity = { id: request.id, revision: request.revision, planSha256: request.planSha256 };
  return { release, review, approval, decide, closeFailedDispatch, identity };
}

test("dispatch after an owner decision re-reads candidate bytes in full", async () => {
  const { release, review, approval, decide } = await dispatchFixture();
  vi.mocked(Worker).mockClear();
  await expect(review.decide(approval, "owner password")).rejects.toThrow(
    "Prepared document digest changed",
  );
  expect(decide).toHaveBeenCalledTimes(1);
  // One scan before the decision and a fresh one at launch, never a reused proof.
  expect(treeScans(release)).toBe(2);
});

test("dispatch does not join an enclosing reuse operation", async () => {
  const { release, review, approval } = await dispatchFixture();
  vi.mocked(Worker).mockClear();
  await withBootstrapArtifactReuse(async () => {
    await expect(review.decide(approval, "owner password")).rejects.toThrow(
      "Prepared document digest changed",
    );
  });
  expect(treeScans(release)).toBe(2);
});

/** A child that the observation sees as not spawned, ended or still running. */
function fakeChild(state: "no-spawn" | "exit" | "alive"): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: state === "no-spawn" ? undefined : 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(),
    unref: () => {},
  });
  // Node 24 reports a failed spawn on a later tick with the negative errno and no
  // "exit"; a started child sets exitCode before emitting "exit".
  setImmediate(() => {
    if (state === "no-spawn") {
      child.exitCode = -2;
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    } else if (state === "exit") {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    }
  });
  return child as unknown as ChildProcess;
}

test.each([
  { name: "synchronous spawn throw", closes: true },
  { name: "asynchronous spawn error", child: "no-spawn", closes: true },
  { name: "exit before acknowledgement", child: "exit", closes: true },
  { name: "live child past the observation deadline", child: "alive", closes: false },
] as const)("launch observation after $name", async (scenario) => {
  const { review, approval, closeFailedDispatch, identity } = await dispatchFixture({
    launch: true,
    dispatchWaitTimeoutMs: 50,
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    if (!("child" in scenario)) throw new TypeError("invalid spawn argument");
    return fakeChild(scenario.child);
  });
  await expect(review.decide(approval, "owner password")).rejects.toThrow(
    "child" in scenario ? "dispatch is unconfirmed" : "invalid spawn argument",
  );
  // Only the exact approved identity is offered to the CAS; a live child never is.
  expect(closeFailedDispatch.mock.calls).toEqual(
    scenario.closes ? [[identity, expect.any(String)]] : [],
  );
});

test("closing a failed launch leaves claimed and changed requests untouched", () => {
  const plan: CoordinatorBootstrapPlan = {
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: randomUUID(),
    service: "gui/501/local.vorteo.fixture.installation",
    expectedProcess: {
      pid: 123,
      bootId: "fixture-boot",
      startIdentity: "fixture-start",
      argumentsSha256: "d".repeat(64),
    },
    previous: {
      sourceCommit: "b".repeat(40),
      directory: "/protected/release",
      artifactSha256: "c".repeat(64),
      node: { path: "/protected/file", sha256: "a".repeat(64) },
      entrypoint: { path: "/protected/file", sha256: "a".repeat(64) },
      configuration: { path: "/protected/file", sha256: "a".repeat(64) },
      launcher: { path: "/protected/file", sha256: "a".repeat(64) },
    },
    candidate: {
      sourceCommit: "e".repeat(40),
      directory: "/protected/release",
      artifactSha256: "c".repeat(64),
      node: { path: "/protected/file", sha256: "a".repeat(64) },
      entrypoint: { path: "/protected/file", sha256: "a".repeat(64) },
      configuration: { path: "/protected/file", sha256: "a".repeat(64) },
      launcher: { path: "/protected/file", sha256: "a".repeat(64) },
    },
    state: {
      directory: "/protected/state",
      restartJournal: "/protected/state/restarts.json",
      ownerSessions: "/protected/state/owners.json",
    },
    hostRequestsAfter: null,
  };
  const approved: CoordinatorBootstrapRequest = {
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "fixture",
    createdAt: "2026-11-02T00:00:00.000Z",
    plan,
    planSha256: coordinatorPlanDigest(plan),
    status: "approved",
    decisionAt: "2026-11-02T00:00:00.000Z",
  };
  const claimed: CoordinatorBootstrapRequest = {
    ...approved,
    id: randomUUID(),
    execution: {
      generation: randomUUID(),
      stage: "claimed",
      updatedAt: "2026-11-02T00:00:01.000Z",
    },
  };
  let records = [approved, claimed];
  const journal: BootstrapRequestJournal = {
    read: () => structuredClone(records),
    replace: (expected, next) => {
      expect(expected).toEqual(records);
      records = structuredClone(next);
    },
  };
  const requests = new CoordinatorBootstrapRequests(
    journal,
    () => ({
      environment: "host",
      installationId: plan.installationId,
      service: plan.service,
      ownerPasswordHash: `$2b$04$${"a".repeat(53)}`,
    }),
    async () => {},
  );
  const identity = (request: CoordinatorBootstrapRequest) => ({
    id: request.id,
    revision: request.revision,
    planSha256: request.planSha256,
  });
  const before = structuredClone(records);
  expect(requests.closeFailedDispatch(identity(claimed))).toBeNull();
  expect(
    requests.closeFailedDispatch({ ...identity(approved), revision: randomUUID() }),
  ).toBeNull();
  expect(records).toEqual(before);
  expect(requests.closeFailedDispatch(identity(approved))).toMatchObject({ status: "canceled" });
  expect(records[1]).toEqual(claimed);
});
