import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  executableExists,
  findExecutableWithoutProbing,
} from "../../../executable-resolution/executable-resolution.js";
import type { ProviderUsage, ProviderUsageWindow } from "../../../server/messages.js";
import { spawnProcess } from "../../../utils/spawn.js";
import type { ProviderUsageFetcher, ProviderUsageFetchOptions } from "../provider.js";
import { ApiNumberSchema, toneFromUsedPct, unavailableUsage, windowFromUsedPct } from "../usage.js";

const ANTIGRAVITY_USAGE_TIMEOUT_MS = 15_000;
const ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES = 1024 * 1024;
export const ANTIGRAVITY_MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const AUTH_ERROR_PATTERN =
  /\b(?:authentication\s+(?:required|failed|expired)|not\s+(?:logged|signed)\s+in(?:to\b)?|unauthenticated|please\s+(?:log|sign)\s+in|run\s+['`"]?agy['`"]?\s+to\s+(?:log|sign)\s+in|visit\s+the\s+url\s+to\s+log\s+in)\b/i;
const NO_QUOTA_PATTERN =
  /\b(?:no\s+account\s+quota|has\s+no\s+account\s+quota|no\s+usage\s+quota)\b/i;
const UNKNOWN_FLAG_PATTERN = /flag provided but not defined|unknown flag/i;

// Global agy flags that consume the following token as a value (from `agy --help`).
const AGY_VALUE_FLAGS = new Set([
  "--add-dir",
  "--agent",
  "--conversation",
  "-r",
  "--resume",
  "--effort",
  "--input-format",
  "--json-schema",
  "--log-file",
  "--mode",
  "--model",
  "--output-format",
  "-p",
  "--print",
  "--prompt",
  "-i",
  "--prompt-interactive",
  "--print-timeout",
  "--project",
  "--settings",
]);

// `agy acp` flags that consume the following token as a value (from `agy acp --help`).
const AGY_ACP_VALUE_FLAGS = new Set([
  "--add-dir",
  "--agent",
  "--app-data-dir",
  "--app_data_dir",
  "--cli_dir_name",
  "--cli_log_file",
  "--cloud_code_endpoint",
  "--gemini-dir",
  "--gemini_dir",
  "--ide-mcp-port",
  "--ide_mcp_port",
  "--log-file",
  "--override_user_agent_name",
]);

function isTrailingSubcommandArgs(tail: readonly string[]): boolean {
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index]!;
    if (token === "--" || !token.startsWith("-")) return false;
    if (!token.includes("=") && AGY_ACP_VALUE_FLAGS.has(token)) {
      if (index + 1 >= tail.length) return false;
      index += 1;
    }
  }
  return true;
}

function stripAcpSubcommand(args: readonly string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if (token === "--") break;
    if (token === "acp" && isTrailingSubcommandArgs(args.slice(index + 1))) {
      return args.slice(0, index);
    }
    if (!token.includes("=") && AGY_VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    index += 1;
  }
  return [...args];
}

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

export interface AntigravityCommandOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type AntigravityCommandRunner = (
  command: string,
  args: string[],
  options: AntigravityCommandOptions,
) => Promise<AntigravityCommandResult>;

export type AntigravityExecutableResolver = (
  command: string,
  env?: Record<string, string>,
) => Promise<string | null>;

export interface AntigravityCachedReading {
  providerId: string;
  fetchedAtMs: number;
  usage: ProviderUsage;
}

export interface AntigravityUsageCache {
  readings: Map<string, AntigravityCachedReading>;
  inFlight: Map<string, Promise<ProviderUsage>>;
}

export function createAntigravityUsageCache(): AntigravityUsageCache {
  return {
    readings: new Map(),
    inFlight: new Map(),
  };
}

const sharedAntigravityUsageCache = createAntigravityUsageCache();

export function invalidateAntigravityUsageCache(
  providerId?: string,
  cache: AntigravityUsageCache = sharedAntigravityUsageCache,
): void {
  if (providerId === undefined) {
    cache.readings.clear();
    return;
  }
  for (const [key, entry] of cache.readings) {
    if (entry.providerId === providerId) cache.readings.delete(key);
  }
}

interface AntigravityQuotaProviderOptions {
  logger: Logger;
  providerId?: string;
  displayName?: string;
  command?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  minPollIntervalMs?: number;
  cache?: AntigravityUsageCache;
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

export function isAntigravitySignedOutOrNoQuota(text: string): boolean {
  return AUTH_ERROR_PATTERN.test(text) || NO_QUOTA_PATTERN.test(text);
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
    const rawError = parsed.data.error?.trim() ?? "";
    if (rawError && isAntigravitySignedOutOrNoQuota(rawError)) {
      return { kind: "unavailable" };
    }
    return { kind: "error", error: `Antigravity usage returned ${parsed.data.status}` };
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
  const pathOverride = env?.["PATH"] ?? env?.["Path"];
  const found = await findExecutableWithoutProbing(command, {
    ...(pathOverride !== undefined ? { path: pathOverride } : {}),
    cwd: tmpdir(),
  });
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
    // Process group already exited.
  }
}

function nullLogPath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function usageProbeEnv(env?: Record<string, string>): Record<string, string> {
  // Suppresses interactive browser launch (`open <oauth-url>`) when agy is signed out.
  if (env?.["SSH_CONNECTION"]) return env;
  return { ...env, SSH_CONNECTION: "1 2 3 4" };
}

function buildCacheKey(
  providerId: string,
  command: string,
  prefixArgs: readonly string[],
  env?: Record<string, string>,
): string {
  const sortedEnv = env
    ? Object.entries(env).sort(([left], [right]) => left.localeCompare(right))
    : [];
  return JSON.stringify([providerId, command, prefixArgs, sortedEnv]);
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: AntigravityCommandOptions,
): Promise<AntigravityCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      envOverlay: usageProbeEnv(options.env),
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
      if (AUTH_ERROR_PATTERN.test(stderr)) {
        resolve({ code: 1, stdout, stderr });
        return;
      }
      reject(new Error("Antigravity usage check timed out"));
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = options.maxOutputBytes - stdout.length;
      if (remaining > 0) {
        stdout += chunk.toString("utf8").slice(0, remaining);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
      // A signed-out agy waits 60s on its local OAuth callback server after printing the prompt.
      if (!settled && AUTH_ERROR_PATTERN.test(stderr)) {
        settled = true;
        clearTimeout(timer);
        killProcessGroup(child.pid);
        resolve({ code: 1, stdout, stderr });
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      // Stop any lingering child processes (such as a language server) spawned by agy.
      killProcessGroup(child.pid);
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
  readonly minPollIntervalMs: number;

  private readonly logger: Logger;
  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly env?: Record<string, string>;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly cache: AntigravityUsageCache;
  private readonly cacheKey: string;
  private readonly resolveExecutable: AntigravityExecutableResolver;
  private readonly runCommand: AntigravityCommandRunner;
  private readonly now: () => number;

  constructor(options: AntigravityQuotaProviderOptions) {
    this.logger = options.logger;
    this.providerId = options.providerId ?? "antigravity";
    this.displayName = options.displayName ?? "Antigravity";
    this.minPollIntervalMs = options.minPollIntervalMs ?? ANTIGRAVITY_MIN_POLL_INTERVAL_MS;
    const configuredCommand = options.command;
    this.command = configuredCommand?.[0] ?? "agy";
    this.prefixArgs = stripAcpSubcommand(configuredCommand?.slice(1) ?? []);
    this.env = options.env;
    this.cwd = options.cwd ?? tmpdir();
    this.timeoutMs = options.timeoutMs ?? ANTIGRAVITY_USAGE_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES;
    this.cache = options.cache ?? sharedAntigravityUsageCache;
    this.cacheKey = buildCacheKey(this.providerId, this.command, this.prefixArgs, this.env);
    this.resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.now = options.now ?? Date.now;
  }

  async fetchUsage(options?: ProviderUsageFetchOptions): Promise<ProviderUsage> {
    const userRefresh = options?.userRefresh === true;
    const nowMs = this.now();
    if (!userRefresh) {
      const cached = this.cache.readings.get(this.cacheKey);
      if (cached && nowMs - cached.fetchedAtMs < this.minPollIntervalMs) {
        return cached.usage;
      }
    }

    const existing = this.cache.inFlight.get(this.cacheKey);
    if (existing) return existing;

    const request = this.executeAndCacheFetch();
    this.cache.inFlight.set(this.cacheKey, request);
    try {
      return await request;
    } finally {
      if (this.cache.inFlight.get(this.cacheKey) === request) {
        this.cache.inFlight.delete(this.cacheKey);
      }
    }
  }

  private async executeAndCacheFetch(): Promise<ProviderUsage> {
    const usage = await this.executeFetch();
    const recordedAtMs = this.now();
    const stamped: ProviderUsage = {
      ...usage,
      fetchedAt: new Date(recordedAtMs).toISOString(),
    };
    this.cache.readings.set(this.cacheKey, {
      providerId: this.providerId,
      fetchedAtMs: recordedAtMs,
      usage: stamped,
    });
    return stamped;
  }

  private async executeFetch(): Promise<ProviderUsage> {
    const resolved = await this.resolveExecutable(this.command, this.env);
    if (!resolved) return unavailableUsage(this);

    const args = [
      ...this.prefixArgs,
      "--log-file",
      nullLogPath(),
      "-p",
      "/usage",
      "--output-format",
      "json",
    ];
    const result = await this.runCommand(resolved, args, {
      cwd: this.cwd,
      env: this.env,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });

    const detail = result.stderr.trim() || result.stdout.trim();
    if (result.code === 2 && !UNKNOWN_FLAG_PATTERN.test(detail)) {
      // Exit code 2 (without a flag error) indicates an account mode without quota (e.g. GEMINI_API_KEY).
      return unavailableUsage(this);
    }

    if (result.code !== 0) {
      if (isAntigravitySignedOutOrNoQuota(detail)) {
        return unavailableUsage(this);
      }
      this.logger.debug(
        { providerId: this.providerId, code: result.code },
        "Antigravity usage fetch failed",
      );
      return unavailableUsage({
        ...this,
        error: `Antigravity usage check failed (exit code ${result.code ?? "unknown"})`,
      });
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
