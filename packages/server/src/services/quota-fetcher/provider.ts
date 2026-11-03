import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import type { ClaudeLimitObservationReader } from "../../server/agent/providers/claude/limit-observation.js";

export type ProviderApiFetch = typeof fetch;

export interface ProviderUsageConfig {
  extends?: string;
  label?: string;
  env?: Record<string, string>;
  enabled?: boolean;
}

export type ProviderUsageConfigMap = Record<string, ProviderUsageConfig>;

export interface ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  fetchUsage(): Promise<ProviderUsage>;
}

export interface ProviderUsageFetcherFactoryOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  providers?: ProviderUsageConfigMap;
  /** Last usage-limit stops, shown for Claude accounts whose credential cannot read usage. */
  claudeLimitObservations?: ClaudeLimitObservationReader;
}

export interface ProviderUsageFetcherManifestEntry {
  readonly providerId: string;
  create(options: ProviderUsageFetcherFactoryOptions): ProviderUsageFetcher;
}
