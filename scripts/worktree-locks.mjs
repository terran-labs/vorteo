#!/usr/bin/env node
// Locks existing Vorteo task worktrees so a `git worktree prune` run from an environment that
// cannot see their folders, such as Dev for a Host worktree, keeps their metadata (#295).
// New Vorteo worktrees are locked when they are created; this covers older ones.
//
//   node scripts/worktree-locks.mjs [--repo <checkout>]... [--projects <folder>]... [--apply]
//
// --projects takes every Git checkout directly inside the folder. A worktree qualifies when its
// path lies under a `.vorteo/worktrees` or `.paseo/worktrees` folder and it is not locked yet;
// its folder may be missing here. Without --apply this is a dry run. It only adds locks, prints
// one JSON summary line and exits 1 when a lock failed.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { VORTEO_WORKTREE_LOCK_REASON, git, listWorktrees } from "./lib/delivery-git.mjs";

const { values } = parseArgs({
  options: {
    repo: { type: "string", multiple: true, default: [] },
    projects: { type: "string", multiple: true, default: [] },
    apply: { type: "boolean", default: false },
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
const repos = [...values.repo, ...values.projects.flatMap(checkoutsIn)];
const result = { apply: values.apply, repositories: 0, locked: [], alreadyLocked: 0, failed: [] };
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
  for (const worktree of worktrees.slice(1)) {
    if (!OWNED.test(`${worktree.path}/`)) continue;
    if (worktree.locked) {
      result.alreadyLocked++;
      continue;
    }
    if (!values.apply) {
      result.locked.push(worktree.path);
      continue;
    }
    try {
      git(repo, ["worktree", "lock", "--reason", VORTEO_WORKTREE_LOCK_REASON, worktree.path]);
      result.locked.push(worktree.path);
    } catch (error) {
      result.failed.push(`${worktree.path}: ${error.message.split("\n")[0]}`);
    }
  }
}
console.log(JSON.stringify(result));
process.exitCode = result.failed.length ? 1 : 0;
