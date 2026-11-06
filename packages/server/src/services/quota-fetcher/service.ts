import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import {
  ClaudeLimitObservations,
  type UsageLimitStop,
} from "../../server/agent/providers/claude/limit-observation.js";
import type { ProviderApiFetch, ProviderUsageConfigMap, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";
import { ProviderUsageHistory } from "./usage-history.js";

/** Background readings keep the history going while no client is polling. */
const HISTORY_SAMPLE_INTERVAL_MS = 10 * 60 * 1000;

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  getProviderConfigs?: () => ProviderUsageConfigMap;
  createFetchers?: (providers?: ProviderUsageConfigMap) => ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  /** Defaults to a service-owned store fed by recordUsageLimitStop. */
  claudeLimitObservations?: ClaudeLimitObservations;
  cacheTtlMs?: number;
  now?: () => number;
  /** Where usage history persists across restarts; null keeps it in memory only. */
  historyFile?: string | null;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 2 * 60 * 1000;

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly getFetchers: () => ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;
  private generation = 0;
  private readonly claudeLimitObservations: ClaudeLimitObservations;
  private readonly history: ProviderUsageHistory;
  private sampler: ReturnType<typeof setInterval> | null = null;

  invalidate(): void {
    this.generation += 1;
    this.cached = null;
    this.inFlight = null;
  }

  /**
   * Records a live usage-limit stop for accounts whose credential cannot read usage.
   * Provider-specific parsing stays here so the daemon bootstrap remains provider-neutral.
   */
  recordUsageLimitStop(providerId: string, stop: UsageLimitStop): void {
    if (this.claudeLimitObservations.record(providerId, stop)) this.invalidate();
  }

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.claudeLimitObservations = options.claudeLimitObservations ?? new ClaudeLimitObservations();
    this.getFetchers = options.fetchers
      ? () => options.fetchers as ProviderUsageFetcher[]
      : () =>
          options.createFetchers?.(options.getProviderConfigs?.()) ??
          createProviderUsageFetchers({
            logger: this.logger,
            fetch: options.fetch,
            providers: options.getProviderConfigs?.(),
            claudeLimitObservations: this.claudeLimitObservations,
          });
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.history = new ProviderUsageHistory({
      file: options.historyFile ?? null,
      logger: this.logger,
      now: this.now,
    });
  }

  /**
   * Reads usage every ten minutes so the history keeps growing while nobody has the app open.
   * The two-minute cache absorbs overlap with client polls.
   */
  startHistorySampling(intervalMs = HISTORY_SAMPLE_INTERVAL_MS): void {
    if (this.sampler) return;
    this.sampler = setInterval(() => {
      void this.listUsage().catch((error: unknown) => {
        this.logger.debug({ err: error }, "Background usage sample failed");
      });
    }, intervalMs);
    this.sampler.unref?.();
  }

  async stopHistorySampling(): Promise<void> {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
    await this.history.flush();
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    if (
      !options?.forceRefresh &&
      this.cached &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchFreshUsage(nowMs);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshUsage(nowMs: number): Promise<ProviderUsageListResult> {
    const generation = this.generation;
    const fetchers = this.getFetchers();
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    try {
      await this.history.record(providers, nowMs);
    } catch (error) {
      this.logger.warn({ err: error }, "Could not record provider usage history");
    }
    const result = {
      fetchedAt: new Date(nowMs).toISOString(),
      providers: this.history.attach(providers),
    };
    if (generation === this.generation) this.cached = { fetchedAtMs: nowMs, result };
    return result;
  }
}
