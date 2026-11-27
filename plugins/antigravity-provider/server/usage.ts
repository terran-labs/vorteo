import { homedir } from "node:os";
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
  /auth(?:entication)?\s*(?:required|failed|expired)|sign[\s.-]?in|log[\s.-]?in|unauthenticated|not signed in/i;
const NO_QUOTA_PATTERN = /no account quota|gemini_api_key|api key/i;

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
    const message = parsed.data.error?.trim() || `Antigravity usage returned ${parsed.data.status}`;
    if (AUTH_ERROR_PATTERN.test(message)) {
      return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
    }
    if (NO_QUOTA_PATTERN.test(message)) {
      return unavailable({ kind: "no_quota", detail: message });
    }
    return { status: "error", error: message };
  }

  const groups = parsed.data.command?.data?.groups ?? [];
  const multipleGroups = groups.length > 1;
  const takenIds = new Set<string>();
  const windows: UsageWindow[] = [];

  for (const [groupIndex, group] of groups.entries()) {
    const groupLabel = normalizeGroupLabel(group.name);
    const orderedBuckets = group.buckets
      .map((bucket, index) => ({ bucket, index, spec: describeWindow(bucket) }))
      .sort((left, right) => left.spec.order - right.spec.order || left.index - right.index);

    for (const { bucket, spec } of orderedBuckets) {
      if (typeof bucket.remaining_fraction !== "number") continue;
      const clampedRemaining = Math.min(1, Math.max(0, bucket.remaining_fraction));
      const usedPct = Math.round((1 - clampedRemaining) * 10_000) / 100;
      const baseId = bucket.id?.trim() || `${groupIndex}_${spec.shortLabel || "quota"}`;
      const id = uniqueId(baseId, takenIds);
      const label =
        multipleGroups && groupLabel ? `${spec.label} \u00b7 ${groupLabel}` : spec.label;
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
  }

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
            launch,
            args: ["-p", "/usage", "--output-format", "json"],
            timeoutMs: USAGE_TIMEOUT_MS,
          });
          return parseUsageReport(stdout);
        } catch (error) {
          if (error instanceof AntigravityError) {
            if (error.exitCode === 2 || NO_QUOTA_PATTERN.test(error.message)) {
              return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
            }
            if (AUTH_ERROR_PATTERN.test(error.message)) {
              return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
            }
          }
          return {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }
}
