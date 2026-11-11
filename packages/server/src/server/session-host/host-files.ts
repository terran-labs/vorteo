import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, renameSync, statSync, constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
  open,
  realpath,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";

/**
 * Where a release keeps the session host entrypoint; a release without it has no support. Kept
 * here, not with the installer's job code, so the host itself can read it without loading that.
 */
export const SESSION_HOST_ENTRYPOINT = "packages/server/dist/scripts/session-host-entrypoint.js";

/**
 * The release directory the running host was started from, written by the host at startup. Host
 * release cleanup keeps that release: a long-lived host loads code and runs the bundled Claude
 * Code from it after newer installs have moved the release link on.
 */
export const SESSION_HOST_RELEASE_FILE_NAME = "release.json";

/** Read the actual private inode; a pathname or PID alone is not a generation. */
async function retentionFile(file: string, limit: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const identity = (info: typeof before) =>
      [info.dev, info.ino, info.mtimeNs, info.ctimeNs, info.size].join(":");
    if (
      !before.isFile() ||
      before.uid !== BigInt(currentUid()) ||
      (before.mode & 0o077n) !== 0n ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > BigInt(limit)
    )
      throw new SessionHostFileError(
        file,
        "Session host retention evidence is not a bounded private file.",
      );
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    if (
      BigInt(bytesRead) !== before.size ||
      identity(before) !== identity(after) ||
      identity(before) !== identity(named)
    )
      throw new SessionHostFileError(file, "Session host retention evidence changed during read.");
    return { text: bytes.subarray(0, bytesRead).toString("utf8"), generation: identity(before) };
  } finally {
    await handle.close();
  }
}

async function retentionLock(socketPath: string) {
  const file = `${socketPath}.lock`;
  const value = await retentionFile(file, 128);
  const pid = Number(value.text);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    (value.text !== String(pid) && value.text !== `${pid}\n`)
  )
    throw new SessionHostFileError(file, "Session host retention lock holder is unknown.");
  return { pid, generation: value.generation };
}

export async function writeSessionHostRelease(
  directory: string,
  releaseRoot: string,
): Promise<void> {
  const socketPath = path.join(directory, "host.sock");
  const lock = await retentionLock(socketPath);
  if (lock.pid !== process.pid || (await realpath(releaseRoot)) !== releaseRoot)
    throw new SessionHostFileError(
      directory,
      "Session host release requires its acquired lock and canonical root.",
    );
  const file = path.join(directory, SESSION_HOST_RELEASE_FILE_NAME);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, releaseRoot, pid: lock.pid, lockGeneration: lock.generation }),
      { mode: FILE_MODE, flag: "wx" },
    );
    const current = await retentionLock(socketPath);
    if (current.pid !== lock.pid || current.generation !== lock.generation)
      throw new SessionHostFileError(
        directory,
        "Session host lock changed before release publication.",
      );
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function retentionEvidenceAbsent(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** A checked snapshot, not a lifetime lease against a later host start. */
export async function readSessionHostRelease(paseoHome: string): Promise<string | null> {
  const paths = sessionHostPaths(paseoHome);
  const file = path.join(paths.directory, SESSION_HOST_RELEASE_FILE_NAME);
  let lock;
  try {
    lock = await retentionLock(paths.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A retained receipt without its lock cannot prove which generation exited.
    if (
      !(await retentionEvidenceAbsent(file)) ||
      !(await retentionEvidenceAbsent(`${paths.socketPath}.lock`)) ||
      !(await retentionEvidenceAbsent(file))
    )
      throw new SessionHostFileError(
        file,
        "Session host absence evidence changed or is incomplete.",
      );
    return null;
  }
  const receipt = await retentionFile(file, 8192);
  const value = JSON.parse(receipt.text) as {
    version?: unknown;
    pid?: unknown;
    lockGeneration?: unknown;
    releaseRoot?: unknown;
  };
  if (
    value.version !== 1 ||
    value.pid !== lock.pid ||
    value.lockGeneration !== lock.generation ||
    typeof value.releaseRoot !== "string" ||
    !path.isAbsolute(value.releaseRoot) ||
    (await realpath(value.releaseRoot)) !== value.releaseRoot
  )
    throw new SessionHostFileError(
      file,
      "Live session host release is unknown or belongs to another lock generation.",
    );
  let alive = true;
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    alive = false;
  }
  const current = await retentionLock(paths.socketPath);
  const currentReceipt = await retentionFile(file, 8192);
  if (
    current.pid !== lock.pid ||
    current.generation !== lock.generation ||
    currentReceipt.generation !== receipt.generation
  )
    throw new SessionHostFileError(file, "Session host lock changed during release inspection.");
  return alive ? value.releaseRoot : null;
}

/** Directory under PASEO_HOME that holds the host socket, token and audit log. */
export const SESSION_HOST_DIRECTORY_NAME = "session-host";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** macOS limits a unix socket path to 103 bytes plus the terminator. */
const MAX_SOCKET_PATH_BYTES = 103;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SessionHostPaths {
  directory: string;
  socketPath: string;
  tokenPath: string;
  auditLogPath: string;
  restartMarkerPath: string;
  upgradeMarkerPath: string;
}

/**
 * Written by the coordinator just before a tracked restart stops the host, and removed by the host
 * that starts next. While it exists, a worker that cannot reach the host treats it as returning
 * rather than stopped, even though a stopped host leaves no socket or lock behind.
 */
export const SESSION_HOST_RESTART_MARKER_NAME = "restarting";
/**
 * Written by a host that found a newer installed release, removed by the host that starts next.
 * Workers release idle hosted sessions while it exists, so the host reaches zero sessions and exits.
 */
export const SESSION_HOST_UPGRADE_MARKER_NAME = "upgrade-pending";

export function sessionHostPaths(paseoHome: string): SessionHostPaths {
  const directory = path.join(paseoHome, SESSION_HOST_DIRECTORY_NAME);
  return {
    directory,
    socketPath: path.join(directory, "host.sock"),
    tokenPath: path.join(directory, "token"),
    auditLogPath: path.join(directory, "audit.log"),
    restartMarkerPath: path.join(directory, SESSION_HOST_RESTART_MARKER_NAME),
    upgradeMarkerPath: path.join(directory, SESSION_HOST_UPGRADE_MARKER_NAME),
  };
}

export class SessionHostFileError extends Error {
  constructor(
    readonly target: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionHostFileError";
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("The session host requires a POSIX platform.");
  return uid;
}

/**
 * Creates or tightens the host directory. It must be a real directory owned by this user with no
 * group or other access; the token file inside it is the capability that drives sessions.
 */
export async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new SessionHostFileError(directory, "The session host path is not a real directory.");
  if (stats.uid !== currentUid())
    throw new SessionHostFileError(directory, "The session host directory has another owner.");
  await chmod(directory, DIRECTORY_MODE);
  const verified = await lstat(directory);
  if ((verified.mode & 0o777) !== DIRECTORY_MODE)
    throw new SessionHostFileError(directory, "The session host directory is not private.");
}

/**
 * Writes a fresh token for this host run. Every host start rotates it, so a token read by an
 * earlier worker or process stops working once that host generation is gone.
 */
export async function rotateSessionHostToken(paths: SessionHostPaths): Promise<string> {
  await preparePrivateDirectory(paths.directory);
  const token = randomBytes(32).toString("base64url");
  const temporary = path.join(paths.directory, `.token.${process.pid}.${randomUUID()}`);
  try {
    await writeFile(temporary, `${token}\n`, { mode: FILE_MODE, flag: "wx" });
    await chmod(temporary, FILE_MODE);
    await rename(temporary, paths.tokenPath);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return token;
}

/** Reads the current token, refusing one that another user could have read or replaced. */
export async function readSessionHostToken(paths: SessionHostPaths): Promise<string> {
  const stats = await lstat(paths.tokenPath);
  if (!stats.isFile() || stats.uid !== currentUid() || (stats.mode & 0o077) !== 0)
    throw new SessionHostFileError(paths.tokenPath, "The session host token file is not private.");
  const token = (await readFile(paths.tokenPath, "utf8")).trim();
  if (!TOKEN_PATTERN.test(token))
    throw new SessionHostFileError(paths.tokenPath, "The session host token file is malformed.");
  return token;
}

export class SessionHostAlreadyRunningError extends Error {
  constructor(readonly socketPath: string) {
    super("Another session host is already serving this socket.");
    this.name = "SessionHostAlreadyRunningError";
  }
}

function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export interface SessionHostLock {
  release(): Promise<void>;
}

/** A lock this old whose socket does not answer belongs to an exited host. */
const LOCK_STALE_AFTER_MS = 30_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockIsStale(lockPath: string, socketPath: string): Promise<boolean> {
  const [content, stats] = await Promise.all([
    readFile(lockPath, "utf8").catch(() => null),
    lstat(lockPath).catch(() => null),
  ]);
  // A lock that vanished meanwhile can simply be retried.
  if (content === null || !stats) return true;
  const age = Date.now() - stats.mtimeMs;
  const holder = Number.parseInt(content.trim(), 10);
  // An empty lock may still be in the middle of being written by a starting host.
  if (!Number.isSafeInteger(holder) || holder <= 0) return age > LOCK_STALE_AFTER_MS;
  if (holder !== process.pid && !processAlive(holder)) return true;
  // A living holder that never answers on the socket is most likely a reused process id.
  return age > LOCK_STALE_AFTER_MS && !(await probeSocket(socketPath));
}

/**
 * What the host lock proves. Only an absent lock or a holder pid that no longer exists means the
 * host is gone, and with it every session it ran. A lock that cannot be read, is still being
 * written, or names a pid that cannot be checked reads as alive, so callers wait rather than act.
 *
 * A killed host never removes its lock. That is deliberate: the dead pid left behind is what tells
 * workers the host is gone, and the next host takes the stale lock over.
 */
export type SessionHostLockState =
  | { state: "gone"; pid: number | null }
  | { state: "alive"; pid: number | null };

export async function readSessionHostLock(socketPath: string): Promise<SessionHostLockState> {
  let content: string;
  try {
    content = await readFile(`${socketPath}.lock`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "gone", pid: null };
    return { state: "alive", pid: null };
  }
  const holder = Number.parseInt(content.trim(), 10);
  if (!Number.isSafeInteger(holder) || holder <= 0) return { state: "alive", pid: null };
  try {
    process.kill(holder, 0);
    return { state: "alive", pid: holder };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { state: "gone", pid: holder };
    return { state: "alive", pid: holder };
  }
}

/**
 * Holds `<socket>.lock` for the life of one host so two hosts never serve one socket, even when
 * they start together. launchd already runs one instance per label; this keeps the library safe
 * without it. A lock left by an exited process is taken over.
 */
export async function acquireHostLock(socketPath: string): Promise<SessionHostLock> {
  const lockPath = `${socketPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: FILE_MODE, flag: "wx" });
      return {
        async release() {
          const holder = await readFile(lockPath, "utf8").catch(() => "");
          if (holder.trim() === String(process.pid)) await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lockIsStale(lockPath, socketPath)))
      throw new SessionHostAlreadyRunningError(socketPath);
    await rm(lockPath, { force: true });
  }
  throw new SessionHostAlreadyRunningError(socketPath);
}

/**
 * Makes the socket path available to a new host. A live socket belongs to a running host and is
 * never unlinked, so a second host cannot silently take over the sessions of the first. Only a
 * stale socket left by an exited host is removed; any other file type is refused.
 */
export async function claimSocketPath(socketPath: string): Promise<void> {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES)
    throw new SessionHostFileError(socketPath, "The session host socket path is too long.");
  const stats = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return;
  if (!stats.isSocket())
    throw new SessionHostFileError(socketPath, "The session host socket path is not a socket.");
  if (await probeSocket(socketPath)) throw new SessionHostAlreadyRunningError(socketPath);
  await rm(socketPath, { force: true });
}

/** Attach, detach and authentication outcomes. Never include tokens, prompts or config. */
export interface SessionHostAuditRecord {
  event: string;
  connectionId?: string;
  sessionId?: string;
  [detail: string]: string | number | boolean | null | undefined;
}

export type SessionHostAuditSink = (record: SessionHostAuditRecord) => void;

/** Appends one line to a private, size-capped file. */
export type RotatingAppender = (line: string) => void;

/**
 * Appends lines to a private file synchronously, so the last lines before an exit survive, and
 * keeps one rotated predecessor once the file would pass maxBytes. Failures are reported to
 * onError and never thrown, since losing a log line must not interrupt the host.
 */
export function createRotatingAppender(input: {
  path: string;
  maxBytes?: number;
  onError?: (error: unknown) => void;
}): RotatingAppender {
  const maxBytes = input.maxBytes ?? 5 * 1024 * 1024;
  // Creation modes do not tighten files left by an earlier host, so tighten them here.
  for (const existing of [input.path, `${input.path}.1`]) {
    try {
      chmodSync(existing, FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") input.onError?.(error);
    }
  }
  return (line) => {
    try {
      const size = statSync(input.path, { throwIfNoEntry: false })?.size ?? 0;
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes)
        renameSync(input.path, `${input.path}.1`);
      appendFileSync(input.path, line, { mode: FILE_MODE });
    } catch (error) {
      input.onError?.(error);
    }
  };
}

/** Appends audit records as JSON lines to a private file, keeping one rotated predecessor. */
export function createSessionHostAuditLog(input: {
  path: string;
  maxBytes?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}): SessionHostAuditSink {
  const now = input.now ?? (() => new Date());
  const append = createRotatingAppender(input);
  return (record) => {
    let line: string;
    try {
      line = `${JSON.stringify({ at: now().toISOString(), ...record })}\n`;
    } catch (error) {
      input.onError?.(error);
      return;
    }
    append(line);
  };
}
