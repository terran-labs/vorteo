#!/usr/bin/env node
// Re-applies Time Machine exclusions to known regenerable folders, without crawling.
//
//   node scripts/maintenance/time-machine-exclusions.mjs \
//     [--root <path>]...         a whole regenerable folder or file, such as releases or a disk image
//     [--checkout <folder>]...   one Git checkout: ignored, untracked node_modules, dist, build
//     [--projects <folder>]...   every checkout directly inside, such as the Projects folder
//     [--worktrees <folder>]...  every task worktree at <folder>/<repository>/<name>
//
// Hourly upkeep runs it so folders rebuilt since the last run are marked again. It only adds
// exclusions; it never removes one and never deletes files. Prints one JSON summary line, even
// after an error, and exits 1 when a path could not be marked or a checkout could not be read.
import { parseArgs } from "node:util";
import {
  checkoutRegenerables,
  checkoutsUnder,
  excludeFromTimeMachine,
} from "../lib/time-machine-exclusions.mjs";

const { values } = parseArgs({
  options: {
    root: { type: "string", multiple: true, default: [] },
    checkout: { type: "string", multiple: true, default: [] },
    projects: { type: "string", multiple: true, default: [] },
    worktrees: { type: "string", multiple: true, default: [] },
  },
});

const result = { checkouts: 0, checked: 0, added: 0, failed: [], errors: [] };
try {
  const checkouts = [
    ...values.checkout,
    ...values.projects.flatMap((folder) => checkoutsUnder(folder, 1)),
    ...values.worktrees.flatMap((folder) => checkoutsUnder(folder, 2)),
  ];
  const folders = [...values.root];
  for (const checkout of checkouts) {
    // One unreadable checkout never stops the others.
    try {
      folders.push(...checkoutRegenerables(checkout));
      result.checkouts++;
    } catch (error) {
      result.errors.push(`${checkout}: ${error.message}`);
    }
  }
  const marked = excludeFromTimeMachine(folders);
  Object.assign(result, { checked: marked.checked, added: marked.added, failed: marked.failed });
} catch (error) {
  result.errors.push(error.message);
} finally {
  console.log(JSON.stringify(result));
}
process.exitCode = result.failed.length || result.errors.length ? 1 : 0;
