// Keeps regenerable folders out of Time Machine without crawling the disk.
//
// Each folder gets Time Machine's sticky exclusion, the attribute `tmutil addexclusion` writes
// without `-p`. It excludes the folder and everything below it, needs no administrator rights
// and stays with the folder until the folder is deleted. Only known paths are marked: fixed
// regenerable roots, and in each checkout its root `node_modules` plus each workspace's
// `node_modules`, `dist` and `build`. Source is never marked, and nothing is ever deleted.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const EXCLUDE_ATTRIBUTE = "com.apple.metadata:com_apple_backup_excludeItem";
// Binary plist holding the string "com.apple.backupd", byte for byte what tmutil writes.
const EXCLUDE_VALUE =
  "62706c69737430305f1011636f6d2e6170706c652e6261636b75706408000000000000010100000000000000010000000000000000000000000000001c";

/** Workspace folder names whose contents are always rebuilt or reinstalled. */
export const REGENERABLE_CHILDREN = ["node_modules", "dist", "build"];

function defaultRun(command, args) {
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "ignore"] });
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

/** A real folder, not a link that could lead outside the tree being marked. */
function isFolder(file) {
  try {
    return fs.lstatSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** The workspace folders a checkout's package.json names; `dir/*` expands one level. */
export function checkoutWorkspaces(checkout) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  const folders = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.includes("..")) continue;
    if (pattern.endsWith("/*")) {
      const parent = path.join(checkout, pattern.slice(0, -2));
      if (!isFolder(parent)) continue;
      for (const name of fs.readdirSync(parent)) {
        if (isFolder(path.join(parent, name))) folders.push(path.join(parent, name));
      }
    } else if (!pattern.includes("*") && isFolder(path.join(checkout, pattern))) {
      folders.push(path.join(checkout, pattern));
    }
  }
  return folders;
}

/** Existing regenerable folders of one checkout: never the checkout or any source folder. */
export function checkoutRegenerables(checkout) {
  const found = [];
  const root = path.join(checkout, "node_modules");
  if (isFolder(root)) found.push(root);
  for (const workspace of checkoutWorkspaces(checkout)) {
    for (const child of REGENERABLE_CHILDREN) {
      const folder = path.join(workspace, child);
      if (isFolder(folder)) found.push(folder);
    }
  }
  return found;
}

/** Checkouts directly inside `folder` (depth 1) or one level further (depth 2). Reads names only. */
export function checkoutsUnder(folder, depth = 1) {
  if (!isFolder(folder)) return [];
  const checkouts = [];
  for (const name of fs.readdirSync(folder)) {
    if (name.startsWith(".")) continue;
    const child = path.join(folder, name);
    if (!isFolder(child)) continue;
    if (depth > 1) checkouts.push(...checkoutsUnder(child, depth - 1));
    else if (fs.existsSync(path.join(child, "package.json"))) checkouts.push(child);
  }
  return checkouts;
}

/**
 * Adds the sticky exclusion to each existing folder, or file such as a disk image, that lacks
 * it. Links are skipped. Off macOS this does nothing. Returns the counts and the folders that could not be marked.
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
      run("/usr/bin/xattr", ["-p", EXCLUDE_ATTRIBUTE, folder]);
      continue;
    } catch {
      // Not marked yet.
    }
    try {
      run("/usr/bin/xattr", ["-wx", EXCLUDE_ATTRIBUTE, EXCLUDE_VALUE, folder]);
      result.added++;
    } catch {
      result.failed.push(folder);
    }
  }
  return result;
}
