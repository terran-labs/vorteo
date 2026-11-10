import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ProviderResetAttemptSchema,
  type ProviderResetAttempt,
  type ProviderResetOutcome,
  type ProviderResetSnapshot,
} from "@getpaseo/protocol/provider-reset";
import type { ProviderResetCreditSession } from "../../agent-sdk-types.js";

/**
 * Claude subscription limit resets ("cedar_ember" in Claude Code 2.1.316).
 *
 * Claude Code reads an account's reset grants from the usage endpoint with
 * `?cedar_ember=1&skip_spend=1`, which adds a `cedar_ember` block beside the usage windows, and
 * spends one with `POST /api/organizations/{org}/reset_rate_limits`. Both use the account's
 * claude.ai OAuth access token. This contract comes from static analysis of the CLI, not from
 * published documentation, so every field is parsed permissively and an unknown shape reads as
 * unavailable rather than failing usage.
 */
export const CLAUDE_API_ORIGIN = "https://api.anthropic.com";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
/** The exact query Claude Code sends for its reset read. Vorteo shows no spend from this call. */
export const CLAUDE_USAGE_WITH_RESETS_PATH = "/api/oauth/usage?cedar_ember=1&skip_spend=1";
const RESET_PROGRAM = "cedar_ember";
/** Used until the daemon has read the installed Claude Code version. */
const FALLBACK_CLAUDE_CODE_VERSION = "2.1.316";
let installedClaudeCodeVersion: string | null = null;

/** Provider refresh reports the installed CLI version, so Vorteo's reads match what that CLI sends. */
export function noteClaudeCodeVersion(version: string) {
  installedClaudeCodeVersion = version;
}

/**
 * Claude offers reset grants to Claude Code, which identifies itself with this User-Agent. Vorteo
 * reads them with the same account sign-in Claude Code uses, so it sends the same identifier.
 */
export function claudeCodeUserAgent(): string {
  return `claude-cli/${installedClaudeCodeVersion ?? FALLBACK_CLAUDE_CODE_VERSION} (external, cli)`;
}
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Usage polls refresh the shared reading every couple of minutes; reuse it within this window. */
const RESET_STATUS_FRESH_MS = 3 * 60_000;
const CLAIM_TIMEOUT_MS = 25_000;
const READ_TIMEOUT_MS = 15_000;

const GrantSchema = z.object({
  id: z.string().regex(GRANT_ID),
  label: z.string().catch(""),
  resets_total: z.number().int().min(0).catch(0),
  resets_left: z.number().int().min(0),
  starts_at: z.string().nullish().catch(null),
  ends_at: z.string().nullish().catch(null),
  paused: z.boolean().catch(false),
  usable_now: z.boolean().catch(false),
  use_requires_limit: z.boolean().catch(true),
  type: z.enum(["session", "weekly", "full"]).optional().catch(undefined),
  /** Current grants name the limits they clear instead of carrying `type`. */
  clears: z.array(z.string()).optional().catch(undefined),
  unavailable_reason: z.string().nullish().catch(null),
});

const StatusSchema = z.object({
  eligible: z.boolean(),
  ineligible_reason: z.string().nullish().catch(null),
  at_limit: z.boolean().optional().catch(undefined),
  grants: z.array(z.unknown()).optional().catch(undefined),
  next_grant_id: z.string().nullish().catch(null),
  weekly_resets_at: z.string().nullish().catch(null),
  cooldown_until: z.string().nullish().catch(null),
});

const ClaimResponseSchema = z.object({
  result: z
    .enum(["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"])
    .catch("unavailable"),
  reason: z.string().nullish().catch(null),
});

export type ClaudeResetGrant = z.infer<typeof GrantSchema>;
export interface ClaudeResetStatus {
  eligible: boolean;
  ineligibleReason: string | null;
  atLimit: boolean;
  grants: ClaudeResetGrant[];
  nextGrantId: string | null;
}

/** One malformed grant is dropped on its own so it cannot hide the others. */
export function parseClaudeResetStatus(value: unknown): ClaudeResetStatus | null {
  if (value === undefined || value === null) return null;
  const parsed = StatusSchema.safeParse(value);
  if (!parsed.success) return null;
  const grants = (parsed.data.grants ?? []).flatMap((grant) => {
    const entry = GrantSchema.safeParse(grant);
    return entry.success ? [entry.data] : [];
  });
  const next = parsed.data.next_grant_id;
  return {
    eligible: parsed.data.eligible,
    ineligibleReason: parsed.data.ineligible_reason ?? null,
    atLimit: parsed.data.at_limit ?? false,
    grants,
    nextGrantId: next && grants.some((grant) => grant.id === next) ? next : null,
  };
}

interface CachedStatus {
  status: ClaudeResetStatus | null;
  fetchedAt: number;
}

/**
 * The latest reset block per account, keyed by CLAUDE_CONFIG_DIR, which both the usage fetcher
 * and the agent client receive. The usage poll writes it so the picker's reset reads cost Claude
 * nothing extra; Claude throttles that endpoint per account.
 */
const statusByConfigDir = new Map<string, CachedStatus>();

export function recordClaudeResetStatus(configDir: string, block: unknown, now = Date.now()) {
  statusByConfigDir.set(configDir, { status: parseClaudeResetStatus(block), fetchedAt: now });
}

/** What Claude said about resets, without grant IDs or labels, for the daemon log. */
export function summarizeClaudeResetBlock(block: unknown): string {
  if (block === undefined || block === null) return "absent";
  const status = parseClaudeResetStatus(block);
  if (!status) return "unparseable";
  if (!status.eligible) {
    // Claude's reasons are short slugs such as "surface"; anything else is not logged verbatim.
    const reason = status.ineligibleReason ?? "unspecified";
    return `ineligible:${/^[a-z0-9_]{1,40}$/.test(reason) ? reason : "other"}`;
  }
  const left = status.grants.reduce((sum, grant) => sum + grant.resets_left, 0);
  return `eligible grants=${status.grants.length} left=${left}`;
}

export function forgetClaudeResetStatus(configDir: string) {
  statusByConfigDir.delete(configDir);
}

const AccountFileSchema = z.object({
  oauthAccount: z
    .object({
      accountUuid: z.string().min(1).optional(),
      organizationUuid: z.string().min(1).optional(),
      emailAddress: z.string().optional(),
    })
    .nullish(),
});

interface ClaudeAccountIdentity {
  accountUuid: string;
  organizationUuid: string;
  email: string | null;
}

/** The CLI records the signed-in account and organization in the account's own config dir. */
async function readAccountIdentity(configDir: string): Promise<ClaudeAccountIdentity | null> {
  try {
    const parsed = AccountFileSchema.safeParse(
      JSON.parse(await readFile(join(configDir, ".claude.json"), "utf8")),
    );
    const account = parsed.success ? parsed.data.oauthAccount : null;
    if (!account?.accountUuid || !account.organizationUuid) return null;
    return {
      accountUuid: account.accountUuid,
      organizationUuid: account.organizationUuid,
      email: account.emailAddress ?? null,
    };
  } catch {
    return null;
  }
}

function epochSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const RESET_TYPE_DESCRIPTIONS: Record<string, string> = {
  session: "Clears the 5-hour session limit. Still counts toward the weekly limit.",
  weekly: "Clears the weekly limit.",
  full: "Clears the session and weekly limits.",
  model_weekly: "Clears a weekly limit for one model, not the overall weekly limit.",
};

type ClaudeResetType = "session" | "weekly" | "full" | "model_weekly" | "other";

/**
 * Grants without `type` list the limits they clear. `five_hour` and `seven_day` are the account
 * limits; other `seven_day_*` names, such as `seven_day_omelette`, are one model's weekly limit.
 * Unrecognized names get no description rather than a guess.
 */
export function claudeGrantResetType(grant: ClaudeResetGrant): ClaudeResetType | null {
  if (grant.type) return grant.type;
  const clears = new Set(grant.clears ?? []);
  if (clears.size === 0) return null;
  const session = clears.delete("five_hour");
  const weekly = clears.delete("seven_day");
  const modelWeekly = [...clears].every((limit) => limit.startsWith("seven_day_"));
  if (clears.size > 0) return session || weekly || !modelWeekly ? "other" : "model_weekly";
  if (session && weekly) return "full";
  return weekly ? "weekly" : "session";
}

function grantDescription(grant: ClaudeResetGrant): string | null {
  const type = claudeGrantResetType(grant);
  const parts = [type ? RESET_TYPE_DESCRIPTIONS[type] : undefined];
  if (grant.paused) parts.push("Paused by Claude.");
  else if (!grant.usable_now && grant.use_requires_limit) {
    parts.push("Usable once this account reaches a usage limit.");
  }
  const text = parts.filter(Boolean).join(" ");
  return text || null;
}

/** Claude reports a grant with several uses; Vorteo lists each grant once with its count. */
export function claudeResetSnapshot(
  identity: ClaudeAccountIdentity,
  status: ClaudeResetStatus | null,
): ProviderResetSnapshot {
  if (!status) {
    return { status: "unavailable", reason: "Claude did not report reset availability." };
  }
  if (!status.eligible) {
    return {
      status: "unsupported",
      reason: "Claude does not offer limit resets for this account.",
    };
  }
  const live = status.grants.filter((grant) => !grant.paused && grant.resets_left > 0);
  return {
    status: "available",
    accountId: identity.accountUuid,
    accountLabel: identity.email,
    availableCount: live.reduce((sum, grant) => sum + grant.resets_left, 0),
    credits: status.grants.map((grant) => ({
      id: grant.id,
      title: grant.label.trim() || null,
      description: grantDescription(grant),
      grantedAt: epochSeconds(grant.starts_at) ?? 0,
      expiresAt: epochSeconds(grant.ends_at),
      status: !grant.paused && grant.resets_left > 0 ? "available" : "unavailable",
      // Grants from before `clears` carried neither field and were session resets.
      resetType: claudeGrantResetType(grant) ?? "session",
    })),
  };
}

const CLAIM_OUTCOMES: Record<z.infer<typeof ClaimResponseSchema>["result"], ProviderResetOutcome> =
  {
    reset: "reset",
    already_used: "alreadyRedeemed",
    not_limited: "nothingToReset",
    cooldown: "noCredit",
    ineligible: "noCredit",
    unavailable: "noCredit",
  };

export class ClaudeResetCreditError extends Error {
  constructor(
    readonly code: "account_changed" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ClaudeResetCreditError";
  }
}

export interface ClaudeResetCreditSessionOptions {
  /** Null for accounts whose credential cannot read usage, such as setup tokens. */
  configDir: string | null;
  /** The account's current claude.ai access token, or null when it has none. */
  readAccessToken(): Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Account management only; never attached to an agent's tools. */
export class ClaudeResetCreditSession implements ProviderResetCreditSession {
  readonly canRedeem = true;
  readonly canSelectCredit = true;
  private readonly fetchApi: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ClaudeResetCreditSessionOptions) {
    this.fetchApi = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async read(): Promise<ProviderResetSnapshot> {
    if (!this.options.configDir) {
      return {
        status: "unsupported",
        reason: "Limit resets need a full Claude sign-in for this account.",
      };
    }
    const identity = await readAccountIdentity(this.options.configDir);
    if (!identity) {
      return { status: "unavailable", reason: "Sign in with Claude for this account." };
    }
    return claudeResetSnapshot(identity, await this.status());
  }

  async consume(input: ProviderResetAttempt): Promise<ProviderResetOutcome> {
    const attempt = ProviderResetAttemptSchema.parse(input);
    const configDir = this.requireConfigDir();
    const identity = await readAccountIdentity(configDir);
    if (!identity) throw new ClaudeResetCreditError("unavailable", "Sign in with Claude again.");
    if (identity.accountUuid !== attempt.accountId) {
      throw new ClaudeResetCreditError(
        "account_changed",
        "The signed-in account changed. Review the account and confirm again.",
      );
    }
    // A retry keeps its grant and request ID even when the first response was lost.
    const status = await this.status({ fresh: !attempt.creditId });
    const grantId =
      attempt.creditId ??
      status?.nextGrantId ??
      status?.grants.find((grant) => !grant.paused && grant.resets_left > 0)?.id;
    if (!grantId || !GRANT_ID.test(grantId)) return "noCredit";
    if (!REQUEST_ID.test(attempt.idempotencyKey)) {
      throw new ClaudeResetCreditError("unavailable", "The reset request ID is invalid.");
    }
    const token = await this.requireToken();
    const response = await this.fetchApi(
      `${CLAUDE_API_ORIGIN}/api/organizations/${encodeURIComponent(identity.organizationUuid)}/reset_rate_limits`,
      {
        method: "POST",
        headers: this.headers(token, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          program: RESET_PROGRAM,
          grant_id: grantId,
          request_id: attempt.idempotencyKey,
        }),
        signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
      },
    );
    forgetClaudeResetStatus(configDir);
    if (response.status === 401 || response.status === 403) {
      throw new ClaudeResetCreditError("unavailable", "Claude rejected this account's sign-in.");
    }
    if (response.status === 429) {
      throw new ClaudeResetCreditError(
        "unavailable",
        "Claude is limiting requests for this account. Try again in a few minutes.",
      );
    }
    if (!response.ok) {
      throw new ClaudeResetCreditError("unavailable", `Claude returned ${response.status}.`);
    }
    const parsed = ClaimResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ClaudeResetCreditError("unavailable", "Claude's reset response was unreadable.");
    }
    return CLAIM_OUTCOMES[parsed.data.result];
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  /** Prefer the usage poll's reading; fetch only when it is missing or stale. */
  private async status(options: { fresh?: boolean } = {}): Promise<ClaudeResetStatus | null> {
    const configDir = this.requireConfigDir();
    const cached = statusByConfigDir.get(configDir);
    if (!options.fresh && cached && this.now() - cached.fetchedAt < RESET_STATUS_FRESH_MS) {
      return cached.status;
    }
    const token = await this.requireToken();
    const response = await this.fetchApi(`${CLAUDE_API_ORIGIN}${CLAUDE_USAGE_WITH_RESETS_PATH}`, {
      headers: this.headers(token, { Accept: "application/json" }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (response.status === 429 && cached) return cached.status;
    if (response.status === 429) {
      throw new ClaudeResetCreditError(
        "unavailable",
        "Claude is limiting usage checks for this account. Try again in a few minutes.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ClaudeResetCreditError("unavailable", "Claude rejected this account's sign-in.");
    }
    if (!response.ok) {
      throw new ClaudeResetCreditError("unavailable", `Claude returned ${response.status}.`);
    }
    const body = (await response.json()) as { cedar_ember?: unknown } | null;
    recordClaudeResetStatus(configDir, body?.cedar_ember, this.now());
    return statusByConfigDir.get(configDir)?.status ?? null;
  }

  private requireConfigDir(): string {
    if (!this.options.configDir) {
      throw new ClaudeResetCreditError(
        "unavailable",
        "Limit resets need a full Claude sign-in for this account.",
      );
    }
    return this.options.configDir;
  }

  private async requireToken(): Promise<string> {
    const token = await this.options.readAccessToken();
    if (!token) throw new ClaudeResetCreditError("unavailable", "Sign in with Claude again.");
    return token;
  }

  private headers(token: string, extra: Record<string, string>): Record<string, string> {
    return {
      ...extra,
      Authorization: `Bearer ${token}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA,
      "User-Agent": claudeCodeUserAgent(),
    };
  }
}
