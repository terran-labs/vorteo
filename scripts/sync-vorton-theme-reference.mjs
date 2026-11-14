#!/usr/bin/env node
// Copies Vorton's generated theme reference into Vorteo and records where it came from.
//
// Vorton authors the six shared themes (Starship, Dark Star, Scriptorium, Midas, Ember and
// Neon) and generates web/design/theme-reference.json from its stylesheet. Vorton has no Git
// remote, so Vorteo vendors the file from a local checkout instead of fetching it. The drift
// test in packages/app/src/styles/theme.test.ts checks the copy against the recorded hash and
// compares Vorteo's palettes against it. Freed vendors the same file with a script of the same
// name.
//
// Usage:
//   node scripts/sync-vorton-theme-reference.mjs --from <vorton-checkout> [--rev <commit-ish>]
//
// --rev defaults to HEAD of the checkout. The file is read from the commit with `git show`, so
// a dirty working tree in Vorton never leaks into Vorteo.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const REFERENCE_PATH = "web/design/theme-reference.json";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_TARGET_DIR = path.join(REPO_ROOT, "packages/app/src/styles");
export const REFERENCE_FILE = "vorton-theme-reference.json";
export const SOURCE_FILE = "vorton-theme-reference.source.json";
export const REQUIRED_THEMES = [
  "starship-light",
  "starship-dark",
  "scriptorium",
  "midas",
  "ember",
  "neon",
];

export function parseArgs(argv) {
  const options = { from: null, rev: "HEAD", to: DEFAULT_TARGET_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--from" || arg === "--rev" || arg === "--to") {
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.from) throw new Error("--from <vorton-checkout> is required.");
  return options;
}

/** Fails closed on anything that is not a schema 1 reference with all six themes. */
export function validateReference(text) {
  let reference;
  try {
    reference = JSON.parse(text);
  } catch (error) {
    throw new Error(`${REFERENCE_PATH} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (reference?.schema !== 1) {
    throw new Error(`Unsupported theme reference schema: ${reference?.schema}`);
  }
  for (const theme of REQUIRED_THEMES) {
    const entry = reference.themes?.[theme];
    if (!entry?.roles || !entry?.palette) throw new Error(`Theme reference is missing ${theme}.`);
  }
  return reference;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function syncReference({ from, rev, to }) {
  const git = (...args) =>
    execFileSync("git", ["-C", from, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const commit = git("rev-parse", "--verify", `${rev}^{commit}`).trim();
  const text = git("show", `${commit}:${REFERENCE_PATH}`);
  validateReference(text);
  const record = { source: "vorton", path: REFERENCE_PATH, commit, sha256: sha256(text) };
  mkdirSync(to, { recursive: true });
  writeFileSync(path.join(to, REFERENCE_FILE), text);
  writeFileSync(path.join(to, SOURCE_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (isMainModule(import.meta.url)) {
  try {
    const record = syncReference(parseArgs(process.argv.slice(2)));
    console.log(
      `Vendored Vorton theme reference ${record.commit.slice(0, 12)} (sha256 ${record.sha256.slice(0, 12)}).`,
    );
    console.log(
      "Run npx vitest run packages/app/src/styles/theme.test.ts next: it names every Vorteo value the new reference changes.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
