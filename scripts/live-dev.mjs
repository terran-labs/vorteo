#!/usr/bin/env node
// Change an installation's live checkout safely. See docs/live-dev-mode.md.
//
//   node scripts/live-dev.mjs status
//   node scripts/live-dev.mjs claim --by <thread> <file>...
//   node scripts/live-dev.mjs release --by <thread>
//   node scripts/live-dev.mjs commit --by <thread> -m <message>
//   node scripts/live-dev.mjs promote <branch> --by <thread>
//   node scripts/live-dev.mjs sync --by <thread>
//   node scripts/live-dev.mjs prepare
//
// Every Git change takes the live lock and refuses rather than guessing. Tweaks are ordinary
// edits in the live checkout: Fast Refresh shows them at once, and `commit` records them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIVE_BRANCH = "live/main";

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

/** One Git change at a time. A lock whose process is gone is stale and is replaced. */
export function withLock(paths, by, action) {
  try {
    mkdirSync(paths.lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = readJson(path.join(paths.lock, "owner.json"), null);
    if (owner && alive(owner.pid))
      throw new LiveDevRefusal(
        `The live checkout is busy: ${owner.by} is running ${owner.command}.`,
      );
    rmSync(paths.lock, { recursive: true, force: true });
    mkdirSync(paths.lock);
  }
  writeFileSync(
    path.join(paths.lock, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      by,
      command: process.argv[2],
      at: new Date().toISOString(),
    }),
  );
  try {
    return action();
  } finally {
    rmSync(paths.lock, { recursive: true, force: true });
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
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
  const output = git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
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
      const owner = claimOwner(claims, file);
      if (owner && owner !== by) throw new LiveDevRefusal(`${file} is being edited by ${owner}.`);
    }
    const mine = claims.find((item) => item.by === by) ?? {
      by,
      files: [],
      at: null,
    };
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

function dependencyInputsChanged(checkout, before, after) {
  if (before === after) return false;
  const changed = git(checkout, ["diff", "--name-only", before, after]).split("\n");
  return changed.some(
    (file) =>
      file === "package-lock.json" || file.endsWith("package.json") || file.startsWith("patches/"),
  );
}

/** Reinstall when dependency inputs changed, then ask the coordinator to restart Metro. */
function afterChange(paths, before, log) {
  const after = git(paths.checkout, ["rev-parse", "HEAD"]);
  if (!dependencyInputsChanged(paths.checkout, before, after)) return after;
  log("Dependency inputs changed; reinstalling and restarting the live dev server.");
  prepare(paths, log);
  writeFileSync(paths.restartRequest, `${new Date().toISOString()}\n`);
  return after;
}

/** Commits this thread's claimed edits on the live branch and releases its claim. */
export function commit(paths, by, message, log = console.log) {
  if (!message?.trim()) throw new LiveDevRefusal("Give a commit message with -m.");
  return withLock(paths, by, () => {
    requireLiveBranch(paths);
    const claims = readClaims(paths);
    const mine = claims.find((item) => item.by === by);
    const dirty = new Set(dirtyFiles(paths.checkout));
    const files = (mine?.files ?? []).filter((file) => dirty.has(file));
    if (files.length === 0) throw new LiveDevRefusal("You have no claimed edits to commit.");
    const before = git(paths.checkout, ["rev-parse", "HEAD"]);
    git(paths.checkout, ["add", "--", ...files]);
    // Repository hooks run as for any commit; a failing hook leaves the edits in place.
    git(paths.checkout, ["commit", "-m", message, "-m", `Live tweak by ${by}.`, "--", ...files]);
    writeClaims(
      paths,
      claims.filter((item) => item.by !== by),
    );
    return afterChange(paths, before, log);
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
    `The live checkout has uncommitted edits (${
      dirty.length
    } files, from ${owners.join(", ")}). Commit or release them first.`,
  );
}

function merge(paths, by, ref, log) {
  return withLock(paths, by, () => {
    requireLiveBranch(paths);
    requireClean(paths);
    const before = git(paths.checkout, ["rev-parse", "HEAD"]);
    try {
      git(paths.checkout, ["merge", "--no-edit", ref]);
    } catch (error) {
      try {
        git(paths.checkout, ["merge", "--abort"]);
      } catch {
        // The merge never started, for example an unknown branch.
      }
      throw new LiveDevRefusal(
        `Merging ${ref} conflicts with the live checkout; nothing changed. ${
          error.stderr ?? ""
        }`.trim(),
      );
    }
    return afterChange(paths, before, log);
  });
}

export function promote(paths, by, branch, log = console.log) {
  if (!branch) throw new LiveDevRefusal("Name the branch to promote.");
  return merge(paths, by, branch, log);
}

export function sync(paths, by, log = console.log) {
  git(paths.checkout, [
    "fetch",
    "--no-prune",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  return merge(paths, by, "origin/main", log);
}

/** Installs dependencies and builds what the web app imports from sibling packages. */
export function prepare(paths, log = console.log) {
  const options = { cwd: paths.checkout, stdio: "inherit" };
  log("Installing live checkout dependencies.");
  execFileSync(process.execPath, ["scripts/install-dependencies.mjs"], options);
  log("Building app dependencies.");
  execFileSync("npm", ["run", "build:app-deps"], options);
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { by: null, message: null, positional: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--by") options.by = rest[++index];
    else if (value === "-m") options.message = rest[++index];
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
      console.log(commit(paths, requireBy(), args.message));
      return;
    case "promote":
      console.log(promote(paths, requireBy(), args.positional[0]));
      return;
    case "sync":
      console.log(sync(paths, requireBy()));
      return;
    case "prepare":
      prepare(paths);
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
