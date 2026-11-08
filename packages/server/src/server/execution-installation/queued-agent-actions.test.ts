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

/** A domain-like change: a value, a reachability check and a restore, all recorded. */
function domain(options: { reachable?: () => string | null; settled?: () => boolean } = {}) {
  const calls: string[] = [];
  let value = "old";
  const definition: QueuedActionDefinition = {
    name: "custom-domain",
    schema: z.strictObject({ origin: z.string() }),
    disruption: () => "Can interrupt remote access.",
    async preflight(request) {
      calls.push("preflight");
      if ((request as { origin: string }).origin === "bad") throw new Error("no certificate");
    },
    capture: async () => value,
    async apply(request) {
      calls.push("apply");
      value = (request as { origin: string }).origin;
      return `Moved to ${value}.`;
    },
    ...(options.settled ? { settled: async () => options.settled!() } : {}),
    verify: async () => options.reachable?.() ?? null,
    async restore(previous) {
      calls.push(`restore ${String(previous)}`);
      value = String(previous);
    },
  };
  return { definition, calls, value: () => value };
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
