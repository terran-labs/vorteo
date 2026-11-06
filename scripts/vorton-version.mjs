// Commit-time version and changelog checks (docs/release.md, "Vorteo versions").
// Commits no longer change the version: `node scripts/vorteo-release.mjs prepare` sets the
// next calendar version for a release. This script keeps every manifest and the lockfile
// on the root version and requires release notes for every commit: a new or changed change
// fragment (scripts/lib/change-fragments.mjs), or, for a release preparation, its
// VORTEO_CHANGELOG.md entry.
//
//   (no flag)  Synchronize manifests to the root version.
//   --hook     Pre-commit: validate, synchronize and stage the manifests.
//   --check    Validate the index without writing anything.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  UNRELEASED,
  compareVersions,
  manifestFiles,
  parseVersion,
  synchronizedManifests,
  versionAt,
} from "./vorteo-version.mjs";
import { FRAGMENT_DIRECTORY, parseFragment } from "./lib/change-fragments.mjs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const mode = process.argv[2] ?? "--sync";
if (!["--sync", "--hook", "--check"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
const root = JSON.parse(readFileSync("package.json", "utf8"));
const version = parseVersion(root.version).version;
const parents = [versionAt(".", "HEAD")];
const mergeHeadPath = git("rev-parse", "--git-path", "MERGE_HEAD");
if (existsSync(mergeHeadPath)) {
  for (const head of readFileSync(mergeHeadPath, "utf8").trim().split(/\s+/)) {
    parents.push(versionAt(".", head));
  }
}
// Only additional merge parents may use Paseo's 0.x stable/beta namespace.
// HEAD and the current root must remain on Vorteo's version line.
const upstreamVersion = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
for (const [index, parent] of parents.entries()) {
  const upstreamParent =
    index > 0 && typeof parent === "string" && upstreamVersion.exec(parent)?.[0] === parent;
  if (upstreamParent) continue;
  if (parent !== null && compareVersions(version, parent) < 0) {
    throw new Error(`The version cannot go below a parent's: ${version} < ${parent}.`);
  }
}
// A commit that introduces a version is its release preparation; every other commit's
// entry waits as Unreleased until the next one.
const label = parents.every((parent) => parent !== version) ? version : UNRELEASED;
if (mode === "--hook" || mode === "--check") {
  const changelog = "VORTEO_CHANGELOG.md";
  const changed = git("diff", "--cached", "--name-only", "HEAD", "--", changelog);
  // New or changed fragments; deletions are release preparation folding them in.
  const fragments = git(
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    "--diff-filter=AM",
    "HEAD",
    "--",
    FRAGMENT_DIRECTORY,
  )
    .split("\n")
    .filter(Boolean);
  for (const file of fragments) parseFragment(file, git("show", `:${file}`));
  if (label !== UNRELEASED && fragments.length) {
    throw new Error(
      `A release preparation folds change fragments into ${changelog}; do not add one (${fragments.join(", ")}).`,
    );
  }
  // A fragment carries an ordinary commit's notes, so a changelog changed by merging main
  // (whose top may be a release entry) is not checked as this commit's entry.
  if (changed && !(label === UNRELEASED && fragments.length)) {
    const staged = git("show", `:${changelog}`);
    const [, latest = ""] = staged.split(/^## /m);
    const [heading, ...body] = latest.split(/\r?\n/);
    const match = /^(\S+) - (\d{4}-\d{2}-\d{2})$/.exec(heading);
    if (!match || match[1] !== label || !/^- \S/m.test(body.join("\n"))) {
      throw new Error(`Stage a nonempty top ${changelog} entry headed "## ${label} - YYYY-MM-DD".`);
    }
  } else if (label !== UNRELEASED) {
    throw new Error(`A release preparation stages its ${changelog} entry (## ${label}).`);
  } else if (!fragments.length) {
    throw new Error(
      `Every commit adds a change fragment, ${FRAGMENT_DIRECTORY}/YYYY-MM-DD-<slug>.md (docs/release.md#change-fragments).`,
    );
  }
}
const manifests = synchronizedManifests(".", version);
const files = manifestFiles(root);
// A hook must never stage unrelated working-tree edits in these files.
if (mode === "--hook") {
  git("ls-files", "--error-unmatch", "--", ...files);
  const dirty = git("diff", "--name-only", "--", ...files);
  if (dirty) throw new Error(`Stage or stash manifest changes before committing:\n${dirty}`);
}
if (mode === "--check") {
  for (const [file, expected] of manifests) {
    const staged = JSON.parse(git("show", `:${file}`));
    if (JSON.stringify(staged) !== JSON.stringify(expected))
      throw new Error(`Stage synchronized version ${version}: ${file}`);
  }
} else {
  for (const [file, pkg] of manifests) writeJson(file, pkg);
  if (mode === "--hook") git("add", "--", ...files);
}
console.log(`Vorteo version: ${version}`);
