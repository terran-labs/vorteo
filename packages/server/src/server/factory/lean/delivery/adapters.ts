/**
 * Step adapters for the delivery executor: the native Host and the Dev container.
 *
 * Both start the command in its own session and process group, with output written to a
 * daemon-private file rather than a pipe, so a deploy keeps running if the daemon dies; the
 * executor then marks the step unknown and the owner settles it with a verify-only retry.
 * Factory never signals a step: the process id is recorded for diagnosis only, and a step that
 * outlives its timeout is reported as unknown while it keeps running.
 */

import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ArtifactEvidence,
  ArtifactEvidenceRequest,
  CheckoutLink,
  DeliveryCheckoutPort,
  PrepareRequest,
  DeliveryStepAdapter,
  DeliveryStepRequest,
  RecordsCommitRequest,
  RecordsCommitResult,
  StepNotStarted,
  StepOutput,
} from "./executor.js";

const exec = promisify(execFile);
export const OUTPUT_TAIL_BYTES = 16 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export interface SpawnRequest {
  file: string;
  args: string[];
  cwd: string;
  /** The complete environment; nothing is inherited from the daemon. */
  env: Record<string, string>;
  outputPath: string;
}

export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

export interface SpawnedProcess {
  pid: number;
  exited: Promise<ProcessExit>;
}

/** Starts one process. There is deliberately no way to signal it. */
export interface Spawner {
  spawn(request: SpawnRequest): Promise<SpawnedProcess>;
}

export interface OutputFiles {
  /** Keeps only the last `bytes` of the file in place and returns them. */
  tail(file: string, bytes: number): Promise<string>;
}

export interface CheckoutAt {
  cwd: string;
  head: string;
}

/** Where a step runs for one commit. Never moves or cleans the checkout. */
export interface CheckoutPort {
  at(input: CheckoutRequest): Promise<CheckoutAt | StepNotStarted>;
}

export interface CheckoutRequest {
  commit: string;
  /** Tracked paths the release tools write; uncommitted changes anywhere else refuse. */
  records: readonly string[];
}

export interface GitRunner {
  /** `env` adds to the runner's own minimal environment, such as a temporary index file. */
  run(cwd: string, args: string[], env?: Record<string, string>): Promise<string>;
}

/** Detached process with stdout and stderr in a private file; survives the daemon. */
export function createProcessSpawner(): Spawner {
  return {
    async spawn(request) {
      await mkdir(path.dirname(request.outputPath), { recursive: true, mode: 0o700 });
      const output = await open(request.outputPath, "w", 0o600);
      try {
        const child = spawn(request.file, request.args, {
          cwd: request.cwd,
          env: request.env,
          stdio: ["ignore", output.fd, output.fd],
          detached: true,
        });
        const exited = new Promise<ProcessExit>((resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        await once(child, "spawn");
        if (child.pid === undefined) throw new Error("The delivery step did not start.");
        return { pid: child.pid, exited };
      } finally {
        await output.close();
      }
    },
  };
}

export function createOutputFiles(): OutputFiles {
  return {
    async tail(file, bytes) {
      const tail = (await readFile(file)).subarray(-bytes);
      await writeFile(file, tail, { mode: 0o600 });
      return tail.toString("utf8");
    },
  };
}

const GIT_ENV = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

/** `baseEnv` adds what fetch and push need, such as HOME and SSH_AUTH_SOCK; never the daemon's. */
export function createGitRunner(
  gitBinary: string,
  baseEnv: Record<string, string> = {},
): GitRunner {
  return {
    async run(cwd, args, env = {}) {
      const options = { env: { ...GIT_ENV, ...baseEnv, ...env }, timeout: GIT_TIMEOUT_MS };
      const { stdout } = await exec(gitBinary, ["-C", cwd, ...args], options);
      return stdout.trim();
    },
  };
}

/** Git inside the Dev container, for its own checkout, which has Linux dependencies installed. */
export function createContainerGitRunner(input: {
  dockerBinary: string;
  container: string;
  clientEnv: Record<string, string>;
}): GitRunner {
  return {
    async run(cwd, args) {
      const argv = ["exec", "--workdir", cwd, input.container, "git", ...args];
      const options = { env: input.clientEnv, timeout: GIT_TIMEOUT_MS };
      const { stdout } = await exec(input.dockerBinary, argv, options);
      return stdout.trim();
    },
  };
}

/**
 * Tracked paths that differ from HEAD, staged or not. NUL-separated names, because the runner
 * trims its output and porcelain status lines are column-positioned.
 */
async function changedPaths(git: GitRunner, cwd: string): Promise<string[]> {
  const names = await git.run(cwd, ["diff", "--name-only", "-z", "HEAD"]);
  return names.split("\0").filter((name) => name !== "");
}

/**
 * An existing checkout used only when it already sits at the accepted commit with a clean
 * tracked tree. Mira's tools must run from its integration checkout, beside ../Syn3h-stable, so
 * Factory verifies that checkout instead of creating its own. `cwd` is where the step runs; for
 * the Dev container it is the same checkout's path inside the container.
 */
export function createVerifiedCheckout(input: {
  /** Where `git` inspects the checkout. */
  gitPath: string;
  /** Where the step runs; the same checkout, seen from the adapter's side. */
  cwd: string;
  git: GitRunner;
}): CheckoutPort {
  const { git, gitPath } = input;
  return {
    async at({ commit, records }) {
      const head = await git.run(gitPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (head !== commit) {
        return {
          notStarted: `The release checkout is at ${head}, not ${commit}; nothing was started.`,
        };
      }
      const changed = await changedPaths(git, gitPath);
      if (changed.some((file) => !records.includes(file))) {
        return { notStarted: "The release checkout has uncommitted changes; nothing was started." };
      }
      return { cwd: input.cwd, head };
    },
  };
}

interface ProcessStepOptions {
  spawner: Spawner;
  files: OutputFiles;
  checkout: CheckoutPort;
  /** Built per request: the program, its arguments and its complete environment. */
  command(
    request: DeliveryStepRequest,
    cwd: string,
  ): Pick<SpawnRequest, "file" | "args" | "env" | "cwd">;
  tailBytes?: number;
}

function timeout(ms: number): { done: Promise<"timeout">; clear(): void } {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { done, clear: () => clearTimeout(timer) };
}

function createProcessStepAdapter(options: ProcessStepOptions): DeliveryStepAdapter {
  const tailBytes = options.tailBytes ?? OUTPUT_TAIL_BYTES;
  return {
    async run(request): Promise<StepOutput | StepNotStarted | null> {
      const checkout = await options.checkout.at({
        commit: request.commit,
        records: request.records,
      });
      if ("notStarted" in checkout) return checkout;
      if (!(await request.authorizeLaunch())) return null;
      const started = await options.spawner.spawn({
        ...options.command(request, checkout.cwd),
        outputPath: request.outputPath,
      });
      await request.onSpawned(started.pid);
      const limit = timeout(request.timeoutMs);
      const exit = await Promise.race([started.exited, limit.done]);
      limit.clear();
      // Past its time or ended by a signal: the outcome is unknown, and it is never signalled.
      if (exit === "timeout" || exit.code === null) return null;
      const stdout = await options.files.tail(request.outputPath, tailBytes);
      return { exitCode: exit.code, stdout };
    },
  };
}

/** The native Host: `/bin/sh -c` in the verified checkout, with an allowlisted environment. */
export function createHostStepAdapter(input: {
  spawner: Spawner;
  files: OutputFiles;
  checkout: CheckoutPort;
  /** Explicit values such as PATH, HOME and LANG; the daemon's own environment is never passed. */
  baseEnv: Record<string, string>;
  /**
   * Prefix for heavy steps, resolved inside the checkout when relative (Mira: `tools/heavy.sh`),
   * so it is always the accepted commit's reviewed copy. Null runs them directly.
   */
  heavyWrapper: string | null;
}): DeliveryStepAdapter {
  return createProcessStepAdapter({
    spawner: input.spawner,
    files: input.files,
    checkout: input.checkout,
    command(request, cwd) {
      const env = { ...input.baseEnv, ...request.env };
      const shell = ["-c", request.command];
      const wrapper = request.heavy ? input.heavyWrapper : null;
      if (wrapper === null) return { file: "/bin/sh", args: shell, cwd, env };
      const file = path.isAbsolute(wrapper) ? wrapper : path.join(cwd, wrapper);
      return { file, args: ["/bin/sh", ...shell], cwd, env };
    },
  });
}

/**
 * The Dev container through `docker exec`. Release values are named with `--env NAME`, so the
 * Docker client copies them from its own environment and they never appear in an argument list.
 */
export function createContainerStepAdapter(input: {
  spawner: Spawner;
  files: OutputFiles;
  checkout: CheckoutPort;
  dockerBinary: string;
  container: string;
  /** The Docker client's own environment, such as PATH, HOME and DOCKER_HOST. */
  clientEnv: Record<string, string>;
}): DeliveryStepAdapter {
  return createProcessStepAdapter({
    spawner: input.spawner,
    files: input.files,
    checkout: input.checkout,
    command(request, cwd) {
      const names = Object.keys(request.env).flatMap((name) => ["--env", name]);
      return {
        file: input.dockerBinary,
        args: [
          "exec",
          "--workdir",
          cwd,
          ...names,
          input.container,
          "/bin/sh",
          "-c",
          request.command,
        ],
        cwd: "/",
        env: { ...input.clientEnv, ...request.env },
      };
    },
  });
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One entry of an artifact tree. Serialized as JSON, so no path or target can be ambiguous. */
type TreeEntry =
  | ["dir", string]
  | ["file", string, "x" | "-", string]
  | ["symlink", string, string];

class ArtifactCustodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCustodyError";
  }
}

function sameObject(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Reads a file only if the opened handle is the inode the listing saw, never through a link. */
async function readListedFile(full: string, listed: { dev: number; ino: number }): Promise<Buffer> {
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (handle === null)
    throw new ArtifactCustodyError(`${full} could not be opened without following a link.`);
  try {
    if (!sameObject(await handle.stat(), listed)) {
      throw new ArtifactCustodyError(`${full} was replaced while it was being read.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Every entry under `root`, empty directories included, in path order. Symlinks are recorded by
 * their literal target and never followed; FIFOs, sockets and devices are refused. Each directory
 * is checked again after the walk, so a directory replaced during it refuses the evidence.
 */
async function treeEntries(root: string, exclude: readonly string[]): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const directories: { full: string; seen: { dev: number; ino: number } }[] = [];
  async function walk(relative: string): Promise<void> {
    const full = path.join(root, relative);
    directories.push({ full, seen: await lstat(full) });
    const names = (await readdir(full)).sort();
    for (const name of names) {
      if (relative === "" && exclude.includes(name)) continue;
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const child = path.join(root, childRelative);
      const stats = await lstat(child);
      if (stats.isSymbolicLink()) entries.push(["symlink", childRelative, await readlink(child)]);
      else if (stats.isDirectory()) {
        entries.push(["dir", childRelative]);
        await walk(childRelative);
      } else if (stats.isFile()) {
        const mode = stats.mode & 0o111 ? "x" : "-";
        entries.push(["file", childRelative, mode, sha256(await readListedFile(child, stats))]);
      } else {
        throw new ArtifactCustodyError(`${childRelative} is not a file, directory or symlink.`);
      }
    }
  }
  await walk("");
  for (const directory of directories) {
    const now = await lstat(directory.full).catch(() => null);
    if (!now?.isDirectory() || !sameObject(now, directory.seen)) {
      throw new ArtifactCustodyError(`${directory.full} was replaced while it was being read.`);
    }
  }
  return entries;
}

/**
 * Reads a frozen artifact as a pure read: executes nothing, writes nothing, follows no symlink.
 * Dependencies are not frozen bytes. Their evidence counts only when the artifact's dependency
 * link resolves to `trustedDependencies`, the Factory's own delivery checkout; the installed
 * lockfile there is hashed so a reinstall is detected, not prevented. A path replaced during the
 * read refuses the evidence rather than hashing whatever was swapped in.
 */
export async function readArtifactEvidence(
  links: readonly CheckoutLink[],
  request: ArtifactEvidenceRequest,
  trustedDependencies: string | null,
): Promise<ArtifactEvidence | StepNotStarted> {
  const holder = links.find((link) => link.name === request.link);
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(request.artifact);
  if (!holder || !valid) {
    return { notStarted: `Factory cannot locate the artifact ${request.artifact}.` };
  }
  const root = path.join(holder.target, request.artifact);
  try {
    const anchored = (await realpath(holder.target)) === holder.target;
    const top = await lstat(root).catch(() => null);
    if (!anchored || !top?.isDirectory()) {
      return { notStarted: `There is no frozen artifact ${request.artifact} at its exact place.` };
    }
    const entries = await treeEntries(root, request.exclude);
    const after = await lstat(root);
    if (!sameObject(after, top) || (await realpath(holder.target)) !== holder.target) {
      return { notStarted: `${request.artifact} was replaced while it was being read.` };
    }
    const digest = sha256(JSON.stringify(entries));
    if (request.dependencies === null) return { digest, dependencies: null };
    return await dependencyEvidence(root, request, trustedDependencies, digest);
  } catch (error) {
    if (error instanceof ArtifactCustodyError) return { notStarted: error.message };
    throw error;
  }
}

async function dependencyEvidence(
  root: string,
  request: ArtifactEvidenceRequest,
  trustedDependencies: string | null,
  digest: string,
): Promise<ArtifactEvidence | StepNotStarted> {
  const dependencies = request.dependencies;
  if (dependencies === null) return { digest, dependencies: null };
  const linkPath = path.join(root, dependencies.link);
  const dependencyLink = await lstat(linkPath).catch(() => null);
  if (!dependencyLink?.isSymbolicLink()) {
    return { notStarted: `${request.artifact} has no ${dependencies.link} link to check.` };
  }
  const target = path.resolve(root, await readlink(linkPath));
  if (trustedDependencies === null || target !== trustedDependencies) {
    return {
      notStarted: `${request.artifact} links its dependencies to ${target}, outside the Factory's delivery checkout.`,
    };
  }
  const place = await lstat(target).catch(() => null);
  if (!place?.isDirectory() || (await realpath(target)) !== target) {
    return {
      notStarted: `The dependencies at ${target} are not a plain directory at their own path.`,
    };
  }
  const lockfilePath = path.join(target, dependencies.lockfile);
  const listed = await lstat(lockfilePath).catch(() => null);
  if (!listed?.isFile()) {
    return {
      notStarted: `The dependencies ${request.artifact} links to have no ${dependencies.lockfile}.`,
    };
  }
  const lockfile = sha256(await readListedFile(lockfilePath, listed));
  return { digest, dependencies: { target, lockfile } };
}

/** Whether a path exists at all, without following a final symlink. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function gitOrNull(git: GitRunner, cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git.run(cwd, args);
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") return null;
    throw error;
  }
}

/** True when `appended` is whole, non-empty, non-comment rows added to the end of `base`. */
function appendsRows(base: string, working: string): boolean {
  if (!working.startsWith(base) || (base !== "" && !base.endsWith("\n"))) return false;
  const appended = working.slice(base.length);
  if (appended === "" || !appended.endsWith("\n")) return false;
  const rows = appended.slice(0, -1).split("\n");
  return rows.every((row) => row.trim() !== "" && !row.startsWith("#"));
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** A refusal sentence when the links are not a safe, exact set for this checkout. */
export function linkRefusal(links: readonly CheckoutLink[], checkoutName: string): string | null {
  const names = new Set<string>();
  for (const link of links) {
    if (!SEGMENT.test(link.name) || link.name === checkoutName || names.has(link.name)) {
      return `The delivery checkout link ${link.name} is not a single unique name beside the checkout.`;
    }
    names.add(link.name);
    const segments = link.target.split("/").slice(1);
    const dotted = segments.some(
      (segment) => segment === "." || segment === ".." || segment === "",
    );
    if (!path.isAbsolute(link.target) || dotted) {
      return `The delivery checkout link ${link.name} must name an exact absolute directory.`;
    }
  }
  return null;
}

/**
 * The daemon-owned delivery checkout: a worktree of a private bare object pool that only the
 * daemon writes, fetched from and pushed to the project's trusted origin. No Git command ever
 * runs in the owner's or a Dev-writable checkout. Pool and worktree are created on first use and
 * never deleted; an existing path that is not exactly this pool or its worktree is refused.
 * Links beside the worktree (Mira: Syn3h-stable) are created once and must keep pointing at their
 * exact configured target; the target is never copied, moved or followed through a chain.
 */
export function createDeliveryCheckout(input: {
  /** The private bare pool, such as `<home>/factory/lean/delivery-checkouts/<project>/repo.git`. */
  pool: string;
  /** The worktree, beside the pool's folder: `<same folder>/<release.checkout.name>`. */
  path: string;
  links: readonly CheckoutLink[];
  /** The project's authenticated origin; the only remote the pool ever talks to. */
  remoteUrl: string;
  /** Fetch and push need credentials: give this runner HOME and SSH_AUTH_SOCK, nothing more. */
  git: GitRunner;
  defaultBranch: string;
  /** Author and committer of Factory's records commits. */
  identity: { name: string; email: string };
  exists?: (target: string) => Promise<boolean>;
  readWorking?: (file: string) => Promise<string>;
}): DeliveryCheckoutPort {
  const { git, pool, remoteUrl, defaultBranch } = input;
  const remote = "origin";
  const dir = input.path;
  const exists = input.exists ?? pathExists;
  const readWorking =
    input.readWorking ?? ((file: string) => readFile(path.join(dir, file), "utf8"));
  const commonDir = ["rev-parse", "--path-format=absolute", "--git-common-dir"];

  /** Built in a staging directory and renamed into place, so a crash never leaves half a pool. */
  async function ensurePool(): Promise<StepNotStarted | null> {
    if (!(await exists(pool))) {
      const parent = path.dirname(pool);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const staging = `${pool}.staging-${randomUUID()}`;
      await git.run(parent, ["init", "--quiet", "--bare", staging]);
      await git.run(staging, ["config", "remote.origin.url", remoteUrl]);
      const refspec = `+refs/heads/*:refs/remotes/origin/*`;
      await git.run(staging, ["config", "remote.origin.fetch", refspec]);
      await rename(staging, pool);
      return null;
    }
    const bare = await gitOrNull(git, pool, ["rev-parse", "--is-bare-repository"]);
    const url = await gitOrNull(git, pool, ["config", "--get", "remote.origin.url"]);
    if (bare !== "true" || url !== remoteUrl) {
      return {
        notStarted: `${pool} is not this project's Factory object pool; Factory will not use or remove it.`,
      };
    }
    return null;
  }

  async function ensureWorktree(commit: string): Promise<StepNotStarted | null> {
    await fetchDefault();
    if (!(await exists(dir))) {
      await git.run(pool, ["worktree", "add", "--quiet", "--detach", dir, commit]);
      return null;
    }
    const [mine, theirs] = await Promise.all([
      gitOrNull(git, dir, commonDir),
      git.run(pool, commonDir),
    ]);
    if (mine !== theirs) {
      return {
        notStarted: `${dir} exists and is not this project's Factory delivery checkout; Factory will not use or remove it.`,
      };
    }
    return null;
  }

  async function ensureLinks(): Promise<StepNotStarted | null> {
    const refusal = linkRefusal(input.links, path.basename(dir));
    if (refusal) return { notStarted: refusal };
    for (const link of input.links) {
      const target = await stat(link.target).catch(() => null);
      if (!target?.isDirectory() || (await realpath(link.target)) !== link.target) {
        return {
          notStarted: `The link target ${link.target} is not an existing directory at its own real path.`,
        };
      }
      const beside = path.join(path.dirname(dir), link.name);
      const existing = await lstat(beside).catch(() => null);
      if (existing === null) {
        await symlink(link.target, beside, "dir");
        continue;
      }
      if (!existing.isSymbolicLink() || (await readlink(beside)) !== link.target) {
        return {
          notStarted: `${beside} is not a link to exactly ${link.target}; Factory will not use or replace it.`,
        };
      }
    }
    return null;
  }

  async function fileAt(commit: string, file: string): Promise<string | null> {
    return gitOrNull(git, dir, ["show", `${commit}:${file}`]).then((text) =>
      text === null ? null : `${text}\n`,
    );
  }

  /** Record rows already on `commit` may be discarded; anything else in the tree refuses. */
  async function releaseDirt(
    commit: string,
    records: readonly string[],
  ): Promise<StepNotStarted | null> {
    for (const file of await changedPaths(git, dir)) {
      if (!records.includes(file)) {
        return {
          notStarted: `The delivery checkout has an uncommitted change to ${file}; nothing was started.`,
        };
      }
      if ((await fileAt(commit, file)) !== (await readWorking(file))) {
        return {
          notStarted: `The delivery checkout holds ${file} rows that are not committed yet; settle the last release first.`,
        };
      }
      await git.run(dir, ["checkout", "--quiet", "--", file]);
    }
    return null;
  }

  /** Origin tags arrive only where no local tag of that name differs: no `+`, so no clobbering. */
  async function importTags(patterns: readonly string[]): Promise<StepNotStarted | null> {
    if (patterns.length === 0) return null;
    const refspecs = patterns.map((pattern) => `refs/tags/${pattern}:refs/tags/${pattern}`);
    const fetched = await gitOrNull(git, pool, [
      "fetch",
      "--quiet",
      "--no-tags",
      remote,
      ...refspecs,
    ]);
    if (fetched !== null) return null;
    return {
      notStarted: `The origin has tags matching ${patterns.join(", ")} that differ from the delivery checkout's; nothing was started.`,
    };
  }

  async function prepare({ commit, records, importTags: patterns }: PrepareRequest) {
    const refusal =
      (await ensurePool()) ??
      (await ensureWorktree(commit)) ??
      (await ensureLinks()) ??
      (await importTags(patterns));
    if (refusal) return refusal;
    if ((await gitOrNull(git, dir, ["cat-file", "-e", `${commit}^{commit}`])) === null) {
      return { notStarted: `The delivery checkout cannot find ${commit} after fetching.` };
    }
    const dirt = await releaseDirt(commit, records);
    if (dirt) return dirt;
    await git.run(dir, ["checkout", "--quiet", "--detach", commit]);
    const head = await git.run(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const clean = (await changedPaths(git, dir)).length === 0;
    if (head !== commit || !clean)
      return { notStarted: "The delivery checkout did not settle at the commit." };
    return { head };
  }

  async function localTags(patterns: readonly string[]): Promise<Record<string, string>> {
    if (patterns.length === 0) return {};
    const refs = patterns.map((pattern) => `refs/tags/${pattern}`);
    const listing = await git.run(dir, [
      "for-each-ref",
      "--format=%(refname:strip=2) %(objectname)",
      ...refs,
    ]);
    const tags: Record<string, string> = {};
    for (const line of listing.split("\n").filter((row) => row !== "")) {
      const [name = "", object = ""] = line.split(" ");
      tags[name] = object;
    }
    return tags;
  }

  async function alreadyPushed(
    request: RecordsCommitRequest,
    paths: string[],
  ): Promise<RecordsCommitResult> {
    const line = await git.run(dir, [
      "log",
      "-1",
      "--first-parent",
      "--format=%H %P%x00%s",
      request.expectedHead,
      "--",
      ...paths,
    ]);
    const [ids = "", subject] = line.split("\0");
    const [commit = "", parent = ""] = ids.split(" ");
    if (subject !== request.message) return null;
    const touched = (
      await git.run(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
    ).split("\n");
    return { commit, parent, paths: touched };
  }

  async function fetchDefault(): Promise<void> {
    const fetched = `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`;
    await git.run(pool, ["fetch", "--quiet", "--no-tags", remote, fetched]);
  }

  async function commitRecords(request: RecordsCommitRequest): Promise<RecordsCommitResult> {
    await fetchDefault();
    if (
      (await gitOrNull(git, dir, ["cat-file", "-e", `${request.expectedHead}^{commit}`])) === null
    ) {
      return {
        refused: `The delivery checkout cannot find the expected head ${request.expectedHead}.`,
      };
    }
    const changed = await changedPaths(git, dir);
    const outside = changed.filter((file) => !request.records.includes(file));
    if (outside.length > 0)
      return {
        refused: `The delivery checkout changed ${outside.join(", ")}, which are not release records.`,
      };
    if (changed.length === 0) return null;
    const earlier = await alreadyPushed(request, changed);
    if (earlier !== null) return earlier;
    const scratch = await mkdtemp(path.join(tmpdir(), "vorteo-records-"));
    const index = { GIT_INDEX_FILE: path.join(scratch, "index") };
    try {
      await git.run(dir, ["read-tree", request.expectedHead], index);
      for (const file of changed) {
        const base = (await fileAt(request.base, file)) ?? "";
        const upstream = (await fileAt(request.expectedHead, file)) ?? "";
        if (upstream !== base)
          return {
            refused: `${file} changed on the default branch during the release; Factory will not merge record rows.`,
          };
        if (!appendsRows(base, await readWorking(file)))
          return { refused: `${file} changed other than by appended rows; nothing was committed.` };
        const blob = await git.run(dir, ["hash-object", "-w", "--", file]);
        await git.run(
          dir,
          ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`],
          index,
        );
      }
      const tree = await git.run(dir, ["write-tree"], index);
      const who = {
        GIT_AUTHOR_NAME: input.identity.name,
        GIT_AUTHOR_EMAIL: input.identity.email,
        GIT_COMMITTER_NAME: input.identity.name,
        GIT_COMMITTER_EMAIL: input.identity.email,
      };
      const commit = await git.run(
        dir,
        ["commit-tree", tree, "-p", request.expectedHead, "-m", request.message],
        who,
      );
      if (
        !(await request.authorizePush({
          commit,
          parent: request.expectedHead,
          expectedHead: request.expectedHead,
        }))
      ) {
        return { withheld: true };
      }
      // No force: the remote accepts only a fast-forward of the expected head.
      const pushed = await gitOrNull(git, dir, [
        "push",
        "--quiet",
        remote,
        `${commit}:refs/heads/${defaultBranch}`,
      ]);
      if (pushed === null)
        return {
          refused: "The records push was rejected; the default branch moved or refused it.",
        };
      return { commit, parent: request.expectedHead, paths: changed };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  return {
    path: dir,
    links: input.links,
    prepare,
    async blob(file) {
      return gitOrNull(git, dir, ["rev-parse", "--verify", `HEAD:${file}`]);
    },
    async tag(name) {
      const head = await git.run(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const existing = await gitOrNull(git, dir, [
        "rev-parse",
        "-q",
        "--verify",
        `refs/tags/${name}^{commit}`,
      ]);
      if (existing === head) return { tagged: true };
      if (existing !== null)
        return { notStarted: `The tag ${name} already names ${existing}, not ${head}.` };
      await git.run(dir, ["tag", name, head]);
      return { tagged: true };
    },
    commitRecords,
    tags: localTags,
    // The dependency link a Factory-made frozen copy carries points at this checkout's own tree.
    artifactEvidence: (request) =>
      readArtifactEvidence(
        input.links,
        request,
        request.dependencies ? path.join(dir, request.dependencies.link) : null,
      ),
    async pushTags(request) {
      const all = await localTags(request.names);
      const tags = request.names.map((name) => ({ name, object: all[name] ?? "" }));
      if (tags.some((tag) => tag.object === ""))
        return { refused: "A tag to publish is missing locally." };
      if (!(await request.authorizePush(tags))) return { withheld: true };
      // Atomic and without force: the origin refuses the whole push if any name exists elsewhere.
      const refs = tags.map((tag) => `refs/tags/${tag.name}`);
      const pushed = await gitOrNull(git, dir, ["push", "--quiet", "--atomic", remote, ...refs]);
      if (pushed === null) {
        return {
          refused: `The origin refused the tags ${request.names.join(", ")}; one may already name another object there.`,
        };
      }
      return { pushed: tags };
    },
  };
}
