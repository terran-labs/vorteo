#!/usr/bin/env node
// Read-only Host checks for hourly upkeep: file-table pressure, stale task worktrees and
// Time Machine coverage of the precious folders. It changes nothing, prints one JSON report
// and exits 0; the caller decides how to alert. Git runs without optional locks, so it never
// takes a worktree's index.lock or rewrites its index. See
// docs/execution-installation.md#host-watch.
//
//   node scripts/maintenance/host-watch.mjs \
//     [--dev-container <name>] [--docker <path>]   read Dev's cached shared-folder inodes
//     [--projects <folder>]... [--root <folder>]...  repositories whose worktrees to check
//     [--precious <path>]...                         paths the latest backup must contain
//     [--stale-hours 24] [--worktree-seconds 120]  staleness window, worktree pass deadline
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
export function staleWorktreeCheck({ worktrees, skipped = 0 }, { now, staleHours }) {
  const stale = worktrees.filter(
    (worktree) =>
      (worktree.dirty || worktree.unpushed > 0 || worktree.noRemote) &&
      now - worktree.lastActivity > staleHours * 3_600_000,
  );
  const parts = [];
  if (stale.length)
    parts.push(
      `${stale.length} worktrees hold uncommitted or unpushed work older than ${staleHours} hours`,
    );
  if (skipped) parts.push(`${skipped} worktrees not checked before the deadline`);
  let status = "ok";
  if (stale.length) status = "warn";
  else if (skipped) status = "unknown";
  return {
    id: "stale-worktrees",
    status,
    summary: parts.length
      ? parts.join("; ")
      : `No uncommitted or unpushed work older than ${staleHours} hours in ${worktrees.length} worktrees`,
    detail: stale.map(({ path: location, dirty, unpushed, noRemote }) => ({
      path: location,
      dirty,
      ...(noRemote ? { noRemote } : { unpushed }),
    })),
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
    // Never refresh an index or take index.lock in someone else's worktree.
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

function git(cwd, args) {
  return run("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args]).trim();
}

/** Linked worktrees visible here, once per repository, until the deadline passes. */
function collectWorktrees(repositories, deadline) {
  const seen = new Set();
  const found = [];
  let skipped = 0;
  for (const repository of repositories) {
    let common;
    let listing;
    try {
      common = path.resolve(repository, git(repository, ["rev-parse", "--git-common-dir"]));
      listing = git(repository, ["worktree", "list", "--porcelain"]);
    } catch {
      continue;
    }
    if (seen.has(common)) continue;
    seen.add(common);
    const paths = listing
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .slice(1)
      .filter((location) => fs.existsSync(location));
    for (const location of paths) {
      if (Date.now() > deadline) {
        skipped++;
        continue;
      }
      try {
        const gitDir = path.resolve(location, git(location, ["rev-parse", "--git-dir"]));
        const index = path.join(gitDir, "index");
        // Read before any other git call, so the check never moves the activity clock.
        const lastActivity = fs.statSync(fs.existsSync(index) ? index : gitDir).mtimeMs;
        const noRemote = git(location, ["remote"]) === "";
        found.push({
          path: location,
          lastActivity,
          dirty: git(location, ["status", "--porcelain"]) !== "",
          noRemote,
          unpushed: noRemote
            ? 0
            : Number(git(location, ["rev-list", "--count", "HEAD", "--not", "--remotes"])),
        });
      } catch {
        skipped++;
      }
    }
  }
  return { worktrees: found, skipped };
}

function repositoriesIn(folder) {
  try {
    return fs
      .readdirSync(folder)
      .map((name) => path.join(folder, name))
      .filter((child) => fs.existsSync(path.join(child, ".git")));
  } catch {
    return [];
  }
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

/** Holds `file` for this run; false while another live run holds it. */
function takeLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      process.on("exit", () => fs.rmSync(file, { force: true }));
      return true;
    } catch {
      const holder = Number(fs.readFileSync(file, "utf8"));
      try {
        process.kill(holder, 0);
        return false;
      } catch {
        // The holder exited without releasing it.
        fs.rmSync(file, { force: true });
      }
    }
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
      lock: { type: "string" },
    },
  });
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
  const repositories = [
    ...values.projects.flatMap(repositoriesIn),
    ...values.root.flatMap(repositoriesIn),
  ];
  if (repositories.length)
    checks.push(
      staleWorktreeCheck(
        collectWorktrees(repositories, Date.now() + Number(values["worktree-seconds"]) * 1000),
        { now: Date.now(), staleHours: Number(values["stale-hours"]) },
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
