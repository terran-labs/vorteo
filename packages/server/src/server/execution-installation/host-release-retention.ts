import { writeFileSync } from "node:fs";
import { lstat, readdir, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { removeBootstrapRelease } from "./coordinator-bootstrap-release-seal.js";

/** Host source update jobs build into a folder named by their lifecycle job ID. */
const JOB_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A job folder set aside for removal. The rename is atomic, so from that moment nothing can
 * start from the release's path; whatever started earlier is found by the in-use check that
 * follows, and the folder is put back. A set-aside folder that could not be deleted keeps
 * this name, cannot be started from, and is retried by the next cleanup.
 */
const SET_ASIDE = /^\.pruning-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const setAsideName = (name: string) => `.pruning-${name}`;

/** Newest job folders kept beyond everything that is referenced. */
const KEEP_NEWEST = 3;

export interface HostReleaseRetention {
  /** The configured `sourceUpdates.releaseRoot`; only its direct job folders are pruned. */
  releaseRoot: string;
  /** Paths that must stay, such as the selected and previous releases and every
   * release a coordinator plan or unfinished job names. Paths outside the root are ignored. */
  referenced: readonly string[];
  keepNewest?: number;
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
    } catch {
      return path.join(next, ...pending);
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

/**
 * The job folder under the root that `target` names, or null when it is elsewhere. A path
 * inside a set-aside folder names the job folder it was set aside from.
 */
async function jobFolder(root: string, target: string): Promise<string | null> {
  const resolved = await resolveReference(target);
  if (!resolved.startsWith(root + path.sep)) return null;
  const name = resolved.slice(root.length + 1).split(path.sep)[0];
  if (!name) return null;
  return SET_ASIDE.exec(name)?.[1] ?? name;
}

async function jobFolders(root: string, targets: readonly string[]): Promise<Set<string>> {
  const folders = new Set<string>();
  for (const target of targets) {
    const folder = await jobFolder(root, target);
    if (folder) folders.add(folder);
  }
  return folders;
}

/**
 * Remove old Host release job folders after a verified install. Keeps every referenced
 * folder and the newest few; removes the rest, sealed or not. One failure is reported
 * and skipped. Returns the job folder names removed.
 *
 * Deletion cannot race a starting process. Candidates are first set aside by an atomic
 * rename, which ends every path a new process could start from. `inUse` is then read: a
 * process that started before the rename shows up there and its folder is put back. Only
 * folders that stayed unused through both steps are deleted.
 */
export async function pruneHostReleases(input: HostReleaseRetention): Promise<string[]> {
  const root = await realpath(input.releaseRoot);
  const keep = await jobFolders(root, input.referenced);
  const { folders, leftovers } = await listJobFolders(root);
  for (const { name } of folders.slice(0, input.keepNewest ?? KEEP_NEWEST)) keep.add(name);

  const original = (name: string) => path.join(root, name);
  const aside = (name: string) => path.join(root, setAsideName(name));
  const restore = async (name: string): Promise<boolean> => {
    try {
      await rename(aside(name), original(name));
      return true;
    } catch (error) {
      input.onError?.(original(name), error);
      return false;
    }
  };

  const setAside: string[] = [];
  for (const { name } of folders) {
    if (keep.has(name)) continue;
    if (leftovers.has(name)) {
      // Both names exist; which one a process uses is unknown, so neither is touched.
      leftovers.delete(name);
      input.onError?.(original(name), new Error("An earlier set-aside copy of it exists"));
      continue;
    }
    try {
      await rename(original(name), aside(name));
      setAside.push(name);
    } catch (error) {
      input.onError?.(original(name), error);
    }
  }
  const pending = [...setAside, ...leftovers];
  if (pending.length === 0) return [];

  const live = await liveJobFolders(root, input.inUse).catch(async (error) => {
    for (const name of setAside) await restore(name);
    throw error;
  });
  const removed: string[] = [];
  for (const name of pending) {
    if (live.has(name) || keep.has(name)) {
      if (await restore(name)) input.onInUse?.(original(name));
      continue;
    }
    try {
      await removeJobFolder(aside(name), input.removeRelease ?? removeReleaseTree);
      removed.push(name);
    } catch (error) {
      // Possibly half deleted: it stays set aside, where nothing can start from it.
      input.onError?.(original(name), error);
    }
  }
  return removed;
}

async function liveJobFolders(
  root: string,
  inUse: HostReleaseRetention["inUse"],
): Promise<Set<string>> {
  return inUse ? jobFolders(root, await inUse()) : new Set();
}

/** Job folders newest first, and the job IDs an earlier cleanup set aside and could not finish. */
async function listJobFolders(root: string) {
  const folders: Array<{ name: string; mtimeMs: number }> = [];
  const leftovers = new Set<string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const leftover = SET_ASIDE.exec(entry.name)?.[1];
    if (leftover) leftovers.add(leftover);
    // Only job folders are candidates; anything else sharing the root is never touched.
    if (!JOB_FOLDER.test(entry.name)) continue;
    folders.push({ name: entry.name, mtimeMs: (await stat(path.join(root, entry.name))).mtimeMs });
  }
  folders.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { folders, leftovers };
}

async function removeJobFolder(
  folder: string,
  removeRelease: (directory: string) => Promise<void>,
): Promise<void> {
  // Release trees may carry immutable flags; removeReleaseTree falls back for those.
  for (const child of await readdir(folder, { withFileTypes: true }))
    if (child.isDirectory()) await removeRelease(path.join(folder, child.name));
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
