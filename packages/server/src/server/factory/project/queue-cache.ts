import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import {
  ProjectFactoryQueueSchema,
  type ProjectFactoryQueue,
} from "@getpaseo/server/factory-project";
import { queueDeadline } from "./queue.js";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const SnapshotSchema = z.object({ repository: z.string(), queue: ProjectFactoryQueueSchema });
interface Entry {
  repository: string;
  snapshot: ProjectFactoryQueue | null;
  complete: ProjectFactoryQueue | null;
  loaded: Promise<void>;
  nextRefreshAt: number;
  refreshing: Promise<void> | null;
}
interface QueueRead {
  projectId: string;
  repository: string;
  paused: boolean;
  enabled: boolean;
  now: Date;
  refresh: () => Promise<ProjectFactoryQueue>;
}

/** Display snapshots never delay a caller behind GitHub or cross-environment reads. */
export class FactoryQueueSnapshots {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
  ) {}

  async read(input: QueueRead): Promise<ProjectFactoryQueue> {
    let entry = this.entries.get(input.projectId);
    if (!entry || entry.repository !== input.repository) {
      const created: Entry = {
        repository: input.repository,
        snapshot: null,
        complete: null,
        loaded: Promise.resolve(),
        nextRefreshAt: 0,
        refreshing: null,
      };
      created.loaded = this.load(input).then((snapshot) => {
        created.snapshot = snapshot;
        created.complete = snapshot;
        return undefined;
      });
      entry = created;
      this.entries.set(input.projectId, entry);
    }
    await entry.loaded;
    const snapshot = entry.snapshot;
    const expired = input.now.getTime() >= entry.nextRefreshAt;
    const cold = entry.complete === null;
    const mayRefresh = input.enabled && (!input.paused || cold);
    if (mayRefresh && expired && !entry.refreshing) {
      const backoff = input.paused ? 5 * 60_000 : 30_000;
      entry.nextRefreshAt = input.now.getTime() + backoff;
      entry.refreshing = this.refresh(input, entry, snapshot).finally(() => {
        entry.refreshing = null;
      });
    }
    const empty = {
      fetchedAt: input.now.toISOString(),
      error: null,
      issues: [],
    };
    return { ...(snapshot ?? empty), refreshing: entry.refreshing !== null };
  }

  private file(projectId: string): string {
    return path.join(this.directory, `${encodeURIComponent(projectId)}.json`);
  }

  private async load(input: QueueRead): Promise<ProjectFactoryQueue | null> {
    try {
      const saved = SnapshotSchema.parse(
        JSON.parse(
          await queueDeadline(
            fs.readFile(this.file(input.projectId), "utf8"),
            "Saved queue read",
            1_000,
          ),
        ),
      );
      return saved.repository === input.repository && !saved.queue.partial ? saved.queue : null;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        this.logger.warn(
          { err: error, projectId: input.projectId },
          "Factory queue snapshot could not be read",
        );
      return null;
    }
  }

  private async refresh(
    input: QueueRead,
    entry: Entry,
    previous: ProjectFactoryQueue | null,
  ): Promise<void> {
    try {
      const result = await input.refresh();
      if (this.entries.get(input.projectId) !== entry) return;
      const degraded = result.error !== null || result.partial === true;
      const retained = entry.complete;
      const keepComplete = degraded && retained !== null;
      const snapshot = keepComplete
        ? {
            ...retained,
            error: result.error,
            ...(result.partial ? { partial: true } : {}),
            issueAgentHost: result.issueAgentHost ?? null,
            degraded: result.degraded,
          }
        : result;
      entry.snapshot = snapshot;
      if (!degraded) {
        entry.complete = result;
        try {
          await queueDeadline(
            writeJsonFileAtomic(this.file(input.projectId), {
              repository: input.repository,
              queue: snapshot,
            }),
            "Queue snapshot save",
            2_000,
          );
        } catch (error) {
          this.logger.warn(
            { err: error, projectId: input.projectId },
            "Fresh Factory queue could not be saved",
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const empty = { fetchedAt: input.now.toISOString(), issues: [] };
      entry.snapshot = {
        ...(entry.complete ?? previous ?? empty),
        error: message,
        issueAgentHost: null,
      };
      this.logger.warn({ err: error, projectId: input.projectId }, "Factory queue refresh failed");
    }
  }
}
