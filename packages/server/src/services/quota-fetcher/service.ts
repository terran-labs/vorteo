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

/**
 * Background readings log usage every minute whether or not any client is open. Logging is
 * daemon-owned; clients only choose how often they refresh what they display.
 */
const HISTORY_SAMPLE_INTERVAL_MS = 60 * 1000;
/** A provider that rate-limits or fails waits twice as long each time, up to this. */
const MAX_BACKOFF_MS = 10 * 60 * 1000;

interface ProviderBackoff {
  intervalMs: number;
  retryAtMs: number;
}

/**
 * A reading that means the provider refused or failed: a fetch error, or a fetcher reporting
 * that the provider is limiting usage checks (Claude answers 429 that way, keeping its last good
 * reading). Missing credentials and expired sign-ins are not failures; asking again is cheap.
 */
function failedReading(usage: ProviderUsage): "rate-limited" | "failed" | null {
  if (usage.details?.some((detail) => detail.id.endsWith("-rate-limited"))) return "rate-limited";
  if (usage.status === "error")
    return /\b429\b|rate limit/i.test(usage.error ?? "") ? "rate-limited" : "failed";
  return null;
}

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
  private readonly sampleIntervalMs: number;
  /** Per provider ID: how long to wait after a refusal or failure, and until when. */
  private readonly backoff = new Map<string, ProviderBackoff>();
  /** Each provider's latest reading, served while it backs off. */
  private readonly lastReading = new Map<string, ProviderUsage>();

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
    this.sampleIntervalMs = HISTORY_SAMPLE_INTERVAL_MS;
    this.history = new ProviderUsageHistory({
      file: options.historyFile ?? null,
      logger: this.logger,
      now: this.now,
    });
  }

  /**
   * Reads usage every minute so the history keeps growing while nobody has the app open. Each
   * sample bypasses the two-minute cache so every minute gets a real reading; the reading then
   * refills the cache that client polls share. Providers in back-off are skipped.
   */
  startHistorySampling(intervalMs = this.sampleIntervalMs): void {
    if (this.sampler) return;
    this.sampler = setInterval(() => {
      void this.sampleUsage().catch((error: unknown) => {
        this.logger.debug({ err: error }, "Background usage sample failed");
      });
    }, intervalMs);
    this.sampler.unref?.();
  }

  /** One background reading, as the sampler takes it each minute. */
  sampleUsage(): Promise<ProviderUsageListResult> {
    return this.listUsage({ forceRefresh: true, background: true });
  }

  async stopHistorySampling(): Promise<void> {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
    await this.history.flush();
  }

  /**
   * `forceRefresh` bypasses the cache. A forced read from a client (a sign-in finishing, the
   * Refresh button) also skips back-off; the background sampler's never does.
   */
  async listUsage(options?: {
    forceRefresh?: boolean;
    background?: boolean;
  }): Promise<ProviderUsageListResult> {
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

    const respectBackoff = options?.background === true || options?.forceRefresh !== true;
    const request = this.fetchFreshUsage(nowMs, respectBackoff);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshUsage(
    nowMs: number,
    respectBackoff: boolean,
  ): Promise<ProviderUsageListResult> {
    const generation = this.generation;
    const fetchers = this.getFetchers();
    const settled = await Promise.allSettled(
      fetchers.map((fetcher) => {
        const waiting = respectBackoff ? this.backoff.get(fetcher.providerId) : undefined;
        const previous = this.lastReading.get(fetcher.providerId);
        if (waiting && nowMs < waiting.retryAtMs && previous) return null;
        return fetcher.fetchUsage();
      }),
    );
    const fresh: ProviderUsage[] = [];
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled" && result.value === null) {
        // Backing off: show the last reading, and log nothing new for this minute.
        return this.lastReading.get(fetcher.providerId)!;
      }
      let usage: ProviderUsage;
      if (result.status === "fulfilled" && result.value) {
        usage = result.value;
      } else {
        const reason = result.status === "rejected" ? result.reason : undefined;
        this.logger.debug(
          { err: reason, providerId: fetcher.providerId },
          "Provider usage fetch failed",
        );
        usage = unavailableUsage({
          providerId: fetcher.providerId,
          displayName: fetcher.displayName,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
      this.lastReading.set(fetcher.providerId, usage);
      if (this.updateBackoff(fetcher.providerId, usage, nowMs)) fresh.push(usage);
      return usage;
    });

    try {
      await this.history.record(fresh, nowMs);
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

  /**
   * Doubles a provider's wait after each refusal or failure, from twice the sample interval up
   * to ten minutes, and clears it on success. Returns whether the reading is good to log.
   */
  private updateBackoff(providerId: string, usage: ProviderUsage, nowMs: number): boolean {
    const failure = failedReading(usage);
    const previous = this.backoff.get(providerId);
    if (!failure) {
      if (previous) {
        this.backoff.delete(providerId);
        this.logger.info({ providerId }, "Provider usage checks resumed after back-off");
      }
      return true;
    }
    const intervalMs = Math.min(
      MAX_BACKOFF_MS,
      previous ? previous.intervalMs * 2 : this.sampleIntervalMs * 2,
    );
    this.backoff.set(providerId, { intervalMs, retryAtMs: nowMs + intervalMs });
    this.logger.info(
      { providerId, reason: failure, backoffMs: intervalMs },
      "Provider usage checks backing off",
    );
    return false;
  }
}
