import type { DashboardSample } from "@getpaseo/protocol/messages";

export const DASHBOARD_HOUR_MS = 3_600_000;
const INTERVAL_IDS = ["intervalTokens", "intervalApiUsd"] as const;

export function isDashboardIntervalMetric(id: string): id is (typeof INTERVAL_IDS)[number] {
  return INTERVAL_IDS.some((metric) => id === metric);
}

interface IntervalObservation {
  sum: number;
  hours: number;
}

export interface DashboardBucket {
  start: number;
  sample: DashboardSample | undefined;
  intervals?: Map<string, IntervalObservation>;
}

export function getDashboardWindow(samples: readonly DashboardSample[], days: number) {
  const bucketMs = days === 1 ? DASHBOARD_HOUR_MS : 24 * DASHBOARD_HOUR_MS;
  const bucketCount = days === 1 ? 24 : days;
  const byHour = new Map<number, DashboardSample>();
  let lastHour = -Infinity;

  for (const sample of samples) {
    const hour = Math.floor(Date.parse(sample.at) / DASHBOARD_HOUR_MS);
    const previous = byHour.get(hour);
    if (!previous || sample.at > previous.at) byHour.set(hour, sample);
    lastHour = Math.max(lastHour, hour);
  }

  const latest = byHour.get(lastHour);
  if (!latest) return { latest, points: [], keys: [] };

  const hoursPerBucket = days === 1 ? 1 : 24;
  const lastBucket = Math.floor(lastHour / hoursPerBucket);
  const firstBucket = lastBucket - bucketCount + 1;
  const keys = new Set<string>();
  const points: DashboardBucket[] = Array.from({ length: bucketCount }, (_, index) => {
    const bucket = firstBucket + index;
    const point: DashboardBucket = {
      start: bucket * bucketMs,
      sample: undefined,
      intervals: days === 1 ? undefined : new Map(),
    };
    for (let offset = 0; offset < hoursPerBucket; offset++) {
      const sample = byHour.get(bucket * hoursPerBucket + offset);
      if (!sample) continue;
      point.sample = sample;
      for (const key of Object.keys(sample.values)) keys.add(key);
      if (point.intervals) addIntervalObservation(point.intervals, sample);
    }
    return point;
  });
  return { latest, points, keys: [...keys] };
}

function addIntervalObservation(totals: Map<string, IntervalObservation>, sample: DashboardSample) {
  for (const id of INTERVAL_IDS) {
    const value = sample.values[id];
    if (value === undefined) continue;
    const previous = totals.get(id);
    totals.set(id, { sum: (previous?.sum ?? 0) + value, hours: (previous?.hours ?? 0) + 1 });
  }
}
