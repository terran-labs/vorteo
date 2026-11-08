#!/usr/bin/env node
// Install this checkout's dependencies, cloning a cached install when possible.
// Usage: node scripts/install-dependencies.mjs [--mode worktree|build] [--queue]
// --queue makes a full install wait for the heavy-job slot; agent workspace setup uses it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { installDependencies } from "./lib/dependency-cache.mjs";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "worktree" },
    queue: { type: "boolean", default: false },
  },
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
installDependencies({ root, mode: values.mode, queue: values.queue });
