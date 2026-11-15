import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { removeBootstrapRelease } from "./coordinator-bootstrap-release-seal.js";

const runCommand = promisify(execFile);

/** Host source update jobs build into a folder named by their lifecycle job ID. */
const JOB_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const JOB_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * A job folder set aside for removal, still whole: `.pruning-<job id>-<run nonce>`. The rename
 * is atomic, so from that moment nothing can start from the release's path; whatever started
 * earlier is found by the in-use check that follows, and the folder is put back under its own
 * name. The nonce binds the name to one cleanup. The form without a nonce is from before it.
 */
const SET_ASIDE = new RegExp(`^\\.pruning-(${JOB_ID})(?:-[0-9a-f]{16})?$`);

/**
 * A folder whose deletion has started: `.deleting-<job id>-<run nonce>`. It may be half gone,
 * so it is never put back, whatever names it: a failed or interrupted deletion leaves this
 * name and the next cleanup finishes it.
 */
const DELETING = new RegExp(`^\\.deleting-(${JOB_ID})(?:-[0-9a-f]{16})?$`);

/** Newest job folders kept beyond everything that is referenced, unless configured. */
export const KEEP_NEWEST = 3;

export interface HostReleaseRetention {
  /** The configured `sourceUpdates.releaseRoot`; only its direct job folders are pruned. */
  releaseRoot: string;
  /** Paths that must stay, such as the selected and previous releases and every
   * release a coordinator plan or unfinished job names. Paths outside the root are ignored. */
  referenced: readonly string[];
  keepNewest?: number;
  /**
   * When each job started, by job folder name, from the job's own record. A folder's
   * modification time changes whenever an entry inside it is added or removed, so it is only
   * the fallback for jobs the record no longer lists.
   */
  startedAt?: ReadonlyMap<string, number>;
  /** Removal of one release tree; defaults to removeReleaseTree. */
  removeRelease?: (directory: string) => Promise<void>;
  onError?: (directory: string, error: unknown) => void;
  /**
   * Paths in use right now: process working directories, executables and command lines, the
   * running session host's release, and the references above read again. Called once after the
   * candidates are set aside. A set-aside folder it names is put back instead of deleted. When
   * it throws, every folder is put back and the error is rethrown: unknown is never absence.
   */
  inUse?: () => Promise<readonly string[]>;
  /** A candidate that turned out to be in use and was put back. */
  onInUse?: (directory: string) => void;
  /**
   * A set-aside copy found beside a job folder of the same name was removed. The job folder
   * itself is left alone for this cleanup.
   */
  onLeftover?: (directory: string) => void;
  /** A folder an earlier cleanup left set aside was put back under its own name. */
  onRestored?: (directory: string) => void;
}

/**
 * Put back every job folder an earlier cleanup set aside and did not finish, when its own name
 * is free. A coordinator that died between setting folders aside and its in-use check left
 * them hidden, and a release that came into use meanwhile cannot start until it is back. Runs
 * at coordinator start and before anything else in every cleanup. A folder that cannot be put
 * back is reported and left set aside, where nothing can start from it.
 *
 * Takes the release root lock, so it never runs while a cleanup, in this process or another,
 * holds folders set aside: putting one back then would let a second cleanup set it aside under
 * a name the first could consume. Returns null without touching anything when the lock is held.
 */
export async function restoreSetAsideReleases(
  releaseRoot: string,
  callbacks: Pick<HostReleaseRetention, "onError" | "onRestored"> = {},
): Promise<string[] | null> {
  const root = await realpath(releaseRoot);
  try {
    return await withReleaseRootLock(root, () => restoreAbandoned(root, callbacks));
  } catch (error) {
    if (error instanceof ReleaseRootLockedError) return null;
    throw error;
  }
}

/** The restore pass itself; callers hold the release root lock. */
async function restoreAbandoned(
  root: string,
  callbacks: Pick<HostReleaseRetention, "onError" | "onRestored">,
): Promise<string[]> {
  const restored: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = entry.isDirectory() ? SET_ASIDE.exec(entry.name)?.[1] : undefined;
    if (!name) continue;
    const original = path.join(root, name);
    try {
      // Renaming a folder onto an existing empty folder replaces it, so the name must be free.
      if (await exists(original)) continue;
      await rename(path.join(root, entry.name), original);
      restored.push(name);
      callbacks.onRestored?.(original);
    } catch (error) {
      callbacks.onError?.(original, error);
    }
  }
  return restored;
}

/** Another cleanup or restore, in this process or another, holds the release root. */
export class ReleaseRootLockedError extends Error {
  constructor(lockFile: string) {
    super(`Another Host release cleanup holds ${lockFile}`);
    this.name = "ReleaseRootLockedError";
  }
}

const LOCK_FILE = ".cleanup.lock";

/**
 * The start time `ps` reports for a process, or null when no such process exists. With the
 * process ID it identifies one process: a reused ID has a different start time. Any other
 * failure throws, so an unknown holder is treated as alive.
 */
async function processStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await runCommand("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    return stdout.trim() || null;
  } catch (error) {
    const result = error as { code?: unknown; stdout?: string };
    // ps exits 1 with no output when the process does not exist.
    if (result.code === 1 && !result.stdout?.trim()) return null;
    throw error;
  }
}

/**
 * Run `body` holding an exclusive lock file in the release root, shared by every process on
 * the machine: created with O_EXCL and naming its holder by process ID and start time. A lock
 * whose holder is gone, or whose ID now belongs to a different process, is stale and taken
 * over. An unreadable lock, or a holder whose liveness cannot be checked, counts as held.
 * Throws ReleaseRootLockedError when held.
 */
export async function withReleaseRootLock<T>(root: string, body: () => Promise<T>): Promise<T> {
  const file = path.join(root, LOCK_FILE);
  const start = await processStart(process.pid);
  if (!start) throw new Error("The coordinator cannot read its own process start time");
  const token = JSON.stringify({ pid: process.pid, start, nonce: randomBytes(8).toString("hex") });
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(file, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new ReleaseRootLockedError(file);
        throw error;
      }
      if (!(await removeStaleLock(file))) throw new ReleaseRootLockedError(file);
    }
  }
  try {
    return await body();
  } finally {
    // Remove only our own lock; a lock that is not ours was taken over and stays.
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === token) await rm(file, { force: true });
  }
}

/** Remove a lock whose holder is gone; false when it is held or its holder is unknown. */
async function removeStaleLock(file: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    // Released between our create and this read: try again.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  let holder: { pid?: unknown; start?: unknown };
  try {
    holder = JSON.parse(contents) as { pid?: unknown; start?: unknown };
  } catch {
    return false; // Being written right now, or damaged: never assume it is free.
  }
  if (!Number.isSafeInteger(holder.pid) || typeof holder.start !== "string") return false;
  const start = await processStart(holder.pid as number);
  if (start === holder.start) return false;
  // Stale. Move it aside atomically and check it is still the lock we judged before removing
  // it; a lock written meanwhile by a live holder is put back.
  const moved = `${file}.stale-${randomBytes(8).toString("hex")}`;
  try {
    await rename(file, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if ((await readFile(moved, "utf8")) !== contents) {
    await rename(moved, file);
    return false;
  }
  await rm(moved, { force: true });
  return true;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * How many distinct job folders the release links pointed into are remembered across
 * cleanups. A long-lived process started through `current` or `coordinator-current` before
 * the link moved, whose working directory is elsewhere and which maps nothing from the
 * release, is invisible to the process listing; it most likely runs one of the last few
 * link targets. Five covers several installs a day at 6 GiB each.
 */
export const LINK_HISTORY_LENGTH = 5;

/** Five job IDs take under 250 bytes; anything far larger is not a history this wrote. */
const LINK_HISTORY_MAX_BYTES = 64 * 1024;

/**
 * Record the job folders the release links point into now, newest first, ahead of the ones
 * earlier cleanups recorded, and return the most recent LINK_HISTORY_LENGTH of them (more
 * when more links point into distinct folders now). A history that cannot be read or parsed
 * throws, so cleanup is skipped rather than forgetting what it protects.
 */
export async function recordLinkTargets(input: {
  releaseRoot: string;
  links: readonly string[];
  historyFile: string;
}): Promise<string[]> {
  const root = await realpath(input.releaseRoot);
  let previous: string[] = [];
  try {
    if ((await stat(input.historyFile)).size > LINK_HISTORY_MAX_BYTES)
      throw new Error("The release link history is too large");
    const parsed = JSON.parse(await readFile(input.historyFile, "utf8")) as unknown;
    const targets = (parsed as { version?: unknown; targets?: unknown })?.targets;
    if (
      (parsed as { version?: unknown })?.version !== 1 ||
      !Array.isArray(targets) ||
      !targets.every((target) => typeof target === "string" && JOB_FOLDER.test(target))
    )
      throw new Error("The release link history is malformed");
    previous = targets as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const now: string[] = [];
  for (const link of input.links) {
    const entry = await rootEntry(root, link);
    if (entry && JOB_FOLDER.test(entry)) now.push(entry);
  }
  const targets = [...new Set([...now, ...previous])].slice(
    0,
    Math.max(LINK_HISTORY_LENGTH, new Set(now).size),
  );
  const temporary = `${input.historyFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, targets }) + "\n", { mode: 0o600 });
  await rename(temporary, input.historyFile);
  return targets;
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")
  );
}

/**
 * Remove one release tree. Plain deletion first: releases are not sealed today, and
 * the seal-aware path walks the whole tree with chflags before deleting it, about half
 * a minute for a 150k-file release. Only a tree that refuses plain deletion, because
 * immutable flags remain, falls back to the seal-aware removal.
 */
export async function removeReleaseTree(
  directory: string,
  sealAware: (directory: string) => Promise<void> = removeBootstrapRelease,
): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await sealAware(directory);
  }
}

/**
 * Resolve links like realpath, but keep going lexically past the first missing component.
 * A link whose release was just set aside, or a recorded path that no longer exists, still
 * names the job folder it pointed into, so it still protects that folder.
 */
export async function resolveReference(target: string): Promise<string> {
  const pending = path.resolve(target).split(path.sep).filter(Boolean);
  let resolved: string = path.sep;
  let hops = 0;
  while (pending.length) {
    const next = path.join(resolved, pending.shift()!);
    let link: string | null = null;
    try {
      if ((await lstat(next)).isSymbolicLink()) link = await readlink(next);
    } catch (error) {
      // Only absence continues lexically. Any other failure, such as EACCES or EIO, could hide
      // the only link to a release, so it throws and the cleanup deletes nothing.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return path.join(next, ...pending);
      throw error;
    }
    if (link === null) {
      resolved = next;
      continue;
    }
    if (++hops > 40) throw new Error(`Too many links while resolving ${target}`);
    pending.unshift(...path.resolve(resolved, link).split(path.sep).filter(Boolean));
    resolved = path.sep;
  }
  return resolved;
}

/** The entry directly under the root that `target` names, or null when it is elsewhere. */
async function rootEntry(root: string, target: string): Promise<string | null> {
  const resolved = await resolveReference(target);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved.slice(root.length + 1).split(path.sep)[0] || null;
}

async function rootEntries(root: string, targets: readonly string[]): Promise<Set<string>> {
  const entries = new Set<string>();
  for (const target of targets) {
    const entry = await rootEntry(root, target);
    if (entry) entries.add(entry);
  }
  return entries;
}

/** The device and inode of a folder: what a later rename or removal must still find. */
interface Identity {
  dev: number;
  ino: number;
}

async function identityOf(folder: string): Promise<Identity> {
  const info = await lstat(folder);
  if (!info.isDirectory()) throw new Error(`${folder} is not a directory`);
  return { dev: info.dev, ino: info.ino };
}

async function assertIdentity(folder: string, expected: Identity): Promise<void> {
  const actual = await identityOf(folder);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error(`${folder} is no longer the folder this cleanup listed`);
}

/** A folder this cleanup will delete: where it is now, and what it must still be. */
interface Doomed {
  name: string;
  entry: string;
  identity: Identity;
  leftover: boolean;
}

/**
 * Remove old Host release job folders after a verified install. Keeps every referenced
 * folder and the newest few; removes the rest, sealed or not. One failure is reported
 * and skipped. Returns the job folder names removed.
 *
 * Deletion cannot race a starting process. Candidates are first set aside by an atomic
 * rename, which ends every path a new process could start from. `inUse` is then read: a
 * process that started before the rename shows up there. Every folder that is in use is
 * put back at once, before anything is deleted, so it is hidden only for the length of
 * that one check. Only then are the rest renamed once more, to a name that is never put
 * back, and deleted.
 *
 * Cleanups never overlap: the whole run holds the release root lock, which every process
 * shares, and throws ReleaseRootLockedError when another holds it. As a second guard, each
 * set-aside and deletion name carries this run's nonce, and every rename or removal first
 * checks the folder's device and inode against what this run recorded, so one cleanup can
 * never consume a folder another set aside.
 */
export async function pruneHostReleases(input: HostReleaseRetention): Promise<string[]> {
  const root = await realpath(input.releaseRoot);
  return withReleaseRootLock(root, () => pruneLocked(root, input));
}

async function pruneLocked(root: string, input: HostReleaseRetention): Promise<string[]> {
  // Before anything else: a cleanup that died mid-run may have left releases hidden.
  await restoreAbandoned(root, input);
  const referenced = await rootEntries(root, input.referenced);
  const listing = await listJobFolders(root, input.startedAt);
  const newest = new Set(
    listing.folders.slice(0, input.keepNewest ?? KEEP_NEWEST).map((f) => f.name),
  );
  const nonce = randomBytes(8).toString("hex");
  const run: Cleanup = {
    input,
    root,
    referenced,
    present: new Set(listing.folders.map((folder) => folder.name)),
    newest,
    aside: (name) => `.pruning-${name}-${nonce}`,
    deleting: (name) => `.deleting-${name}-${nonce}`,
  };
  // A set-aside copy that could not be put back shadows its job, which waits for a later run.
  const shadowed = new Set(listing.setAside.map((copy) => copy.name));
  const mine = await setAsideCandidates(run, shadowed);

  let live = new Set<string>();
  if (input.inUse && mine.size + listing.setAside.length > 0) {
    try {
      live = await rootEntries(root, await input.inUse());
    } catch (error) {
      // Unknown is never absence: put back this run's folders and any an earlier run left.
      for (const [name, identity] of mine) await putBack(run, name, identity);
      await restoreAbandoned(root, input);
      throw error;
    }
  }
  const doomed = await restoreInUse(run, live, mine, listing.setAside);
  return deleteDoomed(run, listing.deleting, doomed);
}

interface Cleanup {
  input: HostReleaseRetention;
  root: string;
  /** Root entries the caller's references name. */
  referenced: ReadonlySet<string>;
  /** Job folders that exist under their own name. */
  present: ReadonlySet<string>;
  newest: ReadonlySet<string>;
  /** This run's set-aside and deletion entry names for a job folder. */
  aside(name: string): string;
  deleting(name: string): string;
}

/** Put one of this run's folders back under its own name, if it is still the one set aside. */
async function putBack(run: Cleanup, name: string, identity: Identity): Promise<boolean> {
  const original = path.join(run.root, name);
  try {
    await assertIdentity(path.join(run.root, run.aside(name)), identity);
    if (await exists(original)) throw new Error(`${original} exists again`);
    await rename(path.join(run.root, run.aside(name)), original);
    return true;
  } catch (error) {
    run.input.onError?.(original, error);
    return false;
  }
}

/**
 * Set aside every job folder that is neither kept nor shadowed by an earlier set-aside copy.
 * Returns each folder set aside with the identity recorded before the rename.
 */
async function setAsideCandidates(run: Cleanup, shadowed: ReadonlySet<string>) {
  const mine = new Map<string, Identity>();
  for (const name of run.present) {
    if (run.newest.has(name) || run.referenced.has(name) || shadowed.has(name)) continue;
    const original = path.join(run.root, name);
    try {
      const identity = await identityOf(original);
      await rename(original, path.join(run.root, run.aside(name)));
      mine.set(name, identity);
    } catch (error) {
      run.input.onError?.(original, error);
    }
  }
  return mine;
}

/**
 * Put back everything in use before anything is deleted: deleting the others can take
 * minutes, and a cleanup that dies during it must not leave a used release hidden. Returns
 * what is left to delete.
 */
async function restoreInUse(
  run: Cleanup,
  live: ReadonlySet<string>,
  mine: ReadonlyMap<string, Identity>,
  earlier: readonly SetAsideEntry[],
): Promise<Doomed[]> {
  const doomed: Doomed[] = [];
  for (const [name, identity] of mine) {
    const used = live.has(name) || live.has(run.aside(name)) || run.referenced.has(name);
    if (!used) doomed.push({ name, entry: run.aside(name), identity, leftover: false });
    else if (await putBack(run, name, identity))
      run.input.onInUse?.(path.join(run.root, name));
  }
  // Earlier set-aside copies still here could not be put back: their job folder exists.
  for (const copy of earlier) {
    if (!run.present.has(copy.name)) continue; // Its restore failed; leave it for later.
    if (live.has(copy.entry) || run.referenced.has(copy.entry))
      run.input.onError?.(
        path.join(run.root, copy.entry),
        new Error("A set-aside copy beside its job folder is in use"),
      );
    else doomed.push({ ...copy, leftover: true });
  }
  return doomed;
}

async function deleteDoomed(
  run: Cleanup,
  deleting: readonly SetAsideEntry[],
  doomed: readonly Doomed[],
): Promise<string[]> {
  const removeRelease = run.input.removeRelease ?? removeReleaseTree;
  const removed = new Set<string>();
  // Deletions an earlier cleanup started are finished first; they are never checked or put back.
  for (const started of deleting) {
    try {
      await removeJobFolder(path.join(run.root, started.entry), started.identity, removeRelease);
      if (!run.present.has(started.name)) removed.add(started.name);
    } catch (error) {
      run.input.onError?.(path.join(run.root, started.name), error);
    }
  }
  for (const folder of doomed) {
    const from = path.join(run.root, folder.entry);
    const to = path.join(run.root, run.deleting(folder.name));
    try {
      // From here the tree may be half gone, so it leaves the name that can be put back.
      await assertIdentity(from, folder.identity);
      await rename(from, to);
      await removeJobFolder(to, folder.identity, removeRelease);
      if (folder.leftover) run.input.onLeftover?.(from);
      else removed.add(folder.name);
    } catch (error) {
      run.input.onError?.(path.join(run.root, folder.name), error);
    }
  }
  return [...removed];
}

/** A set-aside or deletion folder found by the listing. */
interface SetAsideEntry {
  name: string;
  entry: string;
  identity: Identity;
}

/**
 * Job folders newest first, folders an earlier cleanup set aside and did not finish, and
 * folders whose deletion it started, each with the identity seen now.
 */
async function listJobFolders(root: string, startedAt?: ReadonlyMap<string, number>) {
  const folders: Array<{ name: string; time: number }> = [];
  const setAside: SetAsideEntry[] = [];
  const deleting: SetAsideEntry[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    const leftover = SET_ASIDE.exec(entry.name)?.[1];
    if (leftover)
      setAside.push({ name: leftover, entry: entry.name, identity: await identityOf(full) });
    const started = DELETING.exec(entry.name)?.[1];
    if (started)
      deleting.push({ name: started, entry: entry.name, identity: await identityOf(full) });
    // Only job folders are candidates; anything else sharing the root is never touched.
    if (!JOB_FOLDER.test(entry.name)) continue;
    const recorded = startedAt?.get(entry.name);
    const time = Number.isFinite(recorded) ? recorded! : (await stat(full)).mtimeMs;
    folders.push({ name: entry.name, time });
  }
  folders.sort((a, b) => b.time - a.time);
  return { folders, setAside, deleting };
}

/**
 * Removal follows the path again after the listing, so a folder swapped for a link meanwhile
 * would hand its target's contents to removal. Require a real directory whose canonical path
 * is still exactly this one, with the identity this cleanup recorded; the release root is
 * canonical, so a link anywhere fails.
 */
async function assertConfined(folder: string, identity: Identity): Promise<void> {
  await assertIdentity(folder, identity);
  if ((await realpath(folder)) !== folder)
    throw new Error(`${folder} no longer resolves to itself`);
}

async function removeJobFolder(
  folder: string,
  identity: Identity,
  removeRelease: (directory: string) => Promise<void>,
): Promise<void> {
  await assertConfined(folder, identity);
  // Release trees may carry immutable flags; removeReleaseTree falls back for those.
  for (const child of await readdir(folder, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const target = path.join(folder, child.name);
    await assertConfined(folder, identity);
    if (!(await lstat(target)).isDirectory()) continue;
    await removeRelease(target);
  }
  await assertConfined(folder, identity);
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

let running: Promise<void> | null = null;

function writeRetentionReceipt(file: string, receipt: Record<string, unknown>): void {
  try {
    writeFileSync(file, JSON.stringify({ version: 1, ...receipt }) + "\n", { mode: 0o600 });
  } catch {
    // The receipt is diagnostic only; a missing one never affects an install.
  }
}

/**
 * Start one release cleanup after an install has already reported its result, so its
 * duration never counts against the install's readiness deadline. A cleanup that is
 * still running makes this a no-op. The outcome is written to `receiptFile`.
 * Returns whether a cleanup started.
 */
export function startHostReleaseRetention(
  prune: () => Promise<string>,
  receiptFile: string,
  now: () => Date = () => new Date(),
): boolean {
  if (running) {
    writeRetentionReceipt(receiptFile, {
      status: "skipped",
      reason: "An earlier cleanup is still running",
      at: now().toISOString(),
    });
    return false;
  }
  const startedAt = now().toISOString();
  writeRetentionReceipt(receiptFile, { status: "running", startedAt });
  running = (async () => {
    try {
      const note = (await prune()).trim();
      writeRetentionReceipt(receiptFile, {
        status: "finished",
        startedAt,
        finishedAt: now().toISOString(),
        note,
      });
    } catch (error) {
      writeRetentionReceipt(receiptFile, {
        status: "failed",
        startedAt,
        finishedAt: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })().finally(() => {
    running = null;
  });
  return true;
}

/** Resolves when no cleanup is running. */
export async function hostReleaseRetentionIdle(): Promise<void> {
  await running;
}
