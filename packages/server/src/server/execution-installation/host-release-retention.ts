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
import { removeBootstrapRelease } from "./coordinator-bootstrap-release-seal.js";

/** Host source update jobs build into a folder named by their lifecycle job ID. */
const JOB_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A job folder set aside for removal, still whole. The rename is atomic, so from that moment
 * nothing can start from the release's path; whatever started earlier is found by the in-use
 * check that follows, and the folder is put back under its own name.
 */
const SET_ASIDE = /^\.pruning-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const setAsideName = (name: string) => `.pruning-${name}`;

/**
 * A folder whose deletion has started. It may be half gone, so it is never put back, whatever
 * names it: a failed or interrupted deletion leaves this name and the next cleanup finishes it.
 */
const DELETING = /^\.deleting-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const deletingName = (name: string) => `.deleting-${name}`;

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
 */
export async function restoreSetAsideReleases(
  releaseRoot: string,
  callbacks: Pick<HostReleaseRetention, "onError" | "onRestored"> = {},
): Promise<string[]> {
  const root = await realpath(releaseRoot);
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

/** Whether something names a job folder, under its own name or its set-aside name. */
const names = (entries: ReadonlySet<string>, name: string) =>
  entries.has(name) || entries.has(setAsideName(name));

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
 */
export async function pruneHostReleases(input: HostReleaseRetention): Promise<string[]> {
  const root = await realpath(input.releaseRoot);
  // Before anything else: a cleanup that died mid-run may have left releases hidden.
  await restoreSetAsideReleases(root, input);
  const referenced = await rootEntries(root, input.referenced);
  const { folders, leftovers, deleting } = await listJobFolders(root, input.startedAt);
  const newest = new Set(folders.slice(0, input.keepNewest ?? KEEP_NEWEST).map((f) => f.name));
  const present = new Set(folders.map((folder) => folder.name));
  const run: Cleanup = {
    input,
    root,
    referenced,
    present,
    kept: (name) => newest.has(name) || names(referenced, name),
    original: (name) => path.join(root, name),
    aside: (name) => path.join(root, setAsideName(name)),
  };
  const setAside = await setAsideCandidates(run, leftovers);
  // A set-aside copy beside a job folder of the same name cannot be put back. The job
  // folder is whole and stays out of this cleanup; the copy goes once nothing uses it.
  const collided = [...leftovers].filter((name) => present.has(name));
  const restorable = [...setAside, ...[...leftovers].filter((name) => !present.has(name))];

  let live = new Set<string>();
  if (input.inUse && restorable.length + collided.length > 0) {
    try {
      live = await rootEntries(root, await input.inUse());
    } catch (error) {
      // Unknown is never absence: put back this run's folders and any an earlier run left.
      await restoreSetAsideReleases(root, input);
      throw error;
    }
  }
  const doomed = await restoreInUse(run, live, restorable, collided);
  return deleteDoomed(run, deleting, doomed);
}

interface Cleanup {
  input: HostReleaseRetention;
  root: string;
  /** Root entries the caller's references name. */
  referenced: ReadonlySet<string>;
  /** Job folders that exist under their own name. */
  present: ReadonlySet<string>;
  kept(name: string): boolean;
  original(name: string): string;
  aside(name: string): string;
}

async function restore(run: Cleanup, name: string): Promise<boolean> {
  try {
    await rename(run.aside(name), run.original(name));
    return true;
  } catch (error) {
    run.input.onError?.(run.original(name), error);
    return false;
  }
}

/** Set aside every job folder that is neither kept nor shadowed by an earlier set-aside copy. */
async function setAsideCandidates(run: Cleanup, leftovers: ReadonlySet<string>) {
  const setAside: string[] = [];
  for (const name of run.present) {
    if (run.kept(name) || leftovers.has(name)) continue;
    try {
      await rename(run.original(name), run.aside(name));
      setAside.push(name);
    } catch (error) {
      run.input.onError?.(run.original(name), error);
    }
  }
  return setAside;
}

/**
 * Put back everything in use before anything is deleted: deleting the others can take
 * minutes, and a cleanup that dies during it must not leave a used release hidden. Returns
 * what is left to delete.
 */
async function restoreInUse(
  run: Cleanup,
  live: ReadonlySet<string>,
  restorable: readonly string[],
  collided: readonly string[],
) {
  const doomed: Array<{ name: string; leftover: boolean }> = [];
  for (const name of restorable) {
    if (!names(live, name) && !run.kept(name)) doomed.push({ name, leftover: false });
    else if (await restore(run, name)) run.input.onInUse?.(run.original(name));
  }
  for (const name of collided) {
    const copy = setAsideName(name);
    if (live.has(copy) || run.referenced.has(copy))
      run.input.onError?.(
        run.aside(name),
        new Error("A set-aside copy beside its job folder is in use"),
      );
    else doomed.push({ name, leftover: true });
  }
  return doomed;
}

async function deleteDoomed(
  run: Cleanup,
  deleting: ReadonlySet<string>,
  doomed: ReadonlyArray<{ name: string; leftover: boolean }>,
): Promise<string[]> {
  const removeRelease = run.input.removeRelease ?? removeReleaseTree;
  const started = (name: string) => path.join(run.root, deletingName(name));
  const removed = new Set<string>();
  // Deletions an earlier cleanup started are finished first; they are never checked or put back.
  for (const name of deleting) {
    try {
      await removeJobFolder(started(name), removeRelease);
      if (!run.present.has(name)) removed.add(name);
    } catch (error) {
      run.input.onError?.(run.original(name), error);
    }
  }
  for (const { name, leftover } of doomed) {
    try {
      // From here the tree may be half gone, so it leaves the name that can be put back.
      await rename(run.aside(name), started(name));
      await removeJobFolder(started(name), removeRelease);
      if (leftover) run.input.onLeftover?.(run.aside(name));
      else removed.add(name);
    } catch (error) {
      run.input.onError?.(run.original(name), error);
    }
  }
  return [...removed];
}

/**
 * Job folders newest first, the job IDs an earlier cleanup set aside and did not finish, and
 * the job IDs whose deletion it started.
 */
async function listJobFolders(root: string, startedAt?: ReadonlyMap<string, number>) {
  const folders: Array<{ name: string; time: number }> = [];
  const leftovers = new Set<string>();
  const deleting = new Set<string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const leftover = SET_ASIDE.exec(entry.name)?.[1];
    if (leftover) leftovers.add(leftover);
    const started = DELETING.exec(entry.name)?.[1];
    if (started) deleting.add(started);
    // Only job folders are candidates; anything else sharing the root is never touched.
    if (!JOB_FOLDER.test(entry.name)) continue;
    const recorded = startedAt?.get(entry.name);
    const time = Number.isFinite(recorded)
      ? recorded!
      : (await stat(path.join(root, entry.name))).mtimeMs;
    folders.push({ name: entry.name, time });
  }
  folders.sort((a, b) => b.time - a.time);
  return { folders, leftovers, deleting };
}

/**
 * Removal follows the path again after the listing, so a folder swapped for a link meanwhile
 * would hand its target's contents to removal. Require a real directory whose canonical path
 * is still exactly this one; the release root is canonical, so a link anywhere fails.
 */
async function assertConfined(folder: string): Promise<void> {
  const info = await lstat(folder);
  if (!info.isDirectory()) throw new Error(`${folder} is no longer a directory`);
  if ((await realpath(folder)) !== folder)
    throw new Error(`${folder} no longer resolves to itself`);
}

async function removeJobFolder(
  folder: string,
  removeRelease: (directory: string) => Promise<void>,
): Promise<void> {
  await assertConfined(folder);
  // Release trees may carry immutable flags; removeReleaseTree falls back for those.
  for (const child of await readdir(folder, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const target = path.join(folder, child.name);
    await assertConfined(folder);
    if (!(await lstat(target)).isDirectory()) continue;
    await removeRelease(target);
  }
  await assertConfined(folder);
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
