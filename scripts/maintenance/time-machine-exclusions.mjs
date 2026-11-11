#!/usr/bin/env node
// Re-applies Time Machine exclusions to known regenerable folders, without crawling.
//
//   node scripts/maintenance/time-machine-exclusions.mjs \
//     [--root <path>]...         a whole regenerable folder or file, such as releases or a disk image
//     [--checkout <folder>]...   one checkout: its node_modules and workspace dist and build
//     [--projects <folder>]...   every checkout directly inside, such as the Projects folder
//     [--worktrees <folder>]...  every task worktree at <folder>/<repository>/<name>
//
// Hourly upkeep runs it so folders rebuilt since the last run are marked again. It only adds
// exclusions; it never removes one and never deletes files. Prints one JSON summary line and
// exits 1 when a folder could not be marked.
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

const checkouts = [
  ...values.checkout,
  ...values.projects.flatMap((folder) => checkoutsUnder(folder, 1)),
  ...values.worktrees.flatMap((folder) => checkoutsUnder(folder, 2)),
];
const folders = [
  ...values.root,
  ...checkouts.flatMap((checkout) => checkoutRegenerables(checkout)),
];
const result = excludeFromTimeMachine(folders);
console.log(
  JSON.stringify({
    checkouts: checkouts.length,
    checked: result.checked,
    added: result.added,
    failed: result.failed,
  }),
);
process.exitCode = result.failed.length ? 1 : 0;
