interface SessionUsageRecord {
  persistence?: { provider: string; sessionId: string } | null;
  runtimeInfo?: { model?: string | null };
  lastUsage?: Record<string, number>;
}

interface Counters {
  tokens?: number;
  cost?: number;
  pricing: string;
}

function addDelta(
  values: Record<string, number>,
  key: string,
  previous?: number,
  current?: number,
) {
  if (previous !== undefined && current !== undefined && current >= previous)
    values[key] = (values[key] ?? 0) + (current - previous);
}

/** Measure only counters observed in the same provider session in consecutive UTC hours. */
export function createDashboardIntervalUsage() {
  let previous = new Map<string, Counters>();
  let previousAt: number | undefined;
  return function sample(
    records: readonly SessionUsageRecord[],
    now: number,
    lastRecordedAt?: string,
  ) {
    const hour = Math.floor(now / 3_600_000);
    const current = new Map<string, Counters>();
    const values: Record<string, number> = {};
    for (const { persistence, runtimeInfo, lastUsage } of records) {
      // Only the Codex adapter currently pairs a cumulative token count with a session estimate.
      if (!persistence || lastUsage?.sessionTokens === undefined) continue;
      const key = JSON.stringify([persistence.provider, persistence.sessionId]);
      const next = {
        tokens: lastUsage.sessionTokens,
        cost: lastUsage.estimatedCostUsd,
        pricing: runtimeInfo?.model ?? "",
      };
      current.set(key, next);
    }
    if (
      previousAt !== undefined &&
      lastRecordedAt === new Date(previousAt).toISOString() &&
      Math.floor(previousAt / 3_600_000) === hour - 1
    ) {
      for (const [key, next] of current) {
        const prior = previous.get(key);
        if (!prior) continue;
        addDelta(values, "intervalTokens", prior.tokens, next.tokens);
        if (next.pricing === prior.pricing)
          addDelta(values, "intervalApiUsd", prior.cost, next.cost);
      }
    }
    previous = current;
    previousAt = now;
    return values;
  };
}
