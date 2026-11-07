import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  claudeKeychainAccount,
  claudeKeychainServiceForConfigDir,
  readClaudeAccountKeychainCredentialsStrict,
} from "../../../services/quota-fetcher/providers/claude.js";
import type { ClaudeAccessProjection } from "./claude-oauth-delivery.js";
import { isTrustedCredentialsFile } from "./claude-oauth-credentials-file.js";

export class ClaudeCredentialReadError extends Error {
  constructor() {
    super("Could not read this Claude account's credential storage.");
  }
}

/** The CLI refreshes only within 5 minutes of expiry; ask inside that window with margin. */
export const CLAUDE_REFRESH_LEAD_MS = 4 * 60_000;

/** What the coordinator may hold in memory. The refresh token value is never read out. */
export interface ClaudeOAuthGrant {
  accessToken: string;
  hasRefreshToken: boolean;
  expiresAt: number | null;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

const StorageSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      expiresAt: z.unknown().optional(),
      scopes: z.unknown().optional(),
      subscriptionType: z.string().optional(),
      rateLimitTier: z.string().optional(),
    })
    .optional(),
});

function toGrant(value: unknown): ClaudeOAuthGrant | null {
  const parsed = StorageSchema.safeParse(value);
  if (!parsed.success) throw new ClaudeCredentialReadError();
  const oauth = parsed.data.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    hasRefreshToken: Boolean(oauth.refreshToken),
    expiresAt:
      typeof oauth.expiresAt === "number" && Number.isSafeInteger(oauth.expiresAt)
        ? oauth.expiresAt
        : null,
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    ...(oauth.subscriptionType ? { subscriptionType: oauth.subscriptionType } : {}),
    ...(oauth.rateLimitTier ? { rateLimitTier: oauth.rateLimitTier } : {}),
  };
}

export async function readStorageFile(file: string): Promise<unknown | null> {
  let descriptor: FileHandle;
  try {
    descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new ClaudeCredentialReadError();
  }
  try {
    // Same checks as the Dev reader: regular, bounded, owned by this user, not shared-writable.
    if (!isTrustedCredentialsFile(await descriptor.stat())) throw new ClaudeCredentialReadError();
    return JSON.parse(await descriptor.readFile("utf8"));
  } catch {
    throw new ClaudeCredentialReadError();
  } finally {
    await descriptor.close();
  }
}

interface GrantReadOptions {
  platform?: NodeJS.Platform;
  readKeychain?: (service: string, account: string) => Promise<unknown | null>;
}

/** Same store order as the pinned CLI, and never the default Keychain item. */
export async function readClaudeOAuthGrant(
  configDir: string,
  options: GrantReadOptions = {},
): Promise<ClaudeOAuthGrant | null> {
  if ((options.platform ?? process.platform) === "darwin") {
    const service = claudeKeychainServiceForConfigDir(configDir);
    if (service === "Claude Code-credentials") return null;
    const readKeychain =
      options.readKeychain ??
      ((name: string, account: string) =>
        readClaudeAccountKeychainCredentialsStrict(name, account));
    const item = await readKeychain(service, claudeKeychainAccount());
    if (item !== null && item !== undefined) return toGrant(item);
  }
  const storage = await readStorageFile(join(configDir, ".credentials.json"));
  return storage === null ? null : toGrant(storage);
}

/** Access-only view for Dev. Null when the grant cannot be projected usefully. */
export function claudeAccessProjection(
  grant: ClaudeOAuthGrant | null,
): ClaudeAccessProjection | null {
  if (!grant || grant.expiresAt === null || grant.expiresAt <= 0) return null;
  return {
    accessToken: grant.accessToken,
    expiresAt: grant.expiresAt,
    scopes: grant.scopes,
    ...(grant.subscriptionType ? { subscriptionType: grant.subscriptionType } : {}),
    ...(grant.rateLimitTier ? { rateLimitTier: grant.rateLimitTier } : {}),
  };
}

export function needsHostRefresh(grant: ClaudeOAuthGrant | null, now: number): boolean {
  return Boolean(
    grant?.hasRefreshToken &&
    grant.expiresAt !== null &&
    grant.expiresAt - now <= CLAUDE_REFRESH_LEAD_MS,
  );
}
