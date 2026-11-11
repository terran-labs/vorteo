import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractAttention,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";
import { restoreStoredUsage } from "./agent-projections.js";

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

interface PendingAgentInitialization {
  promise: Promise<ManagedAgent>;
  options: { broadcastTimeline: boolean };
}

const pendingAgentInitializations = new Map<string, PendingAgentInitialization>();

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "needsTimelineHydration"
  | "resumeAgentFromPersistence"
  | "retryTimelineHydration"
> &
  Partial<Pick<AgentManager, "waitForAgentClose">>;

const TIMELINE_FAILURE_RETRY_MS = 30_000;
const MAX_TIMELINE_FAILURES = 1024;
interface TimelineHistoryResult {
  saved: AgentTimelineRow[];
  native: ManagedAgent;
}
interface TimelineHistoryLoads {
  failures: Map<string, { retryAt: number; message: string }>;
  pending: Map<string, Promise<TimelineHistoryResult[keyof TimelineHistoryResult]>>;
}
const timelineHistoryLoads = new WeakMap<AgentLoaderManager, TimelineHistoryLoads>();

export class TimelineHistoryRetryError extends Error {}

/** Coalesce concurrent polling and limit repeated failures without delaying interactive loads. */
export async function loadTimelineHistory<Source extends keyof TimelineHistoryResult>(
  manager: AgentLoaderManager,
  agentId: string,
  source: Source,
  load: () => Promise<TimelineHistoryResult[Source]>,
): Promise<TimelineHistoryResult[Source]> {
  let loads = timelineHistoryLoads.get(manager);
  if (!loads) {
    loads = { failures: new Map(), pending: new Map() };
    timelineHistoryLoads.set(manager, loads);
  }
  const { failures, pending } = loads;
  const key = `${source}:${agentId}`;
  // The source prefix binds every pending value to its corresponding result type.
  const inflight = pending.get(key) as Promise<TimelineHistoryResult[Source]> | undefined;
  if (inflight) return inflight;
  const failure = failures.get(key);
  if (failure && performance.now() < failure.retryAt) {
    throw new TimelineHistoryRetryError(failure.message);
  }
  const attempt = Promise.resolve().then(load);
  pending.set(key, attempt);
  try {
    const value = await attempt;
    failures.delete(key);
    return value;
  } catch (error) {
    failures.delete(key);
    failures.set(key, {
      retryAt: performance.now() + TIMELINE_FAILURE_RETRY_MS,
      message: error instanceof Error ? error.message : String(error),
    });
    if (failures.size > MAX_TIMELINE_FAILURES) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
    throw error;
  } finally {
    pending.delete(key);
  }
}

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  broadcastTimeline?: boolean;
  logger: Logger;
}

export async function ensureUnarchivedAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps & {
    agentManager: AgentLoaderManager & Pick<AgentManager, "closeAgent">;
  },
): Promise<ManagedAgent> {
  const record = await deps.agentStorage.get(agentId);
  if (record?.archivedAt) {
    throw new Error(`Agent is archived: ${agentId}`);
  }

  const agent = await ensureAgentLoaded(agentId, deps);
  // A shared resume may finish before an archive queued behind it commits.
  await deps.agentManager.waitForAgentClose?.(agentId);
  const latestRecord = await deps.agentStorage.get(agentId);
  if (latestRecord?.archivedAt) {
    await deps.agentManager.closeAgent(agentId).catch((error: unknown) => {
      deps.logger.warn({ err: error, agentId }, "Failed to close concurrently archived agent");
    });
    throw new Error(`Agent is archived: ${agentId}`);
  }

  return agent;
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  await deps.agentManager.waitForAgentClose?.(agentId);

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) {
    inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return inflight.promise;
  }

  const existing = deps.agentManager.getAgent(agentId);
  if (existing) {
    if (!deps.agentManager.needsTimelineHydration(agentId)) {
      return existing;
    }
    // Registered, but its history read failed. Retry it, or the thread stays empty.
    return trackInitialization(agentId, deps, async (options) => {
      await deps.agentManager.retryTimelineHydration(agentId, {
        broadcast: () => options.broadcastTimeline,
      });
      return deps.agentManager.getAgent(agentId) ?? existing;
    });
  }

  // A close may have started after the first barrier observed no in-flight
  // work. Once the live lookup is empty, this second barrier closes that gap
  // before storage-backed resume begins.
  await deps.agentManager.waitForAgentClose?.(agentId);

  const laterInflight = pendingAgentInitializations.get(agentId);
  if (laterInflight) {
    laterInflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return laterInflight.promise;
  }

  return trackInitialization(agentId, deps, async (pendingOptions) => {
    const record = await deps.agentStorage.get(agentId);
    if (!record) {
      throw new AgentNotFoundError(agentId);
    }

    const validProviders = deps.validProviders ?? deps.agentManager.getRegisteredProviderIds();
    if (!isStoredAgentProviderAvailable(record, validProviders)) {
      throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
    }

    const handle = toAgentPersistenceHandle(validProviders, record.persistence);

    let snapshot: ManagedAgent;
    if (handle) {
      snapshot = await deps.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        agentId,
        {
          ...extractTimestamps(record),
          attention: extractAttention(record),
          lastUsage: restoreStoredUsage(record),
        },
        record.archivedAt ? { purpose: "history" } : undefined,
      );
      deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
    } else {
      // No provider handle to resume: this starts the agent's first session rather than
      // bringing one back, so it stamps activity and carries no stored attention. Records
      // without a handle never got far enough to accumulate either.
      const config = buildSessionConfig(record, {
        validProviders,
      });
      if (!config) {
        throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
      }
      snapshot = await deps.agentManager.createAgent(config, agentId, {
        labels: record.labels,
        workspaceId: record.workspaceId,
        owner: record.owner,
        env: record.launchEnv,
      });
      deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    }

    await deps.agentManager.hydrateTimelineFromProvider(agentId, {
      broadcast: () => pendingOptions.broadcastTimeline,
    });
    return deps.agentManager.getAgent(agentId) ?? snapshot;
  });
}

/** Shares one load per agent, so concurrent requests cannot hydrate twice. */
async function trackInitialization(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
  load: (options: PendingAgentInitialization["options"]) => Promise<ManagedAgent>,
): Promise<ManagedAgent> {
  const options = { broadcastTimeline: deps.broadcastTimeline === true };
  const pending: PendingAgentInitialization = { promise: load(options), options };
  pendingAgentInitializations.set(agentId, pending);

  try {
    return await pending.promise;
  } finally {
    const current = pendingAgentInitializations.get(agentId);
    if (current === pending) {
      pendingAgentInitializations.delete(agentId);
    }
  }
}
