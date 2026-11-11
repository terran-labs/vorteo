#!/usr/bin/env node
// Locks existing Vorteo task worktrees so a `git worktree prune` run from an environment that
// cannot see their folders, such as Dev for a Host worktree, keeps their metadata (#295).
// New Vorteo worktrees are locked when they are created; this covers older ones.
//
//   node scripts/worktree-locks.mjs [--repo <checkout>]... [--projects <folder>]...
//     [--root <folder>]... [--apply] [--unlock]
//
// --projects takes every Git checkout directly inside the folder. A linked worktree qualifies
// when its path lies under a `.vorteo/worktrees` or `.paseo/worktrees` folder, follows the task
// worktree layout `<parent of the checkout>/<checkout name>-<slug>` (scripts/task-worktree.mjs),
// or lies under a --root folder, such as installation or Factory worktree folders. Its folder
// may be missing here. Without --apply this is a dry run. It only adds locks, prints one JSON
// summary line and exits 1 when a lock failed.
//
// --unlock removes only locks with Vorteo's reason, and none other. Run it with --apply before
// downgrading either daemon to a release older than the locks: an older daemon removes a
// worktree with a single --force, which a lock refuses.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { VORTEO_WORKTREE_LOCK_REASON, git, listWorktrees } from "./lib/delivery-git.mjs";

const { values } = parseArgs({
  options: {
    repo: { type: "string", multiple: true, default: [] },
    projects: { type: "string", multiple: true, default: [] },
    root: { type: "string", multiple: true, default: [] },
    apply: { type: "boolean", default: false },
    unlock: { type: "boolean", default: false },
  },
});

function checkoutsIn(folder) {
  try {
    return fs
      .readdirSync(folder)
      .map((name) => path.join(folder, name))
      .filter((child) => fs.existsSync(path.join(child, ".git")));
  } catch {
    return [];
  }
}

const OWNED = /\/\.(vorteo|paseo)\/worktrees\//;
const roots = values.root.map((root) => {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
});

/**
 * Whether a linked worktree of `primary` is in a Vorteo worktree layout. A hand-made sibling
 * named `<checkout>-<anything>` matches too; its lock only keeps prunes away.
 */
function isVorteoWorktree(primary, worktreePath) {
  if (OWNED.test(`${worktreePath}/`)) return true;
  if (roots.some((root) => worktreePath.startsWith(`${root}/`))) return true;
  return (
    path.dirname(worktreePath) === path.dirname(primary) &&
    path.basename(worktreePath).startsWith(`${path.basename(primary)}-`)
  );
}

const repos = [...values.repo, ...values.projects.flatMap(checkoutsIn)];
const result = {
  apply: values.apply,
  mode: values.unlock ? "unlock" : "lock",
  repositories: 0,
  changed: [],
  skipped: 0,
  failed: [],
};
const seen = new Set();
for (const repo of repos) {
  let worktrees;
  try {
    worktrees = listWorktrees(repo);
  } catch {
    continue;
  }
  // Linked worktrees of one repository appear once, whichever checkout lists them.
  const common = path.resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]));
  if (seen.has(common)) continue;
  seen.add(common);
  result.repositories++;
  const primary = worktrees[0]?.path;
  for (const worktree of worktrees.slice(1)) {
    const wanted = values.unlock
      ? worktree.locked && worktree.lockReason === VORTEO_WORKTREE_LOCK_REASON
      : !worktree.locked && isVorteoWorktree(primary, worktree.path);
    if (!wanted) {
      result.skipped++;
      continue;
    }
    if (!values.apply) {
      result.changed.push(worktree.path);
      continue;
    }
    try {
      git(
        repo,
        values.unlock
          ? ["worktree", "unlock", worktree.path]
          : ["worktree", "lock", "--reason", VORTEO_WORKTREE_LOCK_REASON, worktree.path],
      );
      result.changed.push(worktree.path);
    } catch (error) {
      result.failed.push(`${worktree.path}: ${error.message.split("\n")[0]}`);
    }
  }
}
console.log(JSON.stringify(result));
process.exitCode = result.failed.length ? 1 : 0;
