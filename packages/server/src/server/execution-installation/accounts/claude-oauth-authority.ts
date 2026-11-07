import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  claudeKeychainAccount,
  claudeKeychainServiceForConfigDir,
  readClaudeAccountKeychainCredentialsStrict,
} from "../../../services/quota-fetcher/providers/claude.js";
import {
  acquireStorageLock,
  replaceAtomically,
  type LockOptions,
} from "./claude-oauth-credentials-file.js";
import { ClaudeCredentialReadError, readStorageFile } from "./claude-oauth-storage.js";

/**
 * Single-refresher custody for full sign-in Claude accounts on the Host.
 *
 * Every Host agent of an account shares the account's CLAUDE_CONFIG_DIR. When that directory holds
 * the rotating refresh token, any long-lived agent CLI can refresh it while the coordinator does
 * too, and a replayed refresh token can revoke the whole grant. Here the coordinator moves the
 * grant into an authority directory that no agent is launched with, refreshes only there through
 * the official CLI, and writes access-only copies into the account directory, exactly as Dev gets.
 * Without a refresh token the CLI never refreshes (Claude Code 2.1.316: `no_refresh_token`).
 *
 * Store order follows the pinned CLI: on macOS the per-directory Keychain item is primary and
 * `.credentials.json` is read only when no item exists. Host copies therefore go to the file, which
 * the CLI re-stats before each request, and the account's Keychain item is deleted after the file
 * is written, so an agent always has a credential. A CLI save with no refresh token is skipped
 * (`tengu_oauth_tokens_inference_only`), but another save, such as MCP OAuth, can recreate the
 * item; every projection pass moves it back to the file. Writes take the CLI's own
 * `.storage-write.lock` and stay short, because a CLI save waits only about ten seconds for it.
 */

/** Adopt a login only while this much validity remains, so no agent CLI is mid-refresh. */
export const CLAUDE_ADOPTION_MARGIN_MS = 10 * 60_000;
const CREDENTIALS_FILE = ".credentials.json";
/** Same marker Dev uses; usage then reports a pending Host refresh instead of a lost sign-in. */
const PROJECTION_MARKER = ".vorteo-oauth";
const KEYCHAIN_TIMEOUT_MS = 5_000;
/** `security -i` reads one command line; the CLI switches to argv above this size. */
const SECURITY_STDIN_LIMIT = 4032;

type Storage = Record<string, unknown>;
type OAuth = Record<string, unknown> & { refreshToken?: unknown; expiresAt?: unknown };

/** Raw CLI credential storage for one config directory. Values never leave the coordinator. */
export interface ClaudeCredentialStore {
  read(configDir: string): Promise<Storage | null>;
  /** Replaces the directory's primary storage. The caller holds its storage lock. */
  write(configDir: string, value: Storage): Promise<void>;
  /** Writes the plaintext file, then removes any primary item that would shadow it. */
  writeFile(configDir: string, value: Storage): Promise<void>;
  /** Whether a primary item (the macOS Keychain) exists and would shadow the file. */
  primaryHolds(configDir: string): Promise<boolean>;
  remove(configDir: string): Promise<void>;
}

/** The coordinator-only directory that holds an account's refresh token. */
export function claudeAuthorityDir(stateDir: string, definitionId: string): string {
  const name = createHash("sha256").update(definitionId).digest("hex").slice(0, 32);
  return join(stateDir, "claude-oauth", "authority", name);
}

/** Owner kill switch: when present, logins return to the account directories. */
export function claudeAuthorityDisabledFile(stateDir: string): string {
  return join(stateDir, "claude-oauth", "authority-disabled");
}

function asObject(value: unknown): Storage | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Storage) : null;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function readFileStore(configDir: string): Promise<Storage | null> {
  const value = await readStorageFile(join(configDir, CREDENTIALS_FILE));
  if (value === null) return null;
  const storage = asObject(value);
  if (!storage) throw new ClaudeCredentialReadError();
  return storage;
}

/** Plaintext storage, as the Linux CLI uses. Also the macOS fallback. */
function writeFileStore(configDir: string, value: Storage): void {
  replaceAtomically(configDir, join(configDir, CREDENTIALS_FILE), JSON.stringify(value));
}

export const fileCredentialStore: ClaudeCredentialStore = {
  read: readFileStore,
  async write(configDir, value) {
    writeFileStore(configDir, value);
  },
  async writeFile(configDir, value) {
    writeFileStore(configDir, value);
  },
  primaryHolds: async () => false,
  async remove(configDir) {
    await rm(join(configDir, CREDENTIALS_FILE), { force: true });
  },
};

const execFileAsync = promisify(execFile);

/** Same command shape as the CLI: hex payload over stdin, so the value is not in argv. */
async function writeKeychain(service: string, account: string, json: string): Promise<void> {
  const hex = Buffer.from(json, "utf8").toString("hex");
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  if (line.length > SECURITY_STDIN_LIMIT) throw new ClaudeCredentialReadError();
  const pending = execFileAsync("security", ["-i"], { timeout: KEYCHAIN_TIMEOUT_MS });
  pending.child.stdin?.end(line);
  try {
    await pending;
  } catch {
    throw new ClaudeCredentialReadError();
  }
}

function readKeychainItem(configDir: string): Promise<unknown> {
  return readClaudeAccountKeychainCredentialsStrict(
    claudeKeychainServiceForConfigDir(configDir),
    claudeKeychainAccount(),
  );
}

async function deleteKeychainItem(configDir: string): Promise<void> {
  try {
    await execFileAsync(
      "security",
      [
        "delete-generic-password",
        "-a",
        claudeKeychainAccount(),
        "-s",
        claudeKeychainServiceForConfigDir(configDir),
      ],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
  } catch (error) {
    // errSecItemNotFound: already gone.
    if (!(error instanceof Error && "code" in error && error.code === 44))
      throw new ClaudeCredentialReadError();
  }
}

/** The pinned CLI's macOS storage: the per-directory Keychain item, then the fallback file. */
export const keychainCredentialStore: ClaudeCredentialStore = {
  async read(configDir) {
    const item = await readKeychainItem(configDir);
    if (item !== null && item !== undefined) {
      const storage = asObject(item);
      if (!storage) throw new ClaudeCredentialReadError();
      return storage;
    }
    return readFileStore(configDir);
  },
  async writeFile(configDir, value) {
    writeFileStore(configDir, value);
    if ((await readKeychainItem(configDir)) !== null) await deleteKeychainItem(configDir);
  },
  primaryHolds: async (configDir) => (await readKeychainItem(configDir)) !== null,
  async write(configDir, value) {
    await writeKeychain(
      claudeKeychainServiceForConfigDir(configDir),
      claudeKeychainAccount(),
      JSON.stringify(value),
    );
    // The Keychain item now wins. Never leave a plaintext grant behind it.
    const fallback = await readFileStore(configDir).catch(() => null);
    if (fallback && "claudeAiOauth" in fallback) {
      const { claudeAiOauth: _shadowed, ...rest } = fallback;
      writeFileStore(configDir, rest);
    }
  },
  async remove(configDir) {
    await deleteKeychainItem(configDir);
    await fileCredentialStore.remove(configDir);
  },
};

export function platformCredentialStore(
  platform: NodeJS.Platform = process.platform,
): ClaudeCredentialStore {
  return platform === "darwin" ? keychainCredentialStore : fileCredentialStore;
}

function oauthOf(storage: Storage | null): OAuth | null {
  return asObject(storage?.claudeAiOauth) as OAuth | null;
}

function hasRefreshToken(oauth: OAuth | null): oauth is OAuth & { refreshToken: string } {
  return typeof oauth?.refreshToken === "string" && oauth.refreshToken.length > 0;
}

function expiryOf(oauth: OAuth | null): number {
  return typeof oauth?.expiresAt === "number" ? oauth.expiresAt : 0;
}

/** Everything the CLI stored about the grant except the refresh token. */
export function accessOnly(oauth: OAuth): OAuth {
  const { refreshToken: _withheld, ...withoutRefresh } = oauth;
  return withoutRefresh;
}

async function withLock<T>(dir: string, lock: LockOptions, run: () => Promise<T>): Promise<T> {
  const release = await acquireStorageLock(dir, lock);
  try {
    return await run();
  } finally {
    release();
  }
}

/** Display metadata the CLI keeps beside storage; the refresh request runs without onboarding. */
async function seedAuthorityProfile(agentDir: string, authorityDir: string): Promise<void> {
  const target = join(authorityDir, ".claude.json");
  if (await exists(target)) return;
  try {
    const profile = asObject(JSON.parse(await readFile(join(agentDir, ".claude.json"), "utf8")));
    if (!profile?.oauthAccount) return;
    replaceAtomically(authorityDir, target, JSON.stringify({ oauthAccount: profile.oauthAccount }));
  } catch {
    // Identity is display metadata and is still read from the account directory.
  }
}

export type ClaudeAdoption =
  /** The account directory holds no refresh token. */
  | "none"
  /** A refresh token was found, but too close to expiry to move safely. Retried next reconcile. */
  | "deferred"
  /** The login moved into the authority and the account directory now holds access only. */
  | "adopted"
  /** An older leftover refresh token was removed; the authority already holds a newer grant. */
  | "stripped";

export interface ClaudeCustodyInput {
  agentDir: string;
  authorityDir: string;
  store: ClaudeCredentialStore;
  now: number;
  lock?: LockOptions;
}

/**
 * Moves any refresh token found in the account directory into the authority. Idempotent and safe
 * to re-run: the only refresh token the coordinator never writes into an account directory is a
 * new sign-in (Vorteo sign-in, `/login` in an agent) or a pre-migration grant, and both are at
 * least as new as the authority's. An older one is a leftover from an interrupted run and is
 * dropped. The authority is written and verified before the account directory loses its token, so
 * agents always have a usable credential.
 */
export async function adoptClaudeGrant(input: ClaudeCustodyInput): Promise<ClaudeAdoption> {
  const lock = input.lock ?? {};
  return withLock(input.agentDir, lock, async () => {
    const agent = await input.store.read(input.agentDir);
    const found = oauthOf(agent);
    if (!hasRefreshToken(found)) return "none";
    const held = oauthOf(await input.store.read(input.authorityDir));
    const adopt =
      !hasRefreshToken(held) ||
      (found.refreshToken !== held.refreshToken && expiryOf(found) >= expiryOf(held));
    let source: OAuth;
    if (adopt) {
      if (expiryOf(found) - input.now < CLAUDE_ADOPTION_MARGIN_MS) return "deferred";
      await mkdir(input.authorityDir, { recursive: true, mode: 0o700 });
      await withLock(input.authorityDir, lock, async () => {
        await input.store.write(input.authorityDir, { claudeAiOauth: found });
        const written = oauthOf(await input.store.read(input.authorityDir));
        if (!written || written.refreshToken !== found.refreshToken)
          throw new ClaudeCredentialReadError();
      });
      await seedAuthorityProfile(input.agentDir, input.authorityDir);
      source = found;
    } else {
      source = held!;
    }
    await input.store.writeFile(input.agentDir, { ...agent, claudeAiOauth: accessOnly(source) });
    if (hasRefreshToken(oauthOf(await input.store.read(input.agentDir))))
      throw new ClaudeCredentialReadError();
    await mkdir(join(input.agentDir, PROJECTION_MARKER), { recursive: true, mode: 0o700 });
    return adopt ? "adopted" : "stripped";
  });
}

/**
 * Copies the authority's current access into the account directory. Leaves a directory that holds
 * a refresh token alone: that is a new sign-in, which `adoptClaudeGrant` takes first.
 */
export async function projectClaudeHostAccess(
  input: Omit<ClaudeCustodyInput, "now">,
): Promise<"written" | "unchanged" | "skipped"> {
  const held = oauthOf(await input.store.read(input.authorityDir));
  if (!held || typeof held.accessToken !== "string") return "skipped";
  return withLock(input.agentDir, input.lock ?? {}, async () => {
    const agent = await input.store.read(input.agentDir);
    const current = oauthOf(agent);
    if (hasRefreshToken(current)) return "skipped";
    const next = accessOnly(held);
    // A Keychain item recreated by another CLI save would shadow the file; move it back.
    if (isDeepStrictEqual(current, next) && !(await input.store.primaryHolds(input.agentDir)))
      return "unchanged";
    await input.store.writeFile(input.agentDir, { ...agent, claudeAiOauth: next });
    await mkdir(join(input.agentDir, PROJECTION_MARKER), { recursive: true, mode: 0o700 });
    return "written";
  });
}

/**
 * Rollback: returns the authority's full grant to the account directory and deletes the
 * authority, so an older coordinator or the agents' own CLIs can refresh again.
 */
export async function restoreClaudeGrant(
  input: Omit<ClaudeCustodyInput, "now">,
): Promise<"restored" | "none"> {
  if (!(await exists(input.authorityDir))) return "none";
  const lock = input.lock ?? {};
  return withLock(input.agentDir, lock, async () => {
    const held = oauthOf(await input.store.read(input.authorityDir));
    if (!hasRefreshToken(held)) {
      await rm(input.authorityDir, { recursive: true, force: true });
      return "none";
    }
    const agent = await input.store.read(input.agentDir);
    // A newer sign-in in the account directory wins; otherwise the authority's grant returns.
    if (!hasRefreshToken(oauthOf(agent))) {
      await input.store.write(input.agentDir, { ...agent, claudeAiOauth: held });
      if (oauthOf(await input.store.read(input.agentDir))?.refreshToken !== held.refreshToken)
        throw new ClaudeCredentialReadError();
    }
    await input.store.remove(input.authorityDir);
    await rm(input.authorityDir, { recursive: true, force: true });
    await rm(join(input.agentDir, PROJECTION_MARKER), { recursive: true, force: true });
    return "restored";
  });
}
