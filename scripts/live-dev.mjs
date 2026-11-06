#!/usr/bin/env node
// Change an installation's live checkout safely. See docs/live-dev-mode.md.
//
//   node scripts/live-dev.mjs status
//   node scripts/live-dev.mjs claim --by <thread> <file>...
//   node scripts/live-dev.mjs release --by <thread>
//   node scripts/live-dev.mjs commit --by <thread> -m <message> [--note <change fragment line>]
//   node scripts/live-dev.mjs promote <local branch> --by <thread>
//   node scripts/live-dev.mjs sync --by <thread>
//   node scripts/live-dev.mjs prepare [--by <thread>]
//
// Every Git change takes the live lock and refuses rather than guessing. Tweaks are ordinary
// edits in the live checkout: Fast Refresh shows them at once, and `commit` records them.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRAGMENT_DIRECTORY } from "./lib/change-fragments.mjs";
import { dependencyKey } from "./lib/dependency-cache.mjs";

const LIVE_BRANCH = "live/main";
/** A lock directory with no owner record is still being created, unless it is this old. */
const ORPHAN_LOCK_MS = 10 * 60_000;
/**
 * Release preparation and older commits add entries at the top of these files, so merges
 * keep both sides. Tweaks record their notes in change fragments instead.
 */
const UNION_FILES = ["VORTEO_CHANGELOG.md", "docs/vorteo-customizations.md"];

export class LiveDevRefusal extends Error {}

function defaultCheckout() {
  const own = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (path.basename(own) === "source" && path.basename(path.dirname(own)) === "live") return own;
  return (
    process.env.VORTEO_LIVE_CHECKOUT ?? path.join(os.homedir(), "vorteo", "host", "live", "source")
  );
}

export function livePaths(checkout) {
  const root = path.dirname(checkout);
  return {
    checkout,
    root,
    lock: path.join(root, "lock"),
    claims: path.join(root, "claims.json"),
    restartRequest: path.join(root, "restart-request"),
    preparedKey: path.join(root, "prepared-key"),
    mergeAttributes: path.join(root, "merge-attributes"),
  };
}

function git(checkout, args, options = {}) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * One Git change at a time. The lock directory appears atomically with its owner record, so
 * nobody sees a half-made lock. A lock whose process is gone is moved aside and retaken.
 */
export function withLock(paths, by, action) {
  const staging = `${paths.lock}.${process.pid}.${randomUUID()}`;
  mkdirSync(staging);
  writeFileSync(
    path.join(staging, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      by,
      command: process.argv[2],
      at: new Date().toISOString(),
    }),
  );
  let held = false;
  try {
    for (let attempt = 0; attempt < 2 && !held; attempt += 1) {
      try {
        renameSync(staging, paths.lock);
        held = true;
      } catch (error) {
        if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
        const owner = readJson(path.join(paths.lock, "owner.json"), null);
        const young = !owner && Date.now() - statSync(paths.lock).mtimeMs < ORPHAN_LOCK_MS;
        if ((owner && alive(owner.pid)) || young)
          throw new LiveDevRefusal(
            `The live checkout is busy${owner ? `: ${owner.by} is running ${owner.command}` : ""}.`,
          );
        // Only one taker can move the stale lock aside; the loser retries and finds it held.
        try {
          renameSync(paths.lock, `${paths.lock}.stale.${randomUUID()}`);
        } catch {
          // Someone else moved it first.
        }
      }
    }
    if (!held) throw new LiveDevRefusal("The live checkout is busy.");
    return action();
  } finally {
    if (held) rmSync(paths.lock, { recursive: true, force: true });
    else rmSync(staging, { recursive: true, force: true });
  }
}

function readClaims(paths) {
  return readJson(paths.claims, { claims: [] }).claims;
}

function writeClaims(paths, claims) {
  writeFileSync(paths.claims, `${JSON.stringify({ claims }, null, 2)}\n`);
}

/** Paths with uncommitted changes, relative to the checkout. */
export function dirtyFiles(checkout) {
  // Untrimmed: each entry starts with a status column that may be a space.
  const output = execFileSync(
    "git",
    ["-C", checkout, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const files = [];
  const entries = output.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    files.push(entry.slice(3));
    // Renames and copies carry the source path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return files;
}

function normalize(checkout, file) {
  const relative = path.relative(checkout, path.resolve(process.cwd(), file));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new LiveDevRefusal(`${file} is outside the live checkout.`);
  return relative;
}

function claimOwner(claims, file) {
  return claims.find((item) => item.files.includes(file))?.by ?? null;
}

export function status(paths) {
  const claims = readClaims(paths);
  const dirty = dirtyFiles(paths.checkout);
  return {
    checkout: paths.checkout,
    branch: git(paths.checkout, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head: git(paths.checkout, ["rev-parse", "--short", "HEAD"]),
    aheadOfMain: Number(git(paths.checkout, ["rev-list", "--count", "origin/main..HEAD"])),
    claims,
    edits: dirty.map((file) => ({ file, claimedBy: claimOwner(claims, file) })),
    busy: readJson(path.join(paths.lock, "owner.json"), null),
  };
}

/** Advisory: tells other threads which files are being edited. Refuses another's file. */
export function claim(paths, by, files) {
  return withLock(paths, by, () => {
    const claims = readClaims(paths);
    const wanted = files.map((file) => normalize(paths.checkout, file));
    for (const file of wanted) {
      if (UNION_FILES.includes(file))
        throw new LiveDevRefusal(
          `${file} changes only in release preparation; commit records a change fragment.`,
        );
      const owner = claimOwner(claims, file);
      if (owner && owner !== by) throw new LiveDevRefusal(`${file} is being edited by ${owner}.`);
    }
    const mine = claims.find((item) => item.by === by) ?? { by, files: [], at: null };
    mine.files = [...new Set([...mine.files, ...wanted])];
    mine.at = new Date().toISOString();
    writeClaims(paths, [...claims.filter((item) => item.by !== by), mine]);
    return mine;
  });
}

export function release(paths, by) {
  return withLock(paths, by, () => {
    writeClaims(
      paths,
      readClaims(paths).filter((item) => item.by !== by),
    );
  });
}

/**
 * Reinstalls when what `npm ci` would install changed, judged by the shared dependency cache
 * key, which ignores workspace version bumps. Then asks the coordinator to restart Metro.
 */
function refreshDependencies(paths, log) {
  const key = dependencyKey(paths.checkout, "worktree");
  const prepared = existsSync(paths.preparedKey)
    ? readFileSync(paths.preparedKey, "utf8").trim()
    : null;
  if (key === prepared) return;
  log("Dependency inputs changed; reinstalling and restarting the live dev server.");
  installAndBuild(paths, log);
  writeFileSync(paths.restartRequest, `${new Date().toISOString()}\n`);
}

/** The owner's local date, as the repository's changelog headings use. */
function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The commit hook requires a change fragment: the changelog line and inventory review for
 * this tweak, in a new file of its own so it never conflicts with other commits.
 * @returns {string} the fragment's path relative to the checkout
 */
function recordTweak(paths, by, note) {
  const file = `${FRAGMENT_DIRECTORY}/${today()}-live-${randomUUID().slice(0, 8)}.md`;
  mkdirSync(path.join(paths.checkout, FRAGMENT_DIRECTORY), { recursive: true });
  const line = note.replace(/\s*\n\s*/g, " ");
  writeFileSync(
    path.join(paths.checkout, file),
    `### Live tweaks\n\n- ${line}\n\n## Maintenance review\n\nLive tweak by ${by}: ${line}\n`,
  );
  return file;
}

/** Commits this thread's claimed edits on the live branch and releases its claim. */
export function commit(paths, by, message, note, log = console.log) {
  if (!message?.trim()) throw new LiveDevRefusal("Give a commit message with -m.");
  return withLock(paths, by, () => {
    requireLiveBranch(paths);
    const claims = readClaims(paths);
    const mine = claims.find((item) => item.by === by);
    const dirty = new Set(dirtyFiles(paths.checkout));
    const files = (mine?.files ?? []).filter((file) => dirty.has(file));
    if (files.length === 0) throw new LiveDevRefusal("You have no claimed edits to commit.");
    const fragment = recordTweak(paths, by, (note ?? message).trim());
    const all = [...files, fragment];
    try {
      git(paths.checkout, ["add", "--", ...all]);
      // Repository hooks run as for any commit.
      git(paths.checkout, ["commit", "-m", message, "-m", `Live tweak by ${by}.`, "--", ...all]);
    } catch (error) {
      // A failing hook leaves the tweak in place; only the generated fragment is undone.
      git(paths.checkout, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", fragment]);
      rmSync(path.join(paths.checkout, fragment), { force: true });
      git(paths.checkout, ["restore", "--staged", "--", ...files]);
      throw new LiveDevRefusal(`The commit was refused. ${error.stderr ?? error.message}`.trim());
    }
    writeClaims(
      paths,
      claims.filter((item) => item.by !== by),
    );
    refreshDependencies(paths, log);
    return git(paths.checkout, ["rev-parse", "HEAD"]);
  });
}

function requireLiveBranch(paths) {
  const branch = git(paths.checkout, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== LIVE_BRANCH)
    throw new LiveDevRefusal(`The live checkout is on ${branch}, not ${LIVE_BRANCH}.`);
}

function requireClean(paths) {
  const claims = readClaims(paths);
  const dirty = dirtyFiles(paths.checkout);
  if (dirty.length === 0) return;
  const owners = [...new Set(dirty.map((file) => claimOwner(claims, file) ?? "an unclaimed edit"))];
  throw new LiveDevRefusal(
    `The live checkout has uncommitted edits (${dirty.length} files, from ${owners.join(", ")}). Commit or release them first.`,
  );
}

function unionGit(paths, args) {
  writeFileSync(paths.mergeAttributes, UNION_FILES.map((file) => `${file} merge=union\n`).join(""));
  return git(paths.checkout, ["-c", `core.attributesFile=${paths.mergeAttributes}`, ...args]);
}

/**
 * Merges only when Git can do it without conflicts, checked first in memory, so conflict
 * markers never reach the watched tree and the owner's tab.
 */
function merge(paths, by, commitish, label, log) {
  return withLock(paths, by, () => {
    requireLiveBranch(paths);
    requireClean(paths);
    try {
      unionGit(paths, ["merge-tree", "--write-tree", "--name-only", "HEAD", commitish]);
    } catch (error) {
      // Output: the tree ID, conflicted paths, a blank line, then informational messages.
      const lines = (error.stdout ?? "").split("\n").slice(1);
      const end = lines.indexOf("");
      const conflicted = (end === -1 ? lines : lines.slice(0, end)).filter(Boolean);
      throw new LiveDevRefusal(
        `${label} conflicts with the live checkout${conflicted.length ? ` in ${conflicted.join(", ")}` : ""}; nothing changed.`,
      );
    }
    try {
      unionGit(paths, ["merge", "--no-commit", "--no-ff", commitish]);
      // A union merge drops blank lines between entries; restore the repository's formatting.
      execFileSync("npm", ["run", "format:files", "--", ...UNION_FILES], {
        cwd: paths.checkout,
        stdio: "ignore",
      });
      git(paths.checkout, ["add", "--", ...UNION_FILES]);
      // Repository hooks run on the merge commit as on any other.
      git(paths.checkout, ["commit", "-m", `Merge ${label} into ${LIVE_BRANCH}`]);
    } catch (error) {
      git(paths.checkout, ["merge", "--abort"]);
      throw new LiveDevRefusal(
        `Merging ${label} was refused; the live checkout is unchanged. ${error.stderr ?? error.message}`.trim(),
      );
    }
    refreshDependencies(paths, log);
    return git(paths.checkout, ["rev-parse", "HEAD"]);
  });
}

/** Only local branches on Host: a remote ref could carry unreviewed code from elsewhere. */
export function promote(paths, by, branch, log = console.log) {
  if (!branch || branch.startsWith("-") || branch.includes(".."))
    throw new LiveDevRefusal("Name the local branch to promote.");
  let commitish;
  try {
    commitish = git(paths.checkout, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${branch}^{commit}`,
    ]);
  } catch {
    throw new LiveDevRefusal(`${branch} is not a local branch.`);
  }
  return merge(paths, by, commitish, branch, log);
}

export function sync(paths, by, log = console.log) {
  git(paths.checkout, [
    "fetch",
    "--no-prune",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  const commitish = git(paths.checkout, ["rev-parse", "--verify", "refs/remotes/origin/main"]);
  return merge(paths, by, commitish, "main", log);
}

/** Installs dependencies and builds what the web app imports from sibling packages. */
function installAndBuild(paths, log) {
  const options = { cwd: paths.checkout, stdio: "inherit" };
  log("Installing live checkout dependencies.");
  execFileSync(process.execPath, ["scripts/install-dependencies.mjs"], options);
  // The commit hook typechecks every package, and packages/cli imports the server's built
  // declarations, so a fresh checkout needs the server stack built before its first commit.
  log("Building the server stack.");
  execFileSync("npm", ["run", "build:server"], options);
  log("Building app dependencies.");
  execFileSync("npm", ["run", "build:app-deps"], options);
  // Recorded only after success, so a failed install is retried next time.
  writeFileSync(paths.preparedKey, `${dependencyKey(paths.checkout, "worktree")}\n`);
}

export function prepare(paths, by, log = console.log) {
  return withLock(paths, by, () => installAndBuild(paths, log));
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { by: null, message: null, note: null, positional: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--by") options.by = rest[++index];
    else if (value === "-m") options.message = rest[++index];
    else if (value === "--note") options.note = rest[++index];
    else if (value === "--checkout") options.checkout = rest[++index];
    else options.positional.push(value);
  }
  return { command, ...options };
}

function main() {
  const args = parse(process.argv.slice(2));
  const paths = livePaths(path.resolve(args.checkout ?? defaultCheckout()));
  if (!existsSync(paths.checkout))
    throw new LiveDevRefusal(`No live checkout at ${paths.checkout}. Turn on live dev mode first.`);
  const requireBy = () => {
    if (!args.by) throw new LiveDevRefusal("Say who you are with --by <thread title>.");
    return args.by;
  };
  switch (args.command) {
    case "status":
      console.log(JSON.stringify(status(paths), null, 2));
      return;
    case "claim":
      console.log(JSON.stringify(claim(paths, requireBy(), args.positional), null, 2));
      return;
    case "release":
      release(paths, requireBy());
      return;
    case "commit":
      console.log(commit(paths, requireBy(), args.message, args.note));
      return;
    case "promote":
      console.log(promote(paths, requireBy(), args.positional[0]));
      return;
    case "sync":
      console.log(sync(paths, requireBy()));
      return;
    case "prepare":
      prepare(paths, args.by ?? "the installation coordinator");
      return;
    default:
      throw new LiveDevRefusal(
        `Unknown command ${args.command ?? "(none)"}. See the header of this script.`,
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof LiveDevRefusal ? `Refused: ${error.message}` : error);
    process.exit(1);
  }
}
