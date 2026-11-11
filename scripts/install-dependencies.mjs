#!/usr/bin/env node
// Install this checkout's dependencies, cloning a cached install when possible.
// Usage: node scripts/install-dependencies.mjs [--mode worktree|build] [--queue]
// --queue makes a full install wait for the heavy-job slot; agent workspace setup uses it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultDependencyCache, installDependencies } from "./lib/dependency-cache.mjs";
import { checkoutRegenerables, excludeFromTimeMachine } from "./lib/time-machine-exclusions.mjs";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "worktree" },
    queue: { type: "boolean", default: false },
  },
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
installDependencies({ root, mode: values.mode, queue: values.queue });
// Keep the new dependency and build folders out of Time Machine; the source stays backed up.
// A failure only costs backup space, so it never fails the install.
try {
  const { failed } = excludeFromTimeMachine([
    defaultDependencyCache(),
    ...checkoutRegenerables(root),
  ]);
  if (failed.length) console.log(`Time Machine exclusion failed for ${failed.join(", ")}`);
} catch (error) {
  console.log(`Time Machine exclusions skipped: ${error.message}`);
}
