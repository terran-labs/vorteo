import { isAbsolute } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  executableExists,
  findExecutable,
} from "../../../executable-resolution/executable-resolution.js";
import type { ProviderUsage, ProviderUsageWindow } from "../../../server/messages.js";
import { spawnProcess } from "../../../utils/spawn.js";
import type { ProviderUsageFetcher } from "../provider.js";
import { ApiNumberSchema, toneFromUsedPct, unavailableUsage, windowFromUsedPct } from "../usage.js";

const ANTIGRAVITY_USAGE_TIMEOUT_MS = 15_000;
const ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const AUTH_ERROR_PATTERN =
  /auth(?:entication)?\s*(?:required|failed|expired)|sign[\s.-]?in|log[\s.-]?in|unauthenticated|not signed in/i;
const NO_QUOTA_PATTERN = /no account quota|gemini_api_key|api key/i;

const AntigravityQuotaBucketSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  window: z.string().optional(),
  remaining_fraction: ApiNumberSchema.nullish(),
  reset_time: z.string().nullish(),
});

const AntigravityQuotaGroupSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  buckets: z.array(AntigravityQuotaBucketSchema).default([]),
});

const AntigravityUsageResponseSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  command: z
    .object({
      name: z.string().optional(),
      data: z
        .object({
          groups: z.array(AntigravityQuotaGroupSchema).default([]),
        })
        .nullish(),
    })
    .nullish(),
});

type AntigravityQuotaBucket = z.infer<typeof AntigravityQuotaBucketSchema>;
type AntigravityQuotaGroup = z.infer<typeof AntigravityQuotaGroupSchema>;

export interface AntigravityCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type AntigravityCommandRunner = (
  command: string,
  args: string[],
  env?: Record<string, string>,
) => Promise<AntigravityCommandResult>;

export type AntigravityExecutableResolver = (
  command: string,
  env?: Record<string, string>,
) => Promise<string | null>;

interface AntigravityQuotaProviderOptions {
  logger: Logger;
  providerId?: string;
  displayName?: string;
  command?: string[];
  env?: Record<string, string>;
  resolveExecutable?: AntigravityExecutableResolver;
  runCommand?: AntigravityCommandRunner;
  now?: () => number;
}

interface ParsedWindowSpec {
  label: string;
  windowMs: number | null;
  order: number;
}

type ParsedUsageOutcome =
  | { kind: "available"; windows: ProviderUsageWindow[] }
  | { kind: "unavailable" }
  | { kind: "error"; error: string };

function normalizeGroupLabel(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.replace(/\s+models$/i, "").trim();
}

function normalizeFallbackBucketName(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return "Quota";
  return (
    trimmed
      .replace(/\s+limit\s+remaining$/i, "")
      .replace(/\s+remaining$/i, "")
      .trim() || trimmed
  );
}

function describeWindow(bucket: AntigravityQuotaBucket): ParsedWindowSpec {
  const raw = bucket.window?.trim().toLowerCase() ?? "";
  if (raw === "weekly") return { label: "Weekly", windowMs: WEEK_MS, order: 2 };
  if (raw === "daily") return { label: "Daily", windowMs: DAY_MS, order: 2 };
  const hours = /^(\d+)h$/.exec(raw);
  if (hours) {
    const count = Number(hours[1]);
    return { label: `${count}-hour`, windowMs: count * HOUR_MS, order: 1 };
  }
  const days = /^(\d+)d$/.exec(raw);
  if (days) {
    const count = Number(days[1]);
    return { label: `${count}-day`, windowMs: count * DAY_MS, order: 2 };
  }
  return { label: normalizeFallbackBucketName(bucket.name), windowMs: null, order: 3 };
}

function normalizeResetTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  // Antigravity returns the Unix epoch for buckets whose rolling window has not started yet.
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Date(parsed).toISOString();
}

function normalizeIdPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "window"
  );
}

function uniqueWindowId(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  for (let suffix = 2; ; suffix += 1) {
    const next = `${candidate}_${suffix}`;
    if (!taken.has(next)) {
      taken.add(next);
      return next;
    }
  }
}

function clampUsedPct(remainingFraction: number | null | undefined): number | null {
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return null;
  const clampedRemaining = Math.min(1, Math.max(0, remainingFraction));
  return Math.round((1 - clampedRemaining) * 10_000) / 100;
}

function parseGroupWindows(
  group: AntigravityQuotaGroup,
  multipleGroups: boolean,
  takenIds: Set<string>,
  now: number,
): ProviderUsageWindow[] {
  const groupLabel = normalizeGroupLabel(group.name);
  const orderedBuckets = group.buckets
    .map((bucket, index) => ({ bucket, index, spec: describeWindow(bucket) }))
    .sort((left, right) => left.spec.order - right.spec.order || left.index - right.index);

  const windows: ProviderUsageWindow[] = [];
  for (const { bucket, spec } of orderedBuckets) {
    const usedPct = clampUsedPct(bucket.remaining_fraction);
    if (usedPct === null) continue;
    const baseId =
      bucket.id?.trim() ||
      `${normalizeIdPart(groupLabel || "antigravity")}_${normalizeIdPart(bucket.window || spec.label)}`;
    const id = uniqueWindowId(baseId, takenIds);
    const label = multipleGroups && groupLabel ? `${spec.label} \u00b7 ${groupLabel}` : spec.label;
    windows.push(
      windowFromUsedPct({
        id,
        label,
        utilizationPct: usedPct,
        resetsAt: normalizeResetTime(bucket.reset_time),
        windowMs: spec.windowMs,
        tone: toneFromUsedPct(usedPct),
        now,
      }),
    );
  }
  return windows;
}

export function parseAntigravityUsageOutput(stdout: string, now = Date.now()): ParsedUsageOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { kind: "error", error: "Invalid Antigravity usage output" };
  }
  const parsed = AntigravityUsageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "error", error: "Unexpected Antigravity usage payload" };
  }
  if (parsed.data.status !== "SUCCESS") {
    const message = parsed.data.error?.trim() || `Antigravity usage returned ${parsed.data.status}`;
    if (AUTH_ERROR_PATTERN.test(message) || NO_QUOTA_PATTERN.test(message)) {
      return { kind: "unavailable" };
    }
    return { kind: "error", error: message };
  }

  const groups = parsed.data.command?.data?.groups ?? [];
  const multipleGroups = groups.length > 1;
  const takenIds = new Set<string>();
  const windows = groups.flatMap((group) =>
    parseGroupWindows(group, multipleGroups, takenIds, now),
  );

  if (windows.length === 0) return { kind: "unavailable" };
  return { kind: "available", windows };
}

async function defaultResolveExecutable(
  command: string,
  env?: Record<string, string>,
): Promise<string | null> {
  const found = await findExecutable(command, { env });
  if (found) return found;
  if (isAbsolute(command)) return executableExists(command);
  return null;
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

function defaultRunCommand(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<AntigravityCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      envOverlay: env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessGroup(child.pid);
      reject(new Error("Antigravity usage check timed out"));
    }, ANTIGRAVITY_USAGE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export class AntigravityQuotaProvider implements ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;

  private readonly logger: Logger;
  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly env?: Record<string, string>;
  private readonly resolveExecutable: AntigravityExecutableResolver;
  private readonly runCommand: AntigravityCommandRunner;
  private readonly now: () => number;

  constructor(options: AntigravityQuotaProviderOptions) {
    this.logger = options.logger;
    this.providerId = options.providerId ?? "antigravity";
    this.displayName = options.displayName ?? "Antigravity";
    const configuredCommand = options.command;
    this.command = configuredCommand?.[0] ?? "agy";
    this.prefixArgs = configuredCommand?.slice(1) ?? [];
    this.env = options.env;
    this.resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.now = options.now ?? Date.now;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const resolved = await this.resolveExecutable(this.command, this.env);
    if (!resolved) return unavailableUsage(this);

    const args = [...this.prefixArgs, "-p", "/usage", "--output-format", "json"];
    const result = await this.runCommand(resolved, args, this.env);

    // Exit code 2 indicates an account mode without quota (for example GEMINI_API_KEY).
    if (result.code === 2) return unavailableUsage(this);

    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      if (AUTH_ERROR_PATTERN.test(detail) || NO_QUOTA_PATTERN.test(detail)) {
        return unavailableUsage(this);
      }
      const error = detail || `Antigravity CLI exited with code ${result.code ?? "unknown"}`;
      this.logger.debug(
        { providerId: this.providerId, code: result.code },
        "Antigravity usage fetch failed",
      );
      return unavailableUsage({ ...this, error });
    }

    const parsed = parseAntigravityUsageOutput(result.stdout, this.now());
    if (parsed.kind === "unavailable") return unavailableUsage(this);
    if (parsed.kind === "error") {
      this.logger.debug(
        { providerId: this.providerId, error: parsed.error },
        "Antigravity usage output could not be parsed",
      );
      return unavailableUsage({ ...this, error: parsed.error });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      sourceLabel: "Antigravity CLI",
      windows: parsed.windows,
      balances: [],
      details: [],
      error: null,
    };
  }
}
