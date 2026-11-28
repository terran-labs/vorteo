import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { probe } from "./internal/process.js";
import { AntigravityError } from "./internal/wire.js";

const USAGE_TIMEOUT_MS = 15_000;
const AUTH_ERROR_PATTERN =
  /\b(?:authentication\s+(?:required|failed|expired)|not\s+(?:logged|signed)\s+in(?:to\b)?|unauthenticated|please\s+(?:log|sign)\s+in|run\s+['`"]?agy['`"]?\s+to\s+(?:log|sign)\s+in|visit\s+the\s+url\s+to\s+log\s+in)\b/i;
const NO_QUOTA_PATTERN =
  /\b(?:no\s+account\s+quota|has\s+no\s+account\s+quota|no\s+usage\s+quota)\b/i;
const UNKNOWN_FLAG_PATTERN = /flag provided but not defined|unknown flag/i;

function nullLogPath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function usageLaunch(launch: ProviderLaunch): ProviderLaunch {
  if (launch.env.SSH_CONNECTION) return launch;
  return { ...launch, env: { ...launch.env, SSH_CONNECTION: "1 2 3 4" } };
}

const inputSchema = z.object({ account: z.string() }).strict();

const bucketSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  window: z.string().optional(),
  remaining_fraction: z.coerce.number().finite().nullish(),
  reset_time: z.string().nullish(),
});

const groupSchema = z.object({
  name: z.string().optional(),
  buckets: z.array(bucketSchema).default([]),
});

const usageResponseSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  command: z
    .object({
      name: z.string().optional(),
      data: z
        .object({
          groups: z.array(groupSchema).default([]),
        })
        .nullish(),
    })
    .nullish(),
});

type Bucket = z.infer<typeof bucketSchema>;
type Group = z.infer<typeof groupSchema>;

interface WindowSpec {
  label: string;
  shortLabel: string;
  order: number;
}

function accountKey(env: ProviderLaunch["env"]): string {
  const appDataDir =
    env.ANTIGRAVITY_APP_DATA_DIR ?? path.join(env.HOME ?? homedir(), ".gemini", "antigravity-cli");
  return hashAccountKey(path.resolve(appDataDir));
}

function normalizeGroupLabel(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.replace(/\s+models$/i, "").trim();
}

function describeWindow(bucket: Bucket): WindowSpec {
  const raw = bucket.window?.trim().toLowerCase() ?? "";
  if (raw === "weekly") return { label: "Weekly", shortLabel: "wk", order: 2 };
  if (raw === "daily") return { label: "Daily", shortLabel: "1d", order: 2 };
  const hours = /^(\d+)h$/.exec(raw);
  if (hours) {
    const count = Number(hours[1]);
    return { label: `${count}-hour`, shortLabel: `${count}h`, order: 1 };
  }
  const days = /^(\d+)d$/.exec(raw);
  if (days) {
    const count = Number(days[1]);
    return { label: `${count}-day`, shortLabel: `${count}d`, order: 2 };
  }
  const fallback =
    bucket.name
      ?.trim()
      .replace(/\s+limit\s+remaining$/i, "")
      .replace(/\s+remaining$/i, "")
      .trim() || "Quota";
  return { label: fallback, shortLabel: "", order: 3 };
}

function normalizeResetTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  // Antigravity returns the Unix epoch for buckets whose rolling window has not started yet.
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Date(parsed).toISOString();
}

function uniqueId(candidate: string, taken: Set<string>): string {
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

function parseGroupWindows(
  group: Group,
  groupIndex: number,
  multipleGroups: boolean,
  takenIds: Set<string>,
): UsageWindow[] {
  const groupLabel = normalizeGroupLabel(group.name);
  const orderedBuckets = group.buckets
    .map((bucket, index) => ({ bucket, index, spec: describeWindow(bucket) }))
    .sort((left, right) => left.spec.order - right.spec.order || left.index - right.index);

  const windows: UsageWindow[] = [];
  for (const { bucket, spec } of orderedBuckets) {
    if (typeof bucket.remaining_fraction !== "number") continue;
    const clampedRemaining = Math.min(1, Math.max(0, bucket.remaining_fraction));
    const usedPct = Math.round((1 - clampedRemaining) * 10_000) / 100;
    const baseId = bucket.id?.trim() || `${groupIndex}_${spec.shortLabel || "quota"}`;
    const id = uniqueId(baseId, takenIds);
    const label = multipleGroups && groupLabel ? `${spec.label} \u00b7 ${groupLabel}` : spec.label;
    windows.push(
      windowFromUsedPct({
        id,
        label,
        shortLabel: spec.shortLabel,
        summary: groupIndex === 0,
        utilizationPct: usedPct,
        resetsAt: normalizeResetTime(bucket.reset_time),
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }
  return windows;
}

function parseUsageReport(stdout: string): UsageReport {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { status: "error", error: "Invalid Antigravity usage output" };
  }
  const parsed = usageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", error: "Unexpected Antigravity usage payload" };
  }
  if (parsed.data.status !== "SUCCESS") {
    const rawError = parsed.data.error?.trim() ?? "";
    if (rawError && AUTH_ERROR_PATTERN.test(rawError)) {
      return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
    }
    if (rawError && NO_QUOTA_PATTERN.test(rawError)) {
      return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
    }
    return { status: "error", error: `Antigravity usage returned ${parsed.data.status}` };
  }

  const groups = parsed.data.command?.data?.groups ?? [];
  const multipleGroups = groups.length > 1;
  const takenIds = new Set<string>();
  const windows = groups.flatMap((group, groupIndex) =>
    parseGroupWindows(group, groupIndex, multipleGroups, takenIds),
  );

  if (windows.length === 0) {
    return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
  }
  return { status: "available", windows };
}

export class AntigravityUsage {
  private readonly launches = new Map<string, ProviderLaunch>();

  remember(launch: ProviderLaunch): { account: string } {
    const account = accountKey(launch.env);
    this.launches.set(account, launch);
    return { account };
  }

  registration(): UsageSourceRegistration {
    return {
      id: "antigravity",
      label: "Antigravity",
      icon: "icon.svg",
      input: inputSchema,
      discover: async (scope) => {
        let accounts: string[];
        if (scope.kind === "global") {
          accounts = [...this.launches.keys()];
        } else {
          if (scope.provider !== "antigravity") return [];
          const account = accountKey(scope.env);
          accounts = this.launches.has(account) ? [account] : [];
        }
        return accounts.map((account) => ({
          key: account,
          label: "Antigravity",
          input: { account },
        }));
      },
      fetch: async (input) => {
        const { account } = inputSchema.parse(input);
        const launch = this.launches.get(account);
        if (!launch) throw new Error("Antigravity login no longer exists");
        try {
          const stdout = await probe({
            launch: usageLaunch(launch),
            args: ["--log-file", nullLogPath(), "-p", "/usage", "--output-format", "json"],
            cwd: tmpdir(),
            timeoutMs: USAGE_TIMEOUT_MS,
            cleanupProcessGroup: true,
            abortOnStderr: AUTH_ERROR_PATTERN,
          });
          return parseUsageReport(stdout);
        } catch (error) {
          if (error instanceof AntigravityError) {
            const detail = error.stderr ?? error.message;
            if (
              (error.exitCode === 2 && !UNKNOWN_FLAG_PATTERN.test(detail)) ||
              NO_QUOTA_PATTERN.test(detail)
            ) {
              return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
            }
            if (AUTH_ERROR_PATTERN.test(detail)) {
              return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
            }
            if (error.code === "PROBE_TIMEOUT") {
              return { status: "error", error: "Antigravity usage check timed out" };
            }
            return {
              status: "error",
              error: `Antigravity usage check failed (exit code ${error.exitCode ?? "unknown"})`,
            };
          }
          return {
            status: "error",
            error: "Antigravity usage check failed",
          };
        }
      },
    };
  }
}
