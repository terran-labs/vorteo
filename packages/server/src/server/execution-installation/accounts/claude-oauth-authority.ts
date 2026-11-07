import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, stat, utimes } from "node:fs/promises";
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

export function authorityName(definitionId: string): string {
  return createHash("sha256").update(definitionId).digest("hex").slice(0, 32);
}

/** The coordinator-only directory that holds an account's refresh token. */
export function claudeAuthorityDir(stateDir: string, definitionId: string): string {
  return join(stateDir, "claude-oauth", "authority", authorityName(definitionId));
}

/**
 * Custody is opt-in per account: adoption runs only while this marker exists. Removing it returns
 * the account's grant to its own directory on the next read.
 */
export function claudeAuthorityEnabledFile(stateDir: string, definitionId: string): string {
  return join(stateDir, "claude-oauth", "authority-enabled", authorityName(definitionId));
}

/** Global kill switch: when present, every login returns to its account directory. */
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

/**
 * The CLI's refresh locks (Claude Code 2.1.316 `Cki`): proper-lockfile directories at
 * `<dir>/.oauth_refresh.lock` and then `<realpath(dir)>.lock`, stale after 60 seconds, refreshed
 * by their holder every 5 seconds. A CLI refreshing after a 401 holds them from before its token
 * request until after its save, and discards its own result if the stored refresh token changed
 * meanwhile. Holding them while a grant moves keeps that refresh from consuming a token the
 * authority has just adopted. Taken in the CLI's order, before `.storage-write.lock`.
 */
const REFRESH_LOCK_STALE_MS = 60_000;
const REFRESH_LOCK_UPDATE_MS = 5_000;

async function mkdirLock(path: string, lock: LockOptions, attempts: number): Promise<boolean> {
  const now = lock.now ?? Date.now;
  const sleep = lock.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await mkdir(path, { mode: 0o700 });
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
        throw new ClaudeCredentialReadError();
    }
    try {
      const held = await stat(path);
      if (now() - held.mtimeMs > REFRESH_LOCK_STALE_MS) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (attempt < attempts - 1) await sleep(250);
  }
  return false;
}

/** Both refresh locks, or null while a CLI holds either. Release with the returned function. */
export async function acquireRefreshLocks(
  dir: string,
  lock: LockOptions = {},
): Promise<(() => Promise<void>) | null> {
  const attempts = lock.attempts ?? 8;
  const paths = [join(dir, ".oauth_refresh.lock"), `${await realpath(dir).catch(() => dir)}.lock`];
  const taken: string[] = [];
  const release = async () => {
    clearInterval(timer);
    for (const path of taken.toReversed()) await rm(path, { recursive: true, force: true });
  };
  // Keep the locks fresh like proper-lockfile, so a waiting CLI never treats them as stale.
  const timer = setInterval(() => {
    const at = new Date();
    for (const path of taken) void utimes(path, at, at).catch(() => {});
  }, REFRESH_LOCK_UPDATE_MS);
  timer.unref();
  for (const path of paths) {
    if (await mkdirLock(path, lock, attempts)) taken.push(path);
    else {
      await release();
      return null;
    }
  }
  return release;
}

const RETIRED_FILE = ".vorteo-retired.json";
const OWNER_FILE = ".vorteo-owner.json";
const RETIRED_LIMIT = 32;

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Digests of every refresh token the authority has held. Secret-free: one-way and salted by entropy. */
async function readRetired(authorityDir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(authorityDir, RETIRED_FILE), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function remember(authorityDir: string, token: string): Promise<void> {
  const retired = await readRetired(authorityDir);
  const digest = tokenDigest(token);
  if (retired.includes(digest)) return;
  const next = [...retired, digest].slice(-RETIRED_LIMIT);
  replaceAtomically(authorityDir, join(authorityDir, RETIRED_FILE), JSON.stringify(next));
}

/**
 * Records the authority's current refresh token as one it has held. Called after every authority
 * read, including after a refresh, so a copy of it found later in an account directory is known
 * to be a leftover and is never adopted back.
 */
export async function rememberAuthorityToken(
  authorityDir: string,
  store: ClaudeCredentialStore,
): Promise<void> {
  const held = oauthOf(await store.read(authorityDir));
  if (hasRefreshToken(held)) await remember(authorityDir, held.refreshToken);
}

/** Which definition an authority directory belongs to, for cleanup after removal. */
export async function authorityOwner(authorityDir: string): Promise<string | null> {
  try {
    const parsed = asObject(JSON.parse(await readFile(join(authorityDir, OWNER_FILE), "utf8")));
    return typeof parsed?.definitionId === "string" ? parsed.definitionId : null;
  } catch {
    return null;
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
  /** Close to expiry, or a CLI holds its refresh lock. Retried on the next read. */
  | "deferred"
  /** The login moved into the authority and the account directory now holds access only. */
  | "adopted"
  /** A token the authority already held was removed from the account directory. */
  | "stripped";

export interface ClaudeCustodyInput {
  definitionId: string;
  agentDir: string;
  authorityDir: string;
  store: ClaudeCredentialStore;
  now: number;
  lock?: LockOptions;
}

/**
 * Moves any refresh token found in the account directory into the authority. Idempotent and safe
 * to re-run. A token the authority has held before is a leftover from an interrupted run and is
 * only removed; any other token is a new sign-in (Vorteo sign-in, `/login` in an agent) or the
 * pre-migration grant, and is adopted. The authority is written and verified before the account
 * directory loses its token, so agents always have a usable credential. The CLI's refresh and
 * storage locks are held throughout.
 */
export async function adoptClaudeGrant(input: ClaudeCustodyInput): Promise<ClaudeAdoption> {
  const lock = input.lock ?? {};
  const releaseRefresh = await acquireRefreshLocks(input.agentDir, lock);
  if (!releaseRefresh) return "deferred";
  try {
    return await withLock(input.agentDir, lock, async () => {
      const agent = await input.store.read(input.agentDir);
      const found = oauthOf(agent);
      if (!hasRefreshToken(found)) return "none";
      const held = oauthOf(await input.store.read(input.authorityDir));
      const retired = await readRetired(input.authorityDir);
      const adopt =
        found.refreshToken !== held?.refreshToken &&
        !retired.includes(tokenDigest(found.refreshToken));
      if (adopt && expiryOf(found) - input.now < CLAUDE_ADOPTION_MARGIN_MS) return "deferred";
      // Without a live authority grant there is no access to project in place of the token.
      if (!adopt && !hasRefreshToken(held)) return "deferred";
      const source: OAuth = adopt ? found : held!;
      if (adopt) {
        await mkdir(input.authorityDir, { recursive: true, mode: 0o700 });
        await withLock(input.authorityDir, lock, async () => {
          await input.store.write(input.authorityDir, { claudeAiOauth: found });
          const written = oauthOf(await input.store.read(input.authorityDir));
          if (!written || written.refreshToken !== found.refreshToken)
            throw new ClaudeCredentialReadError();
          await remember(input.authorityDir, found.refreshToken);
          replaceAtomically(
            input.authorityDir,
            join(input.authorityDir, OWNER_FILE),
            JSON.stringify({ definitionId: input.definitionId }),
          );
        });
        await seedAuthorityProfile(input.agentDir, input.authorityDir);
      }
      await input.store.writeFile(input.agentDir, { ...agent, claudeAiOauth: accessOnly(source) });
      if (hasRefreshToken(oauthOf(await input.store.read(input.agentDir))))
        throw new ClaudeCredentialReadError();
      await mkdir(join(input.agentDir, PROJECTION_MARKER), { recursive: true, mode: 0o700 });
      return adopt ? "adopted" : "stripped";
    });
  } finally {
    await releaseRefresh();
  }
}

/**
 * Copies the authority's current access into the account directory. Leaves a directory that holds
 * a refresh token alone: that is a new sign-in or a leftover, which `adoptClaudeGrant` handles.
 */
export async function projectClaudeHostAccess(
  input: Omit<ClaudeCustodyInput, "now" | "definitionId">,
): Promise<"written" | "unchanged" | "skipped"> {
  const held = oauthOf(await input.store.read(input.authorityDir));
  if (!held || typeof held.accessToken !== "string" || !held.accessToken) return "skipped";
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

/** Deletes an authority and its stored grant. */
export async function removeAuthority(
  authorityDir: string,
  store: ClaudeCredentialStore,
): Promise<void> {
  if (!(await exists(authorityDir))) return;
  await store.remove(authorityDir);
  await rm(authorityDir, { recursive: true, force: true });
}

/**
 * Rollback: returns the authority's full grant to the account directory and deletes the
 * authority, so an older coordinator or the agents' own CLIs can refresh again. Holds the CLI's
 * refresh and storage locks; throws while a CLI holds them, so the next read retries.
 */
export async function restoreClaudeGrant(
  input: Omit<ClaudeCustodyInput, "now" | "definitionId">,
): Promise<"restored" | "none"> {
  if (!(await exists(input.authorityDir))) return "none";
  const lock = input.lock ?? {};
  const releaseRefresh = await acquireRefreshLocks(input.agentDir, lock);
  if (!releaseRefresh) throw new ClaudeCredentialReadError();
  try {
    return await withLock(input.agentDir, lock, async () => {
      const held = oauthOf(await input.store.read(input.authorityDir));
      if (!hasRefreshToken(held)) {
        await removeAuthority(input.authorityDir, input.store);
        return "none";
      }
      const agent = await input.store.read(input.agentDir);
      const present = oauthOf(agent);
      const retired = await readRetired(input.authorityDir);
      // A sign-in the authority never held wins; a leftover or an access copy is replaced.
      const newer =
        hasRefreshToken(present) && !retired.includes(tokenDigest(present.refreshToken));
      if (!newer) {
        await input.store.write(input.agentDir, { ...agent, claudeAiOauth: held });
        if (oauthOf(await input.store.read(input.agentDir))?.refreshToken !== held.refreshToken)
          throw new ClaudeCredentialReadError();
      }
      await removeAuthority(input.authorityDir, input.store);
      await rm(join(input.agentDir, PROJECTION_MARKER), { recursive: true, force: true });
      return "restored";
    });
  } finally {
    await releaseRefresh();
  }
}
