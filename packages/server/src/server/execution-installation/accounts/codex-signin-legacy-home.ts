import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import { isTrustedCredentialsFile, replaceAtomically } from "./claude-oauth-credentials-file.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import { CODEX_SIGNIN_STATE_DIRECTORY } from "./codex-signin-auth-file.js";
import { sameCodexSignIn } from "./codex-signin-identity.js";
import {
  CodexSignInDeliveryError,
  type CodexAccessProjection,
  type CodexLegacyTarget,
} from "./codex-signin-delivery.js";
import { HostProjectionRefusal, type HostProjectionStoreResult } from "./host-owned-projection.js";

/**
 * An adopted legacy Codex home keeps its own CODEX_HOME and thread history; only its `auth.json`
 * changes. Because Dev's provider config is writable by agents, every write first proves the
 * home is the one the owner adopted, and the writer replaces only a sign-in it can attribute.
 */

const AUTH_FILE = "auth.json";
/** The local sign-in a projection replaced, kept so un-adopt can put it back. */
const LOCAL_SIGN_IN_COPY = "local-sign-in.json";
/** SHA-256 of the exact `auth.json` bytes this consumer wrote: the latest and the one before. */
const WRITTEN = "written.json";

const WrittenSchema = z.strictObject({
  digests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2),
});
const LocalSignInSchema = z.object({
  tokens: z.object({
    refresh_token: z.string().min(1),
    account_id: z.string().nullish(),
    id_token: z.string().nullish(),
  }),
});

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

/**
 * Pins a configured CODEX_HOME. Every path component must be a real directory, not a symbolic
 * link, and the home itself must belong to this daemon's user and be writable by no one else.
 * An ownership check can misfire across a virtiofs user mapping; it only ever refuses.
 */
export function pinCodexHome(home: string): CodexLegacyTarget {
  if (!isAbsolute(home) || normalize(home) !== home || home.endsWith(sep))
    throw new CodexSignInDeliveryError();
  let current: string = sep;
  try {
    for (const part of home.split(sep).filter(Boolean)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new CodexSignInDeliveryError();
    }
    const stat = lstatSync(home, { bigint: true });
    const uid = process.getuid?.();
    if (
      !stat.isDirectory() ||
      (uid !== undefined && stat.uid !== BigInt(uid)) ||
      (stat.mode & 0o022n) !== 0n ||
      realpathSync(home) !== home
    )
      throw new CodexSignInDeliveryError();
    return { realpath: home, dev: stat.dev.toString(), ino: stat.ino.toString() };
  } catch {
    throw new CodexSignInDeliveryError();
  }
}

/** Whether another configured home resolves to the same directory as this target. */
export function sharesCodexHome(target: CodexLegacyTarget, others: readonly string[]): boolean {
  return others.some((other) => {
    try {
      const resolved = realpathSync(other);
      const stat = lstatSync(resolved, { bigint: true });
      return (
        resolved === target.realpath ||
        (stat.dev.toString() === target.dev && stat.ino.toString() === target.ino)
      );
    } catch {
      // A home that does not exist yet cannot be the adopted directory.
      return false;
    }
  });
}

function stateFile(home: string, name: string): string {
  return join(home, CODEX_SIGNIN_STATE_DIRECTORY, name);
}

function digestOf(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** The exact current bytes, or null when there is no file. A link or foreign file refuses. */
function readCurrent(file: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw new CodexSignInDeliveryError();
  }
  try {
    if (!isTrustedCredentialsFile(fstatSync(descriptor))) throw new CodexSignInDeliveryError();
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function readWritten(home: string): string[] {
  const value = readClaudeSetupFile(stateFile(home, WRITTEN));
  if (value === null) return [];
  const parsed = WrittenSchema.safeParse(value);
  if (!parsed.success) throw new CodexSignInDeliveryError();
  return parsed.data.digests;
}

/** A refresh sign-in made in this environment, with its ChatGPT workspace and ID token. */
function localSignIn(
  contents: string,
): { accountId: string | null; idToken: string | null; value: unknown } | null {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  const parsed = LocalSignInSchema.safeParse(value);
  if (!parsed.success) return null;
  const { account_id, id_token } = parsed.data.tokens;
  return { accountId: account_id ?? null, idToken: id_token ?? null, value };
}

function projectionContents(access: CodexAccessProjection): string {
  // An empty refresh token, never a real one: Dev Codex cannot rotate the Host's grant.
  return JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: access.idToken,
        access_token: access.accessToken,
        refresh_token: "",
        account_id: access.accountId,
      },
      last_refresh: access.lastRefresh,
    },
    null,
    2,
  );
}

/**
 * Writes or withdraws the projection in an adopted legacy home. It replaces only a refresh
 * sign-in of the same person in the Host's ChatGPT workspace, or a projection it wrote itself, recognised by the
 * digest of the bytes it wrote. An API-key login, a file with an empty refresh token it did not
 * write, another account and anything unparseable refuse and stay untouched. A withdrawal
 * removes only its own projection.
 */
export function writeLegacyCodexProjection(
  home: string,
  access: CodexAccessProjection | null,
  options: { keepLocalSignIn: boolean },
): HostProjectionStoreResult {
  const file = join(home, AUTH_FILE);
  const current = readCurrent(file);
  const written = readWritten(home);
  const ours = current !== null && written.includes(digestOf(current));
  if (!access) {
    if (ours) {
      try {
        unlinkSync(file);
      } catch (error) {
        if (code(error) !== "ENOENT") throw new CodexSignInDeliveryError();
      }
      writeClaudeSetupFile(stateFile(home, WRITTEN), { digests: [] });
    }
    return { replacedLocally: false };
  }
  let replacedLocally = false;
  if (current !== null && !ours) {
    const local = localSignIn(current);
    if (!local || !sameCodexSignIn(local, access))
      throw new HostProjectionRefusal("existing_sign_in");
    // Each adoption keeps the latest sign-in Dev made, which un-adopt restores.
    if (options.keepLocalSignIn)
      writeClaudeSetupFile(stateFile(home, LOCAL_SIGN_IN_COPY), local.value);
    replacedLocally = written.length > 0;
  } else if (current !== null && digestOf(current) !== written.at(-1)) {
    replacedLocally = true;
  }
  const contents = projectionContents(access);
  const digest = digestOf(contents);
  // A repeated delivery of the current projection leaves the file alone.
  if (current !== null && digestOf(current) === digest && written.at(-1) === digest)
    return { replacedLocally: false };
  // Recorded before the rename, so either file a crash leaves behind is still recognised.
  const latest = written.at(-1);
  const digests = latest && latest !== digest ? [latest, digest] : [digest];
  writeClaudeSetupFile(stateFile(home, WRITTEN), { digests });
  replaceAtomically(home, file, contents);
  return { replacedLocally };
}

export type LegacyRestoreResult = { restored: false } | { restored: true; copyAgeMs: number };

/**
 * Puts the saved local sign-in back, untested, after the projection is withdrawn. A file already
 * in place, from any source, is left alone.
 */
export function restoreLegacyCodexSignIn(home: string, now: number): LegacyRestoreResult {
  const file = join(home, AUTH_FILE);
  const copy = stateFile(home, LOCAL_SIGN_IN_COPY);
  if (readCurrent(file) !== null) return { restored: false };
  const saved = readClaudeSetupFile(copy);
  if (saved === null) return { restored: false };
  const savedAt = lstatSync(copy).mtimeMs;
  replaceAtomically(home, file, JSON.stringify(saved, null, 2));
  unlinkSync(copy);
  return { restored: true, copyAgeMs: Math.max(0, Math.round(now - savedAt)) };
}

export function forgetLegacyCodexSignIn(home: string): void {
  try {
    unlinkSync(stateFile(home, LOCAL_SIGN_IN_COPY));
  } catch (error) {
    if (code(error) !== "ENOENT") throw new CodexSignInDeliveryError();
  }
}
