import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { DashboardSampleSchema, type DashboardSample } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "./atomic-file.js";

import { collectDashboardSources } from "./dashboard-sources.js";

const HOUR = 3_600_000;
const historyFile = (home: string) => path.join(home, "dashboard", "hourly.json");
const historySchema = z.array(DashboardSampleSchema);
export async function readDashboardHistory(home: string): Promise<DashboardSample[]> {
  try {
    return historySchema.parse(JSON.parse(await readFile(historyFile(home), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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
  collect: () => Promise<Record<string, number>>,
  logger: Logger,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const record = async () => {
    const history = await readDashboardHistory(home);
    const now = Date.now();
    // Restarts in the same bucket preserve its existing observation.
    const hour = Math.floor(now / HOUR);
    if (history.some((sample) => Math.floor(Date.parse(sample.at) / HOUR) === hour)) return;
    const values = await collect();
    const unavailable = await collectDashboardSources(home, new Date(now), values);
    const sample = { at: new Date(now).toISOString(), values, unavailable };
    await writeJsonFileAtomic(historyFile(home), [
      ...history.filter((point) => Date.parse(point.at) > now - 90 * 24 * HOUR),
      sample,
    ]);
  };
  const tick = () => {
    running ??= record()
      .catch((err) => logger.warn({ err }, "Dashboard collection failed"))
      .finally(() => {
        running = undefined;
      });
  };
  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, HOUR);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
