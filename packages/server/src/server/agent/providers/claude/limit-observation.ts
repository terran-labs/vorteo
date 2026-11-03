import type { UsageLimitReport } from "../../agent-sdk-types.js";

/** Which Claude allowance a limit message named, when it named one. */
export type ClaudeLimitWindow = "weekly" | "session";

/** The latest usage-limit stop an account reported, standing in for usage it cannot read. */
export interface ClaudeLimitObservation {
  window: ClaudeLimitWindow | null;
  resetsAt: string | null;
  observedAt: string;
}

interface ParsedLimitMessage {
  window: ClaudeLimitWindow | null;
  resetsAt: string | null;
}

/** The parts of a failed turn that describe a usage-limit stop. */
export interface UsageLimitStop {
  error: string;
  usageLimit?: UsageLimitReport;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_RESET_RETENTION_MS = 7 * DAY_MS;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const LIMIT_PATTERN = /\bhit your\b[^·\n]*\blimit\b/i;
// "resets 11pm (America/Los_Angeles)", "resets Nov 8, 8:30am (Europe/London)".
const RESET_PATTERN =
  /\bresets\s+(?:(?<month>[a-z]{3,9})\s+(?<day>\d{1,2}),?\s+(?:at\s+)?)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)\s*\((?<zone>[^)]+)\)/i;

function windowFromText(text: string): ClaudeLimitWindow | null {
  if (/\bweekly\b/i.test(text)) return "weekly";
  if (/\b(session|5-hour|five-hour)\b/i.test(text)) return "session";
  return null;
}

/** SDK rate-limit types: `five_hour`, `seven_day`, `seven_day_opus` and similar. */
function windowFromReport(window: string | undefined): ClaudeLimitWindow | null {
  if (!window) return null;
  if (window.startsWith("seven_day")) return "weekly";
  if (window === "five_hour") return "session";
  return null;
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function wallTimeIn(zone: string, utcMs: number): WallTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(utcMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function wallTimeAsUtc(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** The instant a zone's clock shows `wall`, corrected once for a DST change between guesses. */
function instantOf(wall: WallTime, zone: string): number {
  const naive = wallTimeAsUtc(wall);
  const firstOffset = wallTimeAsUtc(wallTimeIn(zone, naive)) - naive;
  const guess = naive - firstOffset;
  const offset = wallTimeAsUtc(wallTimeIn(zone, guess)) - guess;
  return naive - offset;
}

function resetFromText(text: string, nowMs: number): string | null {
  const groups = RESET_PATTERN.exec(text)?.groups;
  if (!groups?.hour || !groups.meridiem || !groups.zone) return null;
  const zone = groups.zone.trim();
  if (!isTimeZone(zone)) return null;
  const hour12 = Number(groups.hour);
  const minute = groups.minute ? Number(groups.minute) : 0;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (groups.meridiem.toLowerCase() === "pm" ? 12 : 0);
  const today = wallTimeIn(zone, nowMs);
  if (groups.month) {
    const month = MONTHS.indexOf(groups.month.slice(0, 3).toLowerCase()) + 1;
    const day = Number(groups.day);
    if (month === 0 || day < 1 || day > 31) return null;
    const thisYear = instantOf({ year: today.year, month, day, hour, minute }, zone);
    const reset =
      thisYear > nowMs
        ? thisYear
        : instantOf({ year: today.year + 1, month, day, hour, minute }, zone);
    return new Date(reset).toISOString();
  }
  const sameDay = instantOf({ ...today, hour, minute }, zone);
  if (sameDay > nowMs) return new Date(sameDay).toISOString();
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const nextDay = instantOf(
    {
      year: tomorrow.getUTCFullYear(),
      month: tomorrow.getUTCMonth() + 1,
      day: tomorrow.getUTCDate(),
      hour,
      minute,
    },
    zone,
  );
  return new Date(nextDay).toISOString();
}

/**
 * Reads Claude's limit message, such as "You've hit your weekly limit · resets 11pm
 * (America/Los_Angeles)". A reset time is the next future occurrence in the named zone, and
 * null when the message names no zone or cannot be read.
 */
export function parseClaudeLimitMessage(text: string, nowMs: number): ParsedLimitMessage | null {
  if (!LIMIT_PATTERN.test(text)) return null;
  return { window: windowFromText(text), resetsAt: resetFromText(text, nowMs) };
}

export type ClaudeLimitObservationReader = Pick<ClaudeLimitObservations, "read">;

/** The latest usage-limit stop per provider account, kept until the limit should have reset. */
export class ClaudeLimitObservations {
  private readonly latest = new Map<string, ClaudeLimitObservation>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Records a stop when it describes a Claude usage limit. Returns whether it did. */
  record(providerId: string, stop: UsageLimitStop): boolean {
    const nowMs = this.now();
    const parsed = parseClaudeLimitMessage(stop.error, nowMs);
    const report = stop.usageLimit;
    const reported = Boolean(report?.resetsAt || report?.window);
    if (!parsed && !reported) return false;
    // The SDK's own reset time is exact; the message's is read from a clock time.
    const reportedReset =
      report?.resetsAt && Date.parse(report.resetsAt) > nowMs ? report.resetsAt : null;
    this.latest.set(providerId, {
      window: windowFromReport(report?.window) ?? parsed?.window ?? null,
      resetsAt: reportedReset ?? parsed?.resetsAt ?? null,
      observedAt: new Date(nowMs).toISOString(),
    });
    return true;
  }

  /** The account's latest stop, or null once its reset passed or, without one, after 7 days. */
  read(providerId: string): ClaudeLimitObservation | null {
    const observation = this.latest.get(providerId);
    if (!observation) return null;
    const expiresAt = observation.resetsAt
      ? Date.parse(observation.resetsAt)
      : Date.parse(observation.observedAt) + UNKNOWN_RESET_RETENTION_MS;
    if (this.now() < expiresAt) return observation;
    this.latest.delete(providerId);
    return null;
  }
}
