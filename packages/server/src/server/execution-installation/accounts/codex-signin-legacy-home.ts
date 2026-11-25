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
import { codexSignInKeyDigest, sameCodexSignIn } from "./codex-signin-identity.js";
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
/**
 * The definition those bytes were written for, so a projection is ours only in its own account's
 * home. Kept apart from `written.json`, whose strict reader on older daemons would refuse it.
 */
const DEFINITION = "definition.json";
/** The person the saved local sign-in names, as a one-way digest, recorded when it was saved. */
const LOCAL_SIGN_IN_PERSON = "local-sign-in-person.json";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const WrittenSchema = z.strictObject({ digests: z.array(Digest).max(2) });
const DefinitionSchema = z.object({ definition: Digest });
const PersonSchema = z.object({ person: Digest });
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

/** A home pinned just now: its device and inode are always known. */
export type PinnedCodexHome = Required<CodexLegacyTarget>;

/** Who wrote a legacy home's projection, as far as the writer can tell. */
export interface LegacyHomeOwner {
  definitionId: string;
  /**
   * The definition this home's delivery journal named before the current delivery, or null.
   * Only consulted for a home the first adoption release wrote, which has no definition file.
   */
  journalDefinition: string | null;
}

/**
 * Pins a configured CODEX_HOME. Every path component must be a real directory, not a symbolic
 * link, and the home itself must belong to this daemon's user and be writable by no one else.
 * An ownership check can misfire across a virtiofs user mapping; it only ever refuses.
 */
export function pinCodexHome(home: string): PinnedCodexHome {
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
export function sharesCodexHome(target: PinnedCodexHome, others: readonly string[]): boolean {
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

/**
 * Whether the home has its state directory. It must be a real directory, not a symbolic link,
 * owned by this daemon's user and writable by no one else; anything else refuses. Every state
 * file is then opened with O_NOFOLLOW, and unlink never follows the last path component.
 */
function stateDirectory(home: string): boolean {
  let stat;
  try {
    stat = lstatSync(join(home, CODEX_SIGNIN_STATE_DIRECTORY));
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw new CodexSignInDeliveryError();
  }
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0)
    throw new CodexSignInDeliveryError();
  return true;
}

function removeStateFile(home: string, name: string): void {
  try {
    unlinkSync(stateFile(home, name));
  } catch (error) {
    if (code(error) !== "ENOENT") throw new CodexSignInDeliveryError();
  }
}

/** Opaque on disk, so a home names no definition ID. */
function definitionKey(definitionId: string): string {
  return createHash("sha256").update(`codex-adoption\n${definitionId}`).digest("hex");
}

function readDefinition(home: string): string | null {
  const value = readClaudeSetupFile(stateFile(home, DEFINITION));
  if (value === null) return null;
  const parsed = DefinitionSchema.safeParse(value);
  if (!parsed.success) throw new CodexSignInDeliveryError();
  return parsed.data.definition;
}

/** Whether this home's state belongs to the owner's definition. */
function boundTo(home: string, owner: LegacyHomeOwner): boolean {
  const definition = readDefinition(home);
  // COMPAT(codexLegacyPinByPath): added after 26.11.2100, remove after 2027-05-25. A home the
  // first adoption release wrote has no definition file; its projection counts as this
  // definition's only when its delivery journal already named this definition.
  if (definition === null) return owner.journalDefinition === owner.definitionId;
  return definition === definitionKey(owner.definitionId);
}

/** The digests this writer recorded for the owner's definition; none for another one's. */
function attributedDigests(home: string, owner: LegacyHomeOwner): string[] {
  return boundTo(home, owner) ? readWritten(home) : [];
}

/** The one-way digest of the person a saved Codex sign-in names, or null. */
function personOf(value: unknown): string | null {
  const parsed = LocalSignInSchema.safeParse(value);
  if (!parsed.success) return null;
  return codexSignInKeyDigest(parsed.data.tokens.account_id ?? null, parsed.data.tokens.id_token);
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
 * sign-in of the same person in the Host's ChatGPT workspace, or a projection it wrote itself
 * for this definition, recognised by the digest of the bytes it wrote and the definition they
 * were written for. A projection written for another definition, an API-key login, a file with
 * an empty refresh token it did not write, another account and anything unparseable refuse and
 * stay untouched. A withdrawal removes only its own projection.
 */
export function writeLegacyCodexProjection(
  home: string,
  access: CodexAccessProjection | null,
  options: LegacyHomeOwner & { keepLocalSignIn: boolean },
): HostProjectionStoreResult {
  stateDirectory(home);
  const file = join(home, AUTH_FILE);
  const current = readCurrent(file);
  const written = attributedDigests(home, options);
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
    if (options.keepLocalSignIn) {
      writeClaudeSetupFile(stateFile(home, LOCAL_SIGN_IN_COPY), local.value);
      writeClaudeSetupFile(stateFile(home, LOCAL_SIGN_IN_PERSON), {
        person: personOf(local.value),
      });
    }
    replacedLocally = written.length > 0;
  } else if (current !== null && digestOf(current) !== written.at(-1)) {
    replacedLocally = true;
  }
  const contents = projectionContents(access);
  const digest = digestOf(contents);
  const key = definitionKey(options.definitionId);
  const recorded = readDefinition(home) === key;
  // A repeated delivery of the current projection leaves the file alone.
  if (recorded && current !== null && digestOf(current) === digest && written.at(-1) === digest)
    return { replacedLocally: false };
  // The definition first, then the digests, then the file: whatever a crash leaves behind is
  // still recognised as this definition's.
  if (!recorded) writeClaudeSetupFile(stateFile(home, DEFINITION), { definition: key });
  const latest = written.at(-1);
  const digests = latest && latest !== digest ? [latest, digest] : [digest];
  writeClaudeSetupFile(stateFile(home, WRITTEN), { digests });
  replaceAtomically(home, file, contents);
  return { replacedLocally };
}

/** What a legacy home's `auth.json` holds, for resuming a paused adoption. */
export function inspectLegacyCodexHome(
  home: string,
  owner: LegacyHomeOwner,
): "projection" | "none" | "other" {
  stateDirectory(home);
  const current = readCurrent(join(home, AUTH_FILE));
  if (current === null) return "none";
  return attributedDigests(home, owner).includes(digestOf(current)) ? "projection" : "other";
}

export type LegacyRestoreResult = { restored: false } | { restored: true; copyAgeMs: number };

/**
 * Puts the saved local sign-in back, untested, after the projection is withdrawn. A file already
 * in place, from any source, is left alone. A home whose state another definition wrote, or a
 * saved sign-in of anyone but `persons` when the coordinator names them, refuses.
 */
export function restoreLegacyCodexSignIn(
  home: string,
  now: number,
  options: { definitionId: string; persons: readonly string[] | undefined },
): LegacyRestoreResult {
  const file = join(home, AUTH_FILE);
  const copy = stateFile(home, LOCAL_SIGN_IN_COPY);
  if (!stateDirectory(home)) return { restored: false };
  const definition = readDefinition(home);
  if (definition !== null && definition !== definitionKey(options.definitionId))
    throw new CodexSignInDeliveryError();
  if (readCurrent(file) !== null) return { restored: false };
  const saved = readClaudeSetupFile(copy);
  if (saved === null) return { restored: false };
  if (options.persons) {
    const person = personOf(saved);
    const recorded = readClaudeSetupFile(stateFile(home, LOCAL_SIGN_IN_PERSON));
    // COMPAT(codexLegacyPinByPath): added after 26.11.2100, remove after 2027-05-25. A copy the
    // first adoption release saved has no recorded person; its own contents name one.
    const named = recorded === null ? person : PersonSchema.safeParse(recorded).data?.person;
    if (person === null || named !== person || !options.persons.includes(person))
      throw new CodexSignInDeliveryError();
  }
  const savedAt = lstatSync(copy).mtimeMs;
  replaceAtomically(home, file, JSON.stringify(saved, null, 2));
  unlinkSync(copy);
  removeStateFile(home, LOCAL_SIGN_IN_PERSON);
  return { restored: true, copyAgeMs: Math.max(0, Math.round(now - savedAt)) };
}

/**
 * Deletes the saved local sign-in. A home whose state another definition now owns holds that
 * definition's copy, not this one's, and is left alone.
 */
export function forgetLegacyCodexSignIn(home: string, definitionId: string): void {
  if (!stateDirectory(home)) return;
  const definition = readDefinition(home);
  if (definition !== null && definition !== definitionKey(definitionId)) return;
  removeStateFile(home, LOCAL_SIGN_IN_COPY);
  removeStateFile(home, LOCAL_SIGN_IN_PERSON);
}
