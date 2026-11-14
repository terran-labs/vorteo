#!/usr/bin/env node
// Host checks on request: file-table pressure, stale task worktrees and Time Machine coverage.
// Prints one JSON report; the caller decides how to alert. Probes read state, but --lock
// creates, renames and removes lock files. Exact worktree and --precious paths are printed;
// never pass credential paths. Git disables optional index writes. See
// docs/execution-installation.md#host-watch.
//
//   node scripts/maintenance/host-watch.mjs \
//     [--dev-container <name>] [--docker <path>]   Dev's cached inodes, and worktrees only Dev sees
//     [--projects <folder>]... [--root <folder>]...  repositories whose worktrees to check
//     [--precious <path>]...                         paths the latest backup must contain
//     [--stale-hours 24] [--worktree-seconds 120]  staleness window, worktree pass deadline
//     [--inspect-worktree-files]                    expensive status scan, investigation only
//     [--lock <file>]                                skip this run while another holds it
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** Share of a limit at which a check warns, and becomes critical. */
export const THRESHOLDS = { warn: 0.7, critical: 0.85 };

const RANK = { ok: 0, unknown: 1, warn: 2, critical: 3 };
const worst = (statuses) =>
  statuses.reduce((current, status) => (RANK[status] > RANK[current] ? status : current), "ok");

function level(used, limit) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return "unknown";
  const share = used / limit;
  if (share >= THRESHOLDS.critical) return "critical";
  return share >= THRESHOLDS.warn ? "warn" : "ok";
}

function describe(part) {
  if (part.status === "unknown") return `${part.name} unknown`;
  return `${part.name} ${part.used} of ${part.limit} (${Math.round((part.used / part.limit) * 100)}%)`;
}

/**
 * File-table pressure. Each file the Docker VM caches from a shared folder keeps a Host file
 * handle in the VM process until the VM evicts it, so the VM can fill its per-process limit and
 * then the Mac's file table. Dev's cached shared-folder inodes (`fuse_inode` slab objects) lead
 * the VM's handle count, so they are judged against the same per-process limit. A probe that
 * was requested but failed reports unknown; `null` means it was not requested.
 */
export function fileTableCheck({ maxFiles, maxFilesPerProc, openFiles, vmOpenFiles, fuseInodes }) {
  const part = (name, used, limit) => ({ name, status: level(used, limit), used, limit });
  const parts = [part("system", openFiles, maxFiles)];
  if (vmOpenFiles !== null) parts.push(part("Docker VM", vmOpenFiles, maxFilesPerProc));
  if (fuseInodes !== null)
    parts.push(part("Dev cached shared-folder inodes", fuseInodes, maxFilesPerProc));
  return {
    id: "file-table",
    status: worst(parts.map((item) => item.status)),
    summary: parts.map(describe).join("; "),
    detail: parts,
  };
}

/** Worktrees with uncommitted or unpushed work untouched for longer than the window. */
export function staleWorktreeCheck(
  { worktrees, skipped = 0, unreadable = [], inspectFiles = true },
  { now, staleHours },
) {
  const scope = inspectFiles ? "uncommitted or unpushed work" : "unpushed commits or no remote";
  const stale = worktrees.filter(
    (worktree) =>
      (worktree.dirty || worktree.unpushed > 0 || worktree.noRemote) &&
      now - worktree.lastActivity > staleHours * 3_600_000,
  );
  const parts = [];
  if (stale.length)
    parts.push(`${stale.length} worktrees with ${scope} untouched for over ${staleHours} hours`);
  if (skipped) parts.push(`${skipped} worktree or repository probes unreadable or skipped`);
  let status = "ok";
  if (stale.length) status = "warn";
  else if (skipped) status = "unknown";
  return {
    id: "stale-worktrees",
    status,
    summary: parts.length
      ? parts.join("; ")
      : `No worktrees with ${scope} untouched for over ${staleHours} hours among ${worktrees.length} checked`,
    fileChangesChecked: inspectFiles,
    detail: [
      ...stale.map(({ path: location, dirty, unpushed, noRemote }) =>
        noRemote ? { path: location, dirty, noRemote } : { path: location, dirty, unpushed },
      ),
      ...unreadable.map((location) => ({ path: location, status: "unknown" })),
    ],
  };
}

/** Whether the latest completed Time Machine backup contains every precious path. */
export function backupCoverageCheck({ latest, contains }, precious) {
  if (!latest)
    return {
      id: "backup-coverage",
      status: "warn",
      summary: "No completed Time Machine backup is available",
      detail: [],
    };
  const missing = precious.filter((item) => !contains(latest, item));
  return {
    id: "backup-coverage",
    status: missing.length ? "warn" : "ok",
    summary: missing.length
      ? `The latest completed backup (${path.basename(latest)}) lacks ${missing.length} of ${precious.length} precious paths`
      : `The latest completed backup (${path.basename(latest)}) contains all ${precious.length} precious paths`,
    detail: missing,
  };
}

function run(command, args, { timeout = 15_000 } = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
    timeout,
    // Disable optional index writes and locking; this does not prevent file traversal.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function sysctl(name) {
  return Number(run("/usr/sbin/sysctl", ["-n", name]).trim());
}

/** Open files of the Docker Desktop VM process with the most; NaN when it cannot be read. */
function dockerVmOpenFiles() {
  let pids;
  try {
    pids = run("/usr/bin/pgrep", ["-f", "com.apple.Virtualization.VirtualMachine"])
      .split("\n")
      .filter(Boolean);
  } catch {
    // pgrep exits 1 when no VM runs: then nothing holds files.
    return 0;
  }
  let most = NaN;
  for (const pid of pids) {
    try {
      // One `f<descriptor>` line per open file; lsof truncates large numbers to `*<digits>`.
      const count = countDescriptors(
        run("/usr/sbin/lsof", ["-n", "-P", "-F", "f", "-p", pid], { timeout: 60_000 }),
      );
      most = Number.isFinite(most) ? Math.max(most, count) : count;
    } catch {
      // The process ended or cannot be read.
    }
  }
  return most;
}

/** Active `fuse_inode` slab objects from /proc/slabinfo, or NaN. */
/** Open-file lines in `lsof -F f` output: numbered and truncated descriptors, not cwd or txt. */
export function countDescriptors(output) {
  return output.split("\n").filter((line) => /^f(\d|\*)/.test(line)).length;
}

export function parseFuseInodes(slabinfo) {
  const line = slabinfo.split("\n").find((row) => row.startsWith("fuse_inode "));
  return line ? Number(line.split(/\s+/)[1]) : NaN;
}

function devFuseInodes(docker, container) {
  try {
    return parseFuseInodes(run(docker, ["exec", "-u", "0", container, "cat", "/proc/slabinfo"]));
  } catch {
    return NaN;
  }
}

/** Finite, capped budget, validated before any probes or lock maintenance. */
export function worktreeSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300)
    throw new Error("--worktree-seconds must be between 1 and 300 seconds");
  return seconds;
}

function remaining(deadline, now) {
  const milliseconds = Math.floor(deadline - now());
  if (!Number.isFinite(milliseconds) || milliseconds < 1)
    throw new Error("Worktree deadline reached");
  return milliseconds;
}

/** Shared by Host and Dev. Keep dependencies explicit so Dev executes the same probes. */
export function inspectWorktree(location, { deadline, inspectFiles, filesystem, execute, now }) {
  const budget = () => {
    const milliseconds = Math.floor(deadline - now());
    if (!Number.isFinite(milliseconds) || milliseconds < 1)
      throw new Error("Worktree deadline reached");
    return Math.min(15_000, milliseconds);
  };
  const stat = (name) => {
    budget();
    return filesystem.statSync(name);
  };
  const git = (args) => {
    const output = execute("git", ["-C", location, "-c", "core.fsmonitor=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
      timeout: budget(),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    budget();
    return output.trim();
  };
  try {
    if (!stat(location).isDirectory()) throw new Error("Not a directory");
    const gitDir = git(["rev-parse", "--absolute-git-dir"]);
    if (!gitDir.startsWith("/")) throw new Error("Invalid Git directory");
    let activity;
    try {
      activity = stat(`${gitDir}/index`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      activity = stat(gitDir);
    }
    const lastActivity = activity.mtimeMs;
    const noRemote = git(["remote"]) === "";
    const count = noRemote ? "0" : git(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (!/^\d+$/.test(count)) throw new Error("Invalid commit count");
    const unpushed = Number(count);
    if (!Number.isFinite(lastActivity) || !Number.isSafeInteger(unpushed) || unpushed < 0)
      throw new Error("Invalid worktree metadata");
    // Status traverses tracked and untracked files even with optional locks disabled.
    const dirty = inspectFiles ? git(["status", "--porcelain"]) !== "" : null;
    budget();
    return { path: location, status: "ok", dirty, noRemote, unpushed, lastActivity };
  } catch {
    return { path: location, status: "unknown" };
  }
}

// JSON preserves unusual paths. Every requested path gets a row, including failed probes.
const DEV_WORKTREE_SCRIPT = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const inspectWorktree = ${inspectWorktree.toString()};
const { paths, deadline, inspectFiles } = JSON.parse(fs.readFileSync(0, "utf8"));
for (const location of paths) {
  const row = inspectWorktree(location, { deadline, inspectFiles, filesystem: fs,
    execute: execFileSync, now: Date.now });
  process.stdout.write(JSON.stringify(row) + "\\n");
}`;

/** Missing, duplicate or malformed executor rows cannot turn a failed probe healthy. */
export function parseDevWorktrees(output, paths) {
  const rows = new Map();
  for (const line of output.split("\n").filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      rows.set(row.path, rows.has(row.path) ? null : row);
    } catch {
      /* Missing rows below remain unknown. */
    }
  }
  const worktrees = [];
  const unreadable = [];
  for (const location of paths) {
    const row = rows.get(location);
    if (
      row?.status !== "ok" ||
      !Number.isFinite(row.lastActivity) ||
      !Number.isSafeInteger(row.unpushed) ||
      row.unpushed < 0 ||
      typeof row.noRemote !== "boolean" ||
      !(row.dirty === null || typeof row.dirty === "boolean")
    ) {
      unreadable.push(location);
    } else {
      const { status: _status, ...worktree } = row;
      worktrees.push(worktree);
    }
  }
  return { worktrees, skipped: unreadable.length, unreadable };
}

export function devWorktrees(
  { docker, container },
  paths,
  deadline,
  { inspectFiles = false, execute = execFileSync, now = Date.now } = {},
) {
  try {
    const milliseconds = remaining(deadline, now);
    const output = execute(
      docker,
      [
        "exec",
        "-i",
        "-e",
        "GIT_OPTIONAL_LOCKS=0",
        "-u",
        "paseo",
        container,
        "timeout",
        String(milliseconds / 1000),
        "node",
        "-e",
        DEV_WORKTREE_SCRIPT,
      ],
      {
        input: JSON.stringify({ paths, deadline, inspectFiles }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
        timeout: milliseconds,
      },
    );
    return parseDevWorktrees(output, paths);
  } catch {
    return { worktrees: [], skipped: paths.length, unreadable: paths };
  }
}

/** Discovery and every probe share one budget, including probes inside Dev. */
export function collectWorktrees(
  folders,
  deadline,
  dev,
  { inspectFiles = false, filesystem = fs, execute = execFileSync, now = Date.now } = {},
) {
  const seen = new Set();
  const found = [];
  const unreadable = [];
  const elsewhere = [];
  const probe = (fn) => {
    remaining(deadline, now);
    return fn();
  };
  const git = (cwd, args) => {
    const output = execute("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
      timeout: Math.min(15_000, remaining(deadline, now)),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    remaining(deadline, now);
    return output.trim();
  };
  const inspect = (location) => {
    try {
      if (!probe(() => filesystem.existsSync(location)) && dev) {
        elsewhere.push(location);
        return;
      }
      const row = inspectWorktree(location, { deadline, inspectFiles, filesystem, execute, now });
      if (row.status !== "ok") unreadable.push(location);
      else {
        const { status: _status, ...worktree } = row;
        found.push(worktree);
      }
    } catch {
      unreadable.push(location);
    }
  };
  for (const folder of folders) {
    let children;
    try {
      children = probe(() => filesystem.readdirSync(folder));
    } catch {
      unreadable.push(folder);
      continue;
    }
    for (const name of children) {
      const repository = path.join(folder, name);
      try {
        if (!probe(() => filesystem.existsSync(path.join(repository, ".git")))) continue;
        const common = path.resolve(repository, git(repository, ["rev-parse", "--git-common-dir"]));
        if (seen.has(common)) continue;
        seen.add(common);
        const listing = git(repository, ["worktree", "list", "--porcelain", "-z"]);
        const paths = listing
          .split("\0")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length))
          .slice(1);
        for (const location of paths) inspect(location);
      } catch {
        unreadable.push(repository);
      }
    }
  }
  if (elsewhere.length) {
    const fromDev = devWorktrees(dev, elsewhere, deadline, { inspectFiles, execute, now });
    found.push(...fromDev.worktrees);
    unreadable.push(...fromDev.unreadable);
  }
  return { worktrees: found, skipped: unreadable.length, unreadable, inspectFiles };
}

function latestBackup() {
  try {
    const latest = run("/usr/bin/tmutil", ["latestbackup"]).trim();
    return latest && fs.existsSync(latest) ? latest : null;
  } catch {
    return null;
  }
}

/** Whether a Host path exists inside one of the backup's volume folders. */
function backupContains(latest, item) {
  let volumes;
  try {
    volumes = fs.readdirSync(latest);
  } catch {
    return false;
  }
  return volumes.some((volume) => fs.existsSync(path.join(latest, volume, item)));
}

function isAlive(pid) {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Holds `file` for this run; false while another live run holds it. A lock whose holder has
 * exited, or which is empty, is moved aside under a private name and read again, so two runs
 * taking over the same stale lock cannot both proceed.
 */
function takeLock(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      process.on("exit", () => {
        if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.rmSync(file, { force: true });
      });
      return true;
    } catch {
      // Held, or just released; decide below.
    }
    let seen;
    try {
      seen = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (isAlive(Number(seen))) return false;
    const aside = `${file}.stale-${process.pid}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      continue;
    }
    if (fs.readFileSync(aside, "utf8") !== seen) {
      // Another run took the lock in between: put its lock back and leave it running.
      try {
        fs.linkSync(aside, file);
      } catch {
        // A third run holds it now.
      }
      fs.rmSync(aside, { force: true });
      return false;
    }
    fs.rmSync(aside, { force: true });
  }
  return false;
}

function main() {
  const { values } = parseArgs({
    options: {
      "dev-container": { type: "string" },
      docker: { type: "string", default: "/Applications/Docker.app/Contents/Resources/bin/docker" },
      projects: { type: "string", multiple: true, default: [] },
      root: { type: "string", multiple: true, default: [] },
      precious: { type: "string", multiple: true, default: [] },
      "stale-hours": { type: "string", default: "24" },
      "worktree-seconds": { type: "string", default: "120" },
      "inspect-worktree-files": { type: "boolean", default: false },
      lock: { type: "string" },
    },
  });
  const seconds = worktreeSeconds(values["worktree-seconds"]);
  const staleHours = Number(values["stale-hours"]);
  if (!Number.isFinite(staleHours) || staleHours <= 0)
    throw new Error("--stale-hours must be finite and positive");
  if (values.lock && !takeLock(values.lock)) {
    console.log(
      JSON.stringify({ checkedAt: new Date().toISOString(), status: "skipped", checks: [] }),
    );
    return;
  }
  const checks = [];
  try {
    checks.push(
      fileTableCheck({
        maxFiles: sysctl("kern.maxfiles"),
        maxFilesPerProc: sysctl("kern.maxfilesperproc"),
        openFiles: sysctl("kern.num_files"),
        vmOpenFiles: dockerVmOpenFiles(),
        fuseInodes: values["dev-container"]
          ? devFuseInodes(values.docker, values["dev-container"])
          : null,
      }),
    );
  } catch (error) {
    checks.push({ id: "file-table", status: "unknown", summary: error.message, detail: [] });
  }
  const folders = [...values.projects, ...values.root];
  if (folders.length)
    checks.push(
      staleWorktreeCheck(
        collectWorktrees(
          folders,
          Date.now() + seconds * 1000,
          values["dev-container"]
            ? { docker: values.docker, container: values["dev-container"] }
            : null,
          { inspectFiles: values["inspect-worktree-files"] },
        ),
        { now: Date.now(), staleHours },
      ),
    );
  if (values.precious.length)
    checks.push(
      backupCoverageCheck({ latest: latestBackup(), contains: backupContains }, values.precious),
    );
  console.log(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      status: worst(checks.map((check) => check.status)),
      checks,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
