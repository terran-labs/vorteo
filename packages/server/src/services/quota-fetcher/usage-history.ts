import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../../server/messages.js";

/** Long enough for a weekly window plus a day of the previous one. */
const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
/**
 * One sample per five-minute bucket: a reading replaces the latest sample only when both fall in
 * the same bucket. The buckets are fixed, so frequent polling cannot keep sliding one sample
 * forward and stop the series from growing.
 */
const SAMPLE_BUCKET_MS = 5 * 60 * 1000;
/** Points sent per window; the sidebar chart is a few dozen pixels wide. */
const MAX_SENT_POINTS = 96;
const WRITE_DELAY_MS = 5_000;

const FileSchema = z.object({
  version: z.literal(1),
  /** `${providerId}\u0000${windowId}` to [epoch ms, used percent] pairs, oldest first. */
  series: z.record(z.string(), z.array(z.tuple([z.number(), z.number()]))),
});

function windowUsed(window: ProviderUsageWindow): number | null {
  let used: number | null = null;
  if (typeof window.usedPct === "number") used = window.usedPct;
  else if (typeof window.remainingPct === "number") used = 100 - window.remainingPct;
  return used !== null && Number.isFinite(used) ? Math.min(100, Math.max(0, used)) : null;
}

/** Evenly thins a series to at most `max` points, always keeping the newest. */
function thin(points: readonly [number, number][], max: number): [number, number][] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => points[Math.round(index * step)]!);
}

/**
 * Each account window's used percent over time, so clients can draw how usage climbed rather
 * than only where it stands. Fed by every fresh usage fetch and kept across daemon restarts.
 */
export class ProviderUsageHistory {
  private series = new Map<string, [number, number][]>();
  private loaded: Promise<void> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: { file: string | null; logger: Logger; now?: () => number },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Loads saved samples once; a missing or unreadable file starts an empty history. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.options.file) return;
      try {
        const parsed = FileSchema.safeParse(JSON.parse(await readFile(this.options.file, "utf8")));
        if (parsed.success) this.series = new Map(Object.entries(parsed.data.series));
      } catch {
        // First run, or a damaged file: history rebuilds from the next readings.
      }
    })();
    return this.loaded;
  }

  async record(providers: readonly ProviderUsage[], at = this.now()): Promise<void> {
    await this.load();
    const cutoff = at - RETENTION_MS;
    let changed = false;
    for (const provider of providers) {
      if (provider.status !== "available") continue;
      for (const window of provider.windows) {
        const used = windowUsed(window);
        if (used === null) continue;
        const key = `${provider.providerId}\u0000${window.id}`;
        const points = (this.series.get(key) ?? []).filter(([time]) => time >= cutoff);
        const last = points[points.length - 1];
        const sameBucket =
          last && Math.floor(last[0] / SAMPLE_BUCKET_MS) === Math.floor(at / SAMPLE_BUCKET_MS);
        if (sameBucket) points[points.length - 1] = [at, used];
        else points.push([at, used]);
        this.series.set(key, points);
        changed = true;
      }
    }
    if (changed) this.scheduleWrite();
  }

  /** The providers with each window's recent history attached, thinned for the wire. */
  attach(providers: readonly ProviderUsage[]): ProviderUsage[] {
    return providers.map((provider) => ({
      ...provider,
      windows: provider.windows.map((window) => {
        const points = this.series.get(`${provider.providerId}\u0000${window.id}`);
        // One reading is a position, not a history; clients fall back to the average pace.
        if (!points || points.length < 2) return window;
        return {
          ...window,
          history: thin(points, MAX_SENT_POINTS).map(([time, usedPct]) => ({
            at: new Date(time).toISOString(),
            usedPct,
          })),
        };
      }),
    }));
  }

  private scheduleWrite(): void {
    if (!this.options.file || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, WRITE_DELAY_MS);
    this.writeTimer.unref?.();
  }

  /** Writes atomically so a crash never leaves a half-written file. */
  async flush(): Promise<void> {
    const file = this.options.file;
    if (!file) return;
    const body = JSON.stringify({ version: 1, series: Object.fromEntries(this.series) });
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, body, "utf8");
      await rename(`${file}.tmp`, file);
    } catch (error) {
      this.options.logger.warn({ err: error }, "Could not save provider usage history");
    }
  }
}
