import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { HealthDismissalStore } from "./health-dismissals.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// #639: the owner's dismissals survive a coordinator restart, and only failures can be dismissed.
test("dismisses failed records once, keeps them across a restart and refuses anything else", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "health-dismissals-"));
  roots.push(root);
  const records: Record<string, { status: string; stage?: string }> = {
    failed: { status: "failed" },
    running: { status: "running" },
    stuck: { status: "failed", stage: "recovery_required" },
  };
  const lookup = (_queue: string, id: string) => records[id];
  const now = () => new Date("2026-11-24T00:00:00.000Z");
  const store = await HealthDismissalStore.open(root, { lookup, now });
  await store.dismiss({ queue: "session-host", id: "failed" });
  await store.dismiss({ queue: "session-host", id: "failed" });
  await expect(store.dismiss({ queue: "session-host", id: "running" })).rejects.toThrow(
    "Only a failed",
  );
  await expect(store.dismiss({ queue: "session-host", id: "missing" })).rejects.toThrow("Unknown");
  await expect(store.dismiss({ queue: "session-host", id: "stuck" })).rejects.toThrow(
    "needs recovery",
  );
  await expect(store.dismiss({ queue: "unknown-queue", id: "failed" })).rejects.toThrow();
  expect((await HealthDismissalStore.open(root, { lookup, now })).list()).toEqual({
    dismissals: [{ queue: "session-host", id: "failed", dismissedAt: "2026-11-24T00:00:00.000Z" }],
  });
});

// The file is optional: a damaged or unreadable one must never stop the coordinator.
test("starts empty on a damaged or unreadable store and forgets a dismissal it could not save", async () => {
  const lookup = () => ({ status: "failed" });
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  const damaged = mkdtempSync(path.join(tmpdir(), "health-dismissals-"));
  roots.push(damaged);
  writeFileSync(path.join(damaged, "health-dismissals.json"), "not json");
  expect((await HealthDismissalStore.open(damaged, { lookup, warn })).list().dismissals).toEqual(
    [],
  );
  expect(
    readdirSync(damaged).some((name) => name.startsWith("health-dismissals.json.unreadable-")),
  ).toBe(true);
  const unreadable = mkdtempSync(path.join(tmpdir(), "health-dismissals-"));
  roots.push(unreadable);
  mkdirSync(path.join(unreadable, "health-dismissals.json"));
  expect((await HealthDismissalStore.open(unreadable, { lookup, warn })).list().dismissals).toEqual(
    [],
  );
  expect(warnings).toHaveLength(2);
  // A store whose directory is a regular file cannot save anything.
  const blocked = path.join(damaged, "not-a-directory");
  writeFileSync(blocked, "");
  const store = await HealthDismissalStore.open(blocked, { lookup, warn });
  await expect(store.dismiss({ queue: "restart", id: "failed" })).rejects.toThrow();
  expect(store.list().dismissals).toEqual([]);
  // A dismissal made while an earlier one's write is failing must not save the failed one.
  const written: string[] = [];
  let calls = 0;
  const write = async (_file: string, data: string) => {
    calls += 1;
    if (calls === 1) throw new Error("disk full");
    written.push(data);
  };
  const racing = await HealthDismissalStore.open(damaged, { lookup, warn, write });
  const first = racing.dismiss({ queue: "restart", id: "a" });
  const second = racing.dismiss({ queue: "restart", id: "b" });
  await expect(first).rejects.toThrow("disk full");
  await second;
  expect(racing.list().dismissals.map((entry) => entry.id)).toEqual(["b"]);
  expect(JSON.parse(written.at(-1)!).dismissals.map((entry: { id: string }) => entry.id)).toEqual([
    "b",
  ]);
});
