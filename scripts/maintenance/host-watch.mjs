#!/usr/bin/env node
// Read-only Host checks for hourly upkeep: file-table pressure, stale task worktrees and
// Time Machine coverage of the precious folders. It changes nothing, prints one JSON report
// and exits 0; the caller decides how to alert. See
// docs/execution-installation.md#host-watch.
//
//   node scripts/maintenance/host-watch.mjs \
//     [--dev-container <name>] [--docker <path>]   read Dev's cached shared-folder inodes
//     [--projects <folder>]... [--root <folder>]...  repositories whose worktrees to check
//     [--precious <path>]...                         paths the latest backup must contain
//     [--stale-hours 24]
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
  if (!limit) return "unknown";
  const share = used / limit;
  if (share >= THRESHOLDS.critical) return "critical";
  return share >= THRESHOLDS.warn ? "warn" : "ok";
}

const percent = (used, limit) => `${Math.round((used / limit) * 100)}%`;

/**
 * File-table pressure. Each file the Docker VM caches from a shared folder pins one Host file
 * handle in the VM process until the VM evicts it, so the VM can exhaust its per-process limit
 * and then the Mac's file table. Dev's cached shared-folder inodes (`fuse_inode` slab objects)
 * lead that count; they are reported against the system limit.
 */
export function fileTableCheck({ maxFiles, maxFilesPerProc, openFiles, vmOpenFiles, fuseInodes }) {
  const parts = [
    { name: "system", status: level(openFiles, maxFiles), used: openFiles, limit: maxFiles },
  ];
  if (vmOpenFiles !== null)
    parts.push({
      name: "Docker VM",
      status: level(vmOpenFiles, maxFilesPerProc),
      used: vmOpenFiles,
      limit: maxFilesPerProc,
    });
  if (fuseInodes !== null)
    parts.push({
      name: "Dev cached shared-folder inodes",
      status: level(fuseInodes, maxFiles),
      used: fuseInodes,
      limit: maxFiles,
    });
  return {
    id: "file-table",
    status: worst(parts.map((part) => part.status)),
    summary: parts
      .map(
        (part) => `${part.name} ${part.used} of ${part.limit} (${percent(part.used, part.limit)})`,
      )
      .join("; "),
    detail: parts,
  };
}

/** Worktrees with uncommitted or unpushed work untouched for longer than the window. */
export function staleWorktreeCheck(worktrees, { now, staleHours }) {
  const stale = worktrees.filter(
    (worktree) =>
      (worktree.dirty || worktree.unpushed > 0) &&
      now - worktree.lastActivity > staleHours * 3_600_000,
  );
  return {
    id: "stale-worktrees",
    status: stale.length ? "warn" : "ok",
    summary: stale.length
      ? `${stale.length} worktrees hold uncommitted or unpushed work older than ${staleHours} hours`
      : `No uncommitted or unpushed work older than ${staleHours} hours in ${worktrees.length} worktrees`,
    detail: stale.map(({ path: location, dirty, unpushed }) => ({
      path: location,
      dirty,
      unpushed,
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

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
}

function sysctl(name) {
  return Number(run("/usr/sbin/sysctl", ["-n", name]).trim());
}

/** Open files of the Docker Desktop VM process with the most, or null without one. */
function dockerVmOpenFiles() {
  let pids;
  try {
    pids = run("/usr/bin/pgrep", ["-f", "com.apple.Virtualization.VirtualMachine"]).split("\n");
  } catch {
    return null;
  }
  let most = null;
  for (const pid of pids.filter(Boolean)) {
    try {
      // One line per open file after the header.
      const count = run("/usr/sbin/lsof", ["-n", "-P", "-p", pid]).split("\n").length - 2;
      most = Math.max(most ?? 0, count);
    } catch {
      // The process ended or cannot be read.
    }
  }
  return most;
}

/** Active `fuse_inode` slab objects in Dev's VM, read through the Dev container, or null. */
export function parseFuseInodes(slabinfo) {
  const line = slabinfo.split("\n").find((row) => row.startsWith("fuse_inode "));
  const active = line ? Number(line.split(/\s+/)[1]) : NaN;
  return Number.isFinite(active) ? active : null;
}

function devFuseInodes(docker, container) {
  if (!docker || !container) return null;
  try {
    return parseFuseInodes(run(docker, ["exec", "-u", "0", container, "cat", "/proc/slabinfo"]));
  } catch {
    return null;
  }
}

function git(cwd, args) {
  return run("git", ["-C", cwd, ...args]).trim();
}

/** Linked worktrees visible here, once per repository, with their state. */
function collectWorktrees(repositories) {
  const seen = new Set();
  const worktrees = [];
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
      .slice(1);
    for (const location of paths) {
      if (!fs.existsSync(location)) continue;
      try {
        const gitDir = path.resolve(location, git(location, ["rev-parse", "--git-dir"]));
        const index = path.join(gitDir, "index");
        worktrees.push({
          path: location,
          dirty: git(location, ["status", "--porcelain"]) !== "",
          unpushed: Number(git(location, ["rev-list", "--count", "HEAD", "--not", "--remotes"])),
          lastActivity: fs.statSync(fs.existsSync(index) ? index : gitDir).mtimeMs,
        });
      } catch {
        // A broken worktree is left to the cleanup tools.
      }
    }
  }
  return worktrees;
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

/** The latest completed backup, and whether a Host path exists inside one of its volumes. */
function latestBackup() {
  try {
    const latest = run("/usr/bin/tmutil", ["latestbackup"]).trim();
    return latest && fs.existsSync(latest) ? latest : null;
  } catch {
    return null;
  }
}

function backupContains(latest, item) {
  let volumes;
  try {
    volumes = fs.readdirSync(latest);
  } catch {
    return false;
  }
  return volumes.some((volume) => fs.existsSync(path.join(latest, volume, item)));
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
    },
  });
  const checks = [];
  try {
    checks.push(
      fileTableCheck({
        maxFiles: sysctl("kern.maxfiles"),
        maxFilesPerProc: sysctl("kern.maxfilesperproc"),
        openFiles: sysctl("kern.num_files"),
        vmOpenFiles: dockerVmOpenFiles(),
        fuseInodes: devFuseInodes(values.docker, values["dev-container"]),
      }),
    );
  } catch (error) {
    checks.push({ id: "file-table", status: "unknown", summary: error.message, detail: [] });
  }
  const repositories = [
    ...values.projects.flatMap(repositoriesIn),
    ...values.root.flatMap(repositoriesIn),
  ];
  checks.push(
    staleWorktreeCheck(collectWorktrees(repositories), {
      now: Date.now(),
      staleHours: Number(values["stale-hours"]),
    }),
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
