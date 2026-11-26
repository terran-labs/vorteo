import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { DashboardSampleSchema, type DashboardSample } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "./atomic-file.js";
import { collectDashboardSources } from "./dashboard-sources.js";

const HOUR = 3_600_000;
const historyFile = (home: string) => path.join(home, "dashboard", "hourly.json");
const historySchema = z.array(DashboardSampleSchema);
async function readHistoryFile(home: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readFile(historyFile(home), { signal });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return Buffer.from("[]");
    throw error;
  }
}

export async function readDashboardHistory(home: string): Promise<DashboardSample[]> {
  const raw = await readHistoryFile(home);
  return historySchema.parse(JSON.parse(raw.toString("utf8")));
}

function parseHistoryForCollection(raw: Buffer) {
  let data: unknown;
  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { samples: [], corrupt: true };
  }
  if (!Array.isArray(data)) return { samples: [], corrupt: true };
  const samples: DashboardSample[] = [];
  for (const row of data) {
    const result = DashboardSampleSchema.safeParse(row);
    if (result.success) samples.push(result.data);
  }
  return { samples, corrupt: samples.length !== data.length };
}

export function summarizeDashboard(
  projects: readonly { archivedAt: string | null }[],
  workspaces: readonly { archivedAt: string | null }[],
  agents: readonly { lastUsage?: Record<string, number> }[],
): Record<string, number> {
  const values: Record<string, number> = {
    projects: projects.filter((project) => !project.archivedAt).length,
    workspaces: workspaces.filter((workspace) => !workspace.archivedAt).length,
    reporting: 0,
  };
  for (const { lastUsage: usage } of agents) {
    if (!usage) continue;
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
      values.tokens = (values.tokens ?? 0) + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      values.reporting = (values.reporting ?? 0) + 1;
    }
    const cost = usage.totalCostUsd ?? usage.estimatedCostUsd;
    if (cost !== undefined) values.apiUsd = (values.apiUsd ?? 0) + cost;
  }
  return values;
}

export function createDashboardCollector(
  home: string,
  collect: (
    signal: AbortSignal,
    at: number,
    lastRecordedAt?: string,
  ) => Promise<Record<string, number>>,
  logger: Logger,
  collectSources = collectDashboardSources,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  async function record(signal: AbortSignal) {
    const raw = await readHistoryFile(home, signal);
    const { samples, corrupt } = parseHistoryForCollection(raw);
    const now = Date.now();
    // Restarts in the same bucket preserve its existing observation.
    const hour = Math.floor(now / HOUR);
    const recorded = samples.some((sample) => Math.floor(Date.parse(sample.at) / HOUR) === hour);
    if (recorded && !corrupt) return;
    const history = samples.filter((sample) => Date.parse(sample.at) > now - 90 * 24 * HOUR);
    if (!recorded) {
      signal.throwIfAborted();
      const values = await collect(signal, now, history.at(-1)?.at);
      signal.throwIfAborted();
      const unavailable = await collectSources(home, new Date(now), values, signal);
      history.push({ at: new Date(now).toISOString(), values, unavailable });
    }
    signal.throwIfAborted();
    const file = historyFile(home);
    if (corrupt) {
      // Preserve the original before replacing it, including rows we could not decode.
      const backup = `${file}.corrupt-${randomUUID()}`;
      await writeFile(backup, raw, { flag: "wx", mode: 0o600 });
      logger.warn({ backup }, "Preserved damaged dashboard history");
    }
    signal.throwIfAborted();
    await writeJsonFileAtomic(file, history);
  }
  function tick(signal: AbortSignal) {
    running ??= record(signal)
      .catch((err: unknown) => {
        if (!signal.aborted) logger.warn({ err }, "Dashboard collection failed");
      })
      .finally(() => {
        running = undefined;
      });
  }
  return {
    start() {
      if (timer || running) return;
      controller = new AbortController();
      tick(controller.signal);
      timer = setInterval(tick, HOUR, controller.signal);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      controller?.abort();
      await running;
    },
  };
}
