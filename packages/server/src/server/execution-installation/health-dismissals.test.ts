import { mkdtempSync, rmSync } from "node:fs";
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
  const records: Record<string, { status: string }> = {
    failed: { status: "failed" },
    running: { status: "running" },
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
  await expect(store.dismiss({ queue: "restart", id: "failed" })).rejects.toThrow();
  expect((await HealthDismissalStore.open(root, { lookup, now })).list()).toEqual({
    dismissals: [{ queue: "session-host", id: "failed", dismissedAt: "2026-11-24T00:00:00.000Z" }],
  });
});
