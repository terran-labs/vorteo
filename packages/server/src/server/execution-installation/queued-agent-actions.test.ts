import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { z } from "zod";
import { createQueuedAgentActions, type QueuedActionDefinition } from "./queued-agent-actions.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "queued-agent-actions-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const GRANT = { policyActivatedAt: "2026-11-01T00:00:00.000Z", authoritySha256: "a".repeat(64) };

/** A domain-like change with a revisioned value, a reachability check and a CAS restore. */
function domain(
  options: {
    reachable?: () => string | null;
    settled?: () => boolean;
    capture?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const state = { value: "old", revision: 1, operation: undefined as string | undefined };
  const definition: QueuedActionDefinition = {
    name: "custom-domain",
    schema: z.strictObject({ origin: z.string() }),
    disruption: () => "Can interrupt remote access.",
    async preflight(request) {
      calls.push("preflight");
      if ((request as { origin: string }).origin === "bad") throw new Error("no certificate");
    },
    async capture() {
      await options.capture?.();
      return state.value;
    },
    async apply(request) {
      calls.push("apply");
      state.value = (request as { origin: string }).origin;
      state.revision += 1;
      return `Moved to ${state.value}.`;
    },
    ...(options.settled ? { settled: async () => options.settled!() } : {}),
    async state(request) {
      return {
        applied: state.value === (request as { origin: string }).origin,
        revision: String(state.revision),
        detail: `the value is ${state.value}`,
        ...(state.operation ? { operation: state.operation } : {}),
      };
    },
    reachable: async () => options.reachable?.() ?? null,
    async restore(previous, revision, operation) {
      calls.push(`restore ${String(previous)}`);
      if (String(state.revision) !== revision) throw new Error("the value changed since");
      state.value = String(previous);
      state.revision += 1;
      state.operation = operation;
    },
  };
  return { definition, calls, state, value: () => state.value };
}

function queue(
  definition: QueuedActionDefinition,
  clock: { now: number },
  grant: () => typeof GRANT | null = () => GRANT,
) {
  return createQueuedAgentActions({
    stateDir,
    definitions: [definition],
    grant,
    now: () => new Date(clock.now),
    cancellationDelayMs: 30_000,
  });
}

test("the full grant starts a change only after its window, and revocation cancels it", async () => {
  for (const revoke of [false, true]) {
    rmSync(stateDir, { recursive: true, force: true });
    const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
    let grant: typeof GRANT | null = GRANT;
    const fake = domain();
    const actions = queue(fake.definition, clock, () => grant);
    actions.request("custom-domain", { origin: "https://new.example" }, "Builds");
    await actions.drain();
    expect(actions.list()[0]).toMatchObject({ status: "pending", delegatedApproval: GRANT });
    clock.now += 29_000;
    await actions.drain();
    expect(fake.calls).toEqual([]);
    if (revoke) grant = null;
    clock.now += 1_000;
    await actions.drain();
    await actions.drain();
    expect(actions.list()[0]?.status, String(revoke)).toBe(revoke ? "cancelled" : "succeeded");
    expect(fake.calls, String(revoke)).toEqual(revoke ? [] : ["preflight", "apply"]);
  }
});

test("a refused preflight changes nothing", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  const fake = domain();
  const actions = queue(fake.definition, clock);
  const job = actions.request("custom-domain", { origin: "bad" }, "Builds");
  actions.decide(job.id, job.revision, "approve");
  await actions.drain();
  expect(actions.list()[0]).toMatchObject({ status: "failed" });
  expect(actions.list()[0]?.detail).toContain("no certificate");
  expect(fake.calls).toEqual(["preflight"]);
  expect(fake.value()).toBe("old");
});

test("a change that leaves the installation unreachable is restored", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  const fake = domain({ reachable: () => "https://new.example did not answer: timeout" });
  const actions = queue(fake.definition, clock);
  const job = actions.request("custom-domain", { origin: "https://new.example" }, "Builds");
  actions.decide(job.id, job.revision, "approve");
  await actions.drain();
  expect(fake.calls).toEqual(["preflight", "apply", "restore old"]);
  expect(fake.value()).toBe("old");
  expect(actions.list()[0]).toMatchObject({ status: "failed" });
  expect(actions.list()[0]?.detail).toContain("did not answer");
});

test("a change that restarts the coordinator is followed by the next one, from the journal", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  let settled = false;
  let reachable: string | null = "timeout";
  const fake = domain({ settled: () => settled, reachable: () => reachable });
  const first = queue(fake.definition, clock);
  const job = first.request("custom-domain", { origin: "https://new.example" }, "Builds");
  first.decide(job.id, job.revision, "approve");
  await first.drain();
  // Still restarting: nothing is verified or restored yet.
  expect(first.list()[0]).toMatchObject({ status: "running", previous: "old" });
  settled = true;
  reachable = null;
  const next = queue(fake.definition, clock);
  await next.drain();
  expect(next.list()[0]).toMatchObject({ status: "succeeded" });
  expect(fake.calls).toEqual(["preflight", "apply"]);
});

test("without the grant a request waits for the owner, who can approve or cancel it", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  const fake = domain();
  const actions = queue(fake.definition, clock, () => null);
  const job = actions.request("custom-domain", { origin: "https://new.example" }, "Builds");
  clock.now += 60_000;
  await actions.drain();
  expect(actions.list()[0]).toMatchObject({ status: "pending" });
  expect(actions.list()[0]?.delegatedApproval).toBeUndefined();
  expect(() =>
    actions.request("custom-domain", { origin: "https://other.example" }, "Builds"),
  ).toThrow("already waiting");
  actions.decide(job.id, job.revision, "cancel");
  await actions.drain();
  expect(actions.list()[0]).toMatchObject({ status: "cancelled" });
  expect(fake.calls).toEqual([]);
});

test("a cancel during the capture stops the change before any effect", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  let cancel = () => {};
  const fake = domain({ capture: async () => cancel() });
  const actions = queue(fake.definition, clock);
  const job = actions.request("custom-domain", { origin: "https://new.example" }, "Builds");
  const approved = actions.decide(job.id, job.revision, "approve");
  cancel = () => void actions.decide(approved.id, approved.revision, "cancel");
  await actions.drain();
  expect(actions.list()[0]).toMatchObject({ status: "cancelled" });
  expect(fake.calls).toEqual(["preflight"]);
});

test("a coordinator that stopped before applying reports the change as not in effect", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  const fake = domain();
  const first = queue(fake.definition, clock);
  const job = first.request("custom-domain", { origin: "https://new.example" }, "Builds");
  first.decide(job.id, job.revision, "approve");
  // Simulate the crash: the running record exists, but apply never ran.
  fake.definition.apply = async () => new Promise<never>(() => {});
  void first.drain();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const next = queue({ ...fake.definition, apply: async () => "unused" }, clock);
  await next.drain();
  expect(next.list()[0]).toMatchObject({ status: "failed" });
  expect(next.list()[0]?.detail).toContain("did not take effect");
});

test("a restore is resumed after a restart and never started twice", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  let settled = true;
  const fake = domain({ settled: () => settled, reachable: () => "domain did not answer" });
  const restore = fake.definition.restore!;
  // The restore restarts the coordinator: it is still settling when this process stops.
  fake.definition.restore = async (previous, revision, operation) => {
    await restore(previous, revision, operation);
    settled = false;
  };
  const first = queue(fake.definition, clock);
  const job = first.request("custom-domain", { origin: "https://new.example" }, "Builds");
  first.decide(job.id, job.revision, "approve");
  await first.drain();
  expect(first.list()[0]).toMatchObject({ status: "restoring", restoreAttempts: 1 });
  settled = true;
  const next = queue(fake.definition, clock);
  await next.drain();
  expect(next.list()[0]).toMatchObject({ status: "failed" });
  expect(next.list()[0]?.detail).toContain("Restored the previous value");
  expect(fake.calls.filter((call) => call.startsWith("restore"))).toHaveLength(1);
});

test("a restore never overwrites a change the owner made during verification", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  let fake!: ReturnType<typeof domain>;
  fake = domain({
    reachable: () => {
      // The owner changes the value while reachability is being checked.
      fake.state.value = "owner";
      fake.state.revision += 1;
      return "domain did not answer";
    },
  });
  const actions = queue(fake.definition, clock);
  const job = actions.request("custom-domain", { origin: "https://new.example" }, "Builds");
  actions.decide(job.id, job.revision, "approve");
  await actions.drain();
  expect(fake.value()).toBe("owner");
  expect(actions.list()[0]).toMatchObject({ status: "failed" });
  expect(actions.list()[0]?.detail).toContain("Not restored");
});

test("a restore interrupted before it changed anything runs on resume, once", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  const fake = domain({ reachable: () => "domain did not answer" });
  const restore = fake.definition.restore!;
  let crash = true;
  // The coordinator stops after recording the attempt and before the restore runs.
  fake.definition.restore = async (previous, revision, operation) => {
    if (crash) return new Promise<never>(() => {});
    return restore(previous, revision, operation);
  };
  const first = queue(fake.definition, clock);
  const job = first.request("custom-domain", { origin: "https://new.example" }, "Builds");
  first.decide(job.id, job.revision, "approve");
  void first.drain();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(first.list()[0]).toMatchObject({ status: "restoring", restoreAttempts: 1 });
  crash = false;
  const next = queue(fake.definition, clock);
  await next.drain();
  expect(fake.value()).toBe("old");
  expect(next.list()[0]?.detail).toContain("Restored the previous value");
  expect(fake.calls.filter((call) => call.startsWith("restore"))).toHaveLength(1);
});

test("a restore interrupted after it changed the revision but not the value is retried", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  const fake = domain({ reachable: () => "domain did not answer" });
  const restore = fake.definition.restore!;
  let crash = true;
  // Like the custom domain: the revision moves before the value is written, then it stops.
  fake.definition.restore = async (previous, revision, operation) => {
    if (!crash) return restore(previous, revision, operation);
    // Records its own change first, then stops before writing the value.
    fake.state.revision += 1;
    fake.state.operation = operation;
    return new Promise<never>(() => {});
  };
  const first = queue(fake.definition, clock);
  const job = first.request("custom-domain", { origin: "https://new.example" }, "Builds");
  first.decide(job.id, job.revision, "approve");
  void first.drain();
  await new Promise((resolve) => setTimeout(resolve, 10));
  crash = false;
  const next = queue(fake.definition, clock);
  await next.drain();
  expect(fake.value()).toBe("old");
  expect(next.list()[0]?.detail).toContain("Restored the previous value");
});

test("a resumed restore never undoes an owner who changed the value away and back", async () => {
  const clock = { now: Date.parse("2026-11-08T12:00:00Z") };
  const fake = domain({ reachable: () => "domain did not answer" });
  const restore = fake.definition.restore!;
  let crash = true;
  fake.definition.restore = async (previous, revision, operation) => {
    if (crash) return new Promise<never>(() => {});
    return restore(previous, revision, operation);
  };
  const first = queue(fake.definition, clock);
  const job = first.request("custom-domain", { origin: "https://new.example" }, "Builds");
  first.decide(job.id, job.revision, "approve");
  void first.drain();
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The owner switches away and deliberately back before recovery resumes.
  fake.state.value = "elsewhere";
  fake.state.revision += 1;
  fake.state.operation = "owner-1";
  fake.state.value = "https://new.example";
  fake.state.revision += 1;
  fake.state.operation = "owner-2";
  crash = false;
  const next = queue(fake.definition, clock);
  await next.drain();
  expect(fake.value()).toBe("https://new.example");
  expect(next.list()[0]?.detail).toContain("changed since");
});
