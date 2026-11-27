import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, onTestFinished, test, vi } from "vitest";
import { createDashboardCollector, readDashboardHistory } from "./dashboard-history.js";
import { createDashboardIntervalUsage } from "./dashboard-usage.js";

const logger = pino({ level: "silent" });

test("hourly usage follows comparable provider sessions and leaves gaps across resets", () => {
  const sample = createDashboardIntervalUsage();
  const hour = 3_600_000;
  const record = (sessionId: string, sessionTokens: number, estimatedCostUsd: number) => ({
    persistence: { provider: "codex", sessionId },
    lastUsage: { sessionTokens, estimatedCostUsd },
  });
  expect(sample([record("first", 100, 4)], 0)).toEqual({});
  expect(
    sample([record("first", 120, 5), record("second", 400, 20)], hour, new Date(0).toISOString()),
  ).toEqual({
    intervalTokens: 20,
    intervalApiUsd: 1,
  });
  expect(sample([record("second", 5, 1)], hour * 2, new Date(hour).toISOString())).toEqual({});
  expect(sample([record("second", 200, 5)], hour * 4, new Date(hour * 2).toISOString())).toEqual(
    {},
  );
  expect(sample([record("second", 220, 6)], hour * 5, new Date(hour * 2).toISOString())).toEqual(
    {},
  );
});

async function createDashboardHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-dashboard-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "dashboard"));
  return home;
}

test("stopping aborts an active source before committing a partial sample", async () => {
  const home = await createDashboardHome();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let sourceSignal: AbortSignal | undefined;
  const collector = createDashboardCollector(
    home,
    async () => ({ projects: 1 }),
    logger,
    async (_home, _now, _values, signal) => {
      sourceSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        notifyStarted();
      });
      return [];
    },
  );
  collector.start();
  await started;
  await collector.stop();
  expect(sourceSignal?.aborted).toBe(true);
  await expect(readDashboardHistory(home)).resolves.toEqual([]);
}, 2_000);

test.each(["broken JSON", "invalid row"])("preserves damaged history with %s", async (damage) => {
  const home = await createDashboardHome();
  const dir = path.join(home, "dashboard");
  const original = {
    at: new Date(Date.now() - 3_600_000).toISOString(),
    values: { projects: 3 },
    unavailable: [],
  };
  const recoverable = damage === "invalid row";
  const raw = recoverable ? JSON.stringify([original, { at: "invalid" }]) : "[unterminated";
  await writeFile(path.join(dir, "hourly.json"), raw);
  const collector = createDashboardCollector(home, async () => ({ projects: 4 }), logger);
  collector.start();
  try {
    await vi.waitFor(async () => {
      const samples = await readDashboardHistory(home);
      const retained = recoverable ? [original] : [];
      expect(samples).toEqual([
        ...retained,
        { at: expect.any(String), values: { projects: 4 }, unavailable: expect.any(Array) },
      ]);
    });
    const backups = (await readdir(dir)).filter((name) => name.startsWith("hourly.json.corrupt-"));
    expect(backups).toHaveLength(1);
    await expect(readFile(path.join(dir, backups[0]!), "utf8")).resolves.toBe(raw);
  } finally {
    await collector.stop();
  }
});
