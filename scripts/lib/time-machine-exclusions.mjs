// Keeps regenerable folders out of Time Machine without crawling the disk.
//
// Each folder gets Time Machine's sticky exclusion, the attribute `tmutil addexclusion` writes
// without `-p`. It excludes the folder and everything below it, needs no administrator rights
// and stays with the folder until the folder is deleted. Only named paths are marked: fixed
// regenerable roots, and in each Git checkout its root `node_modules` plus each workspace
// package's `node_modules`, `dist` and `build`. A checkout folder is marked only when Git
// tracks nothing inside it and ignores it, so source is never excluded. Nothing is deleted.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const EXCLUDE_ATTRIBUTE = "com.apple.metadata:com_apple_backup_excludeItem";
// Binary plist holding the string "com.apple.backupd", byte for byte what tmutil writes.
const EXCLUDE_VALUE =
  "62706c69737430305f1011636f6d2e6170706c652e6261636b75706408000000000000010100000000000000010000000000000000000000000000001c";

/** Workspace folder names whose contents are always rebuilt or reinstalled. */
export const REGENERABLE_CHILDREN = ["node_modules", "dist", "build"];

function defaultRun(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/** An existing file or folder that is not a link, which could lead outside the tree. */
function isMarkable(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

/** A real folder whose name matches exactly, even on a case-insensitive volume. */
function hasFolder(parent, name) {
  try {
    return (
      fs.readdirSync(parent).includes(name) && fs.lstatSync(path.join(parent, name)).isDirectory()
    );
  } catch {
    return false;
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Workspace package folders a checkout's package.json names. A plain name or `dir/*` (one
 * level) is accepted; `!` patterns remove matches. Each folder must lie strictly inside the
 * checkout and have its own package.json, so `.`, `./*` and `..` never reach the root.
 */
export function checkoutWorkspaces(checkout) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8"));
  } catch {
    return [];
  }
  if (!manifest || typeof manifest !== "object") return [];
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  if (!Array.isArray(patterns)) return [];
  const expand = (pattern) => {
    if (pattern.endsWith("/*")) {
      const parent = path.resolve(checkout, pattern.slice(0, -2));
      try {
        return fs.readdirSync(parent).map((name) => path.join(parent, name));
      } catch {
        return [];
      }
    }
    return pattern.includes("*") ? [] : [path.resolve(checkout, pattern)];
  };
  const included = new Set();
  const excluded = new Set();
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const negated = pattern.startsWith("!");
    for (const folder of expand(negated ? pattern.slice(1) : pattern)) {
      (negated ? excluded : included).add(folder);
    }
  }
  return [...included].filter((folder) => {
    if (excluded.has(folder) || !isInside(folder, checkout)) return false;
    try {
      return (
        fs.lstatSync(folder).isDirectory() &&
        fs.lstatSync(path.join(folder, "package.json")).isFile()
      );
    } catch {
      return false;
    }
  });
}

/**
 * Regenerable folders of one Git checkout. A candidate qualifies only when its real path stays
 * inside the checkout's real path, Git tracks no file inside it and Git ignores it. Without Git
 * or outside a repository nothing qualifies.
 */
export function checkoutRegenerables(checkout, { run = defaultRun } = {}) {
  const candidates = [];
  if (hasFolder(checkout, "node_modules")) candidates.push(path.join(checkout, "node_modules"));
  for (const workspace of checkoutWorkspaces(checkout)) {
    for (const child of REGENERABLE_CHILDREN) {
      if (hasFolder(workspace, child)) candidates.push(path.join(workspace, child));
    }
  }
  if (!candidates.length) return [];
  let root;
  try {
    root = fs.realpathSync(checkout);
  } catch {
    return [];
  }
  const inside = candidates.filter((candidate) => {
    try {
      return isInside(fs.realpathSync(candidate), root);
    } catch {
      return false;
    }
  });
  if (!inside.length) return [];
  const relative = inside.map((candidate) => path.relative(checkout, candidate));
  let tracked;
  let ignored;
  try {
    // One listing of tracked files under every candidate, one ignore check for all of them.
    tracked = run("git", ["-C", checkout, "ls-files", "-z", "--", ...relative]).split("\0");
  } catch {
    return [];
  }
  try {
    ignored = new Set(
      run("git", ["-C", checkout, "check-ignore", "--", ...relative.map((item) => `${item}/`)])
        .split("\n")
        .map((item) => item.replace(/\/$/, "")),
    );
  } catch {
    // Exit status 1 means nothing is ignored; anything else means Git could not answer.
    return [];
  }
  return inside.filter((_, index) => {
    const folder = relative[index];
    if (!ignored.has(folder)) return false;
    return !tracked.some((file) => file === folder || file.startsWith(`${folder}/`));
  });
}

/** Checkouts directly inside `folder` (depth 1) or one level further (depth 2). Reads names only. */
export function checkoutsUnder(folder, depth = 1) {
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const checkouts = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const child = path.join(folder, name);
    try {
      if (!fs.lstatSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    if (depth > 1) checkouts.push(...checkoutsUnder(child, depth - 1));
    else if (fs.existsSync(path.join(child, "package.json"))) checkouts.push(child);
  }
  return checkouts;
}

/**
 * Adds the sticky exclusion to each existing folder, or file such as a disk image, that lacks
 * it. Links are skipped and never followed. Off macOS this does nothing. Returns the counts and
 * the paths that could not be marked.
 */
export function excludeFromTimeMachine(
  folders,
  { platform = process.platform, run = defaultRun } = {},
) {
  const result = { checked: 0, added: 0, failed: [] };
  if (platform !== "darwin") return result;
  for (const folder of new Set(folders)) {
    if (!isMarkable(folder)) continue;
    result.checked++;
    try {
      run("/usr/bin/xattr", ["-s", "-p", EXCLUDE_ATTRIBUTE, folder]);
      continue;
    } catch {
      // Not marked yet.
    }
    try {
      run("/usr/bin/xattr", ["-s", "-wx", EXCLUDE_ATTRIBUTE, EXCLUDE_VALUE, folder]);
      result.added++;
    } catch {
      result.failed.push(folder);
    }
  }
  return result;
}
