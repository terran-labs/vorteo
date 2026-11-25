import { getProviderProbeCwd } from "../../../utils/provider-probe-cwd.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { z } from "zod";
import {
  checkProviderLaunchAvailable,
  createProviderEnvSpec,
  resolveProviderLaunch,
} from "../../agent/provider-launch-config.js";
import { CodexAppServerClient } from "../../agent/providers/codex/app-server-transport.js";
import { CodexLoginSession } from "../../agent/providers/codex/login.js";
import { execCommand, spawnProcess } from "../../../utils/spawn.js";
import { isTrustedCredentialsFile } from "./claude-oauth-credentials-file.js";
import type { CodexAccessProjection } from "./codex-signin-delivery.js";
import { codexIdTokenPerson, jwtClaims } from "./codex-signin-identity.js";
import type { HostRefreshIdentity } from "./host-owned-refresher.js";

/**
 * Host-side operations the coordinator performs on a Codex account's own CODEX_HOME. The
 * coordinator runs as the same user on the Host and receives the account's exact CODEX_HOME
 * from the Host daemon, so the official Codex CLI uses the same storage the Host agents use.
 *
 * Unverified until the owner's live sign-in check: the expiry carried by ChatGPT access tokens,
 * whether `account/read` with `refreshToken: true` always rotates the grant, and how Dev Codex
 * reacts when its projected copy has an empty refresh token and its access token is rejected.
 * The Host's file storage is the default; an account whose config selects keyring storage has
 * no `auth.json` and reports that it needs sign-in.
 */

/** Refresh this long before the access token expires. Reconciles run every 30 seconds. */
export const CODEX_REFRESH_LEAD_MS = 30 * 60_000;
/**
 * Codex refreshes a sign-in on its own once `last_refresh` is 8 days old. Dev's copy cannot
 * refresh, so the Host refreshes a day earlier and Dev receives the newer copy first.
 */
export const CODEX_STALE_REFRESH_MS = 7 * 24 * 60 * 60_000;

/** What the coordinator may hold in memory. The refresh token value is never read out. */
export interface CodexHostGrant {
  accessToken: string;
  idToken: string;
  accountId: string | null;
  hasRefreshToken: boolean;
  expiresAt: number | null;
  lastRefresh: string | null;
}

const AuthFileSchema = z.object({
  tokens: z
    .object({
      id_token: z.string().optional(),
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
      account_id: z.string().nullish(),
    })
    .nullish(),
  last_refresh: z.string().nullish(),
});

/** The `exp` claim of an unverified JWT, in milliseconds. Only used for scheduling. */
export function jwtExpiry(token: string): number | null {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isSafeInteger(exp) && exp > 0 ? exp * 1000 : null;
}

const EmailClaimsSchema = z.object({
  email: z.string().optional(),
  "https://api.openai.com/profile": z.object({ email: z.string().optional() }).optional(),
});

/** The signed-in email Codex itself shows, read from the ID token without starting Codex. */
function idTokenEmail(idToken: string): string | null {
  const claims = EmailClaimsSchema.safeParse(jwtClaims(idToken));
  if (!claims.success) return null;
  return claims.data.email ?? claims.data["https://api.openai.com/profile"]?.email ?? null;
}

function toGrant(value: unknown): CodexHostGrant | null {
  const parsed = AuthFileSchema.safeParse(value);
  const tokens = parsed.success ? parsed.data.tokens : undefined;
  if (!tokens?.access_token || !tokens.id_token) return null;
  const lastRefresh = parsed.data!.last_refresh;
  return {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    accountId: tokens.account_id || null,
    hasRefreshToken: Boolean(tokens.refresh_token),
    expiresAt: jwtExpiry(tokens.access_token),
    lastRefresh: lastRefresh && !Number.isNaN(Date.parse(lastRefresh)) ? lastRefresh : null,
  };
}

/** Same checks as the Claude reader: regular, bounded, owned by this user, not shared-writable. */
export function readCodexHostGrant(codexHome: string): CodexHostGrant | null {
  let descriptor: number;
  try {
    descriptor = openSync(join(codexHome, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!isTrustedCredentialsFile(fstatSync(descriptor))) return null;
    return toGrant(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

/** Access-only view for Dev. Null when the grant cannot be projected usefully. */
export function codexAccessProjection(grant: CodexHostGrant | null): CodexAccessProjection | null {
  if (!grant || grant.expiresAt === null) return null;
  return {
    accessToken: grant.accessToken,
    idToken: grant.idToken,
    accountId: grant.accountId,
    expiresAt: grant.expiresAt,
    lastRefresh: grant.lastRefresh,
  };
}

/** Adoption needs this much access token lifetime left, so it never has to refresh. */
export const CODEX_ADOPTION_MIN_REMAINING_MS = 30 * 60_000;

/** Reasons a Host sign-in on that account repairs; the app offers it beside them. */
export const HOST_NOT_SIGNED_IN =
  "The Host is not signed in to this account. Sign in on the Host, then try again.";
export const HOST_CANNOT_RENEW =
  "The Host's sign-in for this account cannot renew itself. Sign in on the Host, then try again.";
export const HOST_NOT_CHATGPT =
  "The Host's sign-in for this account is not a ChatGPT sign-in. Sign in on the Host, then try again.";
export const HOST_NO_PERSON =
  "The Host's sign-in for this account does not say which ChatGPT user it belongs to. Sign in on the Host, then try again.";
export const HOST_SIGN_IN_REASONS: ReadonlySet<string> = new Set([
  HOST_NOT_SIGNED_IN,
  HOST_CANNOT_RENEW,
  HOST_NOT_CHATGPT,
  HOST_NO_PERSON,
]);

export type CodexHostSessionCheck =
  | { verified: true; identity: HostRefreshIdentity }
  | { verified: false; reason: string };

/**
 * Whether the Host account's own `auth.json` holds a usable ChatGPT sign-in, judged from the file
 * alone. Starting Codex is not an option here: even `account/read` with `refreshToken: false`
 * refreshes proactively when the access token is within five minutes of expiry (Codex 0.167.2).
 */
export function verifyCodexHostSession(
  grant: CodexHostGrant | null,
  now: number,
): CodexHostSessionCheck {
  if (!grant)
    return {
      verified: false,
      reason: HOST_NOT_SIGNED_IN,
    };
  if (!grant.hasRefreshToken)
    return {
      verified: false,
      reason: HOST_CANNOT_RENEW,
    };
  if (!grant.accountId)
    return {
      verified: false,
      reason: HOST_NOT_CHATGPT,
    };
  // The workspace alone is shared by every member of a Team workspace; Dev compares the person.
  if (!codexIdTokenPerson(grant.idToken))
    return {
      verified: false,
      reason: HOST_NO_PERSON,
    };
  if (grant.expiresAt === null || grant.expiresAt - now <= CODEX_ADOPTION_MIN_REMAINING_MS)
    return {
      verified: false,
      reason: "The Host's sign-in for this account is about to renew. Try again in a few minutes.",
    };
  return {
    verified: true,
    identity: { email: idTokenEmail(grant.idToken), orgId: grant.accountId },
  };
}

export function needsCodexHostRefresh(grant: CodexHostGrant | null, now: number): boolean {
  if (!grant?.hasRefreshToken || grant.expiresAt === null) return false;
  if (grant.expiresAt - now <= CODEX_REFRESH_LEAD_MS) return true;
  const refreshed = grant.lastRefresh ? Date.parse(grant.lastRefresh) : Number.NaN;
  return Number.isFinite(refreshed) && now - refreshed >= CODEX_STALE_REFRESH_MS;
}

/** Same client identity as the daemon's own app-server connections. */
const INITIALIZE_PARAMS = {
  clientInfo: {
    name: "codex_app_server_daemon",
    title: "Codex App Server Daemon",
    version: "0.0.0",
  },
  capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
};

const AccountSchema = z.object({
  account: z.object({ type: z.literal("chatgpt"), email: z.string().nullish() }).nullish(),
});

interface HostCliOptions {
  run?: typeof execCommand;
  resolveLaunch?: () => Promise<{ executable: string; args: string[] }>;
  /** Starts `codex app-server` for one account. Injected by tests. */
  spawnAppServer?: (codexHome: string) => Promise<ChildProcessWithoutNullStreams>;
  logger?: Logger;
}

async function defaultLaunch(): Promise<{ executable: string; args: string[] }> {
  const launch = await resolveProviderLaunch({ defaultBinary: "codex" });
  const available = await checkProviderLaunchAvailable(launch);
  if (!available.resolvedPath) throw new Error("Codex is unavailable on this host.");
  return { executable: available.resolvedPath, args: launch.args };
}

function accountEnvironment(codexHome: string) {
  return createProviderEnvSpec({ runtimeSettings: { env: { CODEX_HOME: codexHome } } });
}

export function createCodexHostCli(options: HostCliOptions = {}) {
  const run = options.run ?? execCommand;
  const resolveLaunch = options.resolveLaunch ?? defaultLaunch;
  // Lines that fail to parse are logged by the transport; keep them out of coordinator logs.
  const logger = options.logger ?? pino({ level: "silent" });
  const spawnAppServer =
    options.spawnAppServer ??
    (async (codexHome: string) => {
      const launch = await resolveLaunch();
      const child = spawnProcess(launch.executable, [...launch.args, "app-server"], {
        cwd: await getProviderProbeCwd(),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        ...accountEnvironment(codexHome),
      });
      if (!child.stdin || !child.stdout || !child.stderr)
        throw new Error("Codex app-server did not expose stdio pipes");
      return child as ChildProcessWithoutNullStreams;
    });

  async function open(codexHome: string, startTimeoutMs = 15_000): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(await spawnAppServer(codexHome), logger);
    try {
      await client.request("initialize", INITIALIZE_PARAMS, startTimeoutMs);
      client.notify("initialized", {});
      return client;
    } catch (error) {
      await client.dispose();
      throw error;
    }
  }

  async function withClient<T>(
    codexHome: string,
    operation: (client: CodexAppServerClient) => Promise<T>,
  ): Promise<T> {
    const client = await open(codexHome);
    try {
      return await operation(client);
    } finally {
      await client.dispose();
    }
  }

  return {
    /**
     * Starts and initializes the official Host Codex for one account, so that its startup time
     * is spent before any lease is taken. `refresh` asks it to refresh its own grant and save it
     * under its own storage rules; success is judged by re-reading the grant. `close` ends the
     * process, which also aborts a refresh that ran out of time.
     */
    async openRefresh(
      codexHome: string,
      start: { startTimeoutMs?: number } = {},
    ): Promise<CodexHostRefreshSession> {
      const client = await open(codexHome, start.startTimeoutMs);
      return {
        async refresh(timeoutMs: number) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<"timed-out">((resolve) => {
            timer = setTimeout(() => resolve("timed-out"), timeoutMs);
          });
          const request = client
            .request("account/read", { refreshToken: true }, timeoutMs + 1_000)
            .then(() => "done" as const);
          try {
            return await Promise.race([request, deadline]);
          } finally {
            clearTimeout(timer);
          }
        },
        close: () => client.dispose(),
      };
    },
    /** `codex logout` removes the Host grant and asks OpenAI to revoke it. */
    async logout(codexHome: string): Promise<void> {
      const launch = await resolveLaunch();
      await run(launch.executable, [...launch.args, "logout"], {
        cwd: await getProviderProbeCwd(),
        ...accountEnvironment(codexHome),
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      });
    },
    /** The signed-in email from Codex and the ChatGPT account from the Host grant. */
    async identity(codexHome: string): Promise<HostRefreshIdentity | null> {
      try {
        const account = await withClient(codexHome, async (client) =>
          AccountSchema.parse(
            await client.request("account/read", { refreshToken: false }, 15_000),
          ),
        );
        if (!account.account) return null;
        return {
          email: account.account.email ?? null,
          orgId: readCodexHostGrant(codexHome)?.accountId ?? null,
        };
      } catch {
        return null;
      }
    },
    async loginSession(codexHome: string): Promise<CodexLoginSession> {
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      const scope = await realpath(codexHome);
      return new CodexLoginSession(await open(codexHome), scope);
    },
  };
}
export type CodexHostCli = ReturnType<typeof createCodexHostCli>;

export interface CodexHostRefreshSession {
  /** "timed-out" when the refresh did not answer in time; close the session to abort it. */
  refresh(timeoutMs: number): Promise<"done" | "timed-out">;
  close(): Promise<void>;
}
