"use strict";
// Chooses the daemon Dev starts. The Host builds Dev releases (docker build --target
// dev-release) into the deployment's dev-releases folder and mounts it read-only at
// RELEASE_ROOT; `current` names the selected one. A release runs only when its receipt
// matches its folder and this image's Node ABI and architecture. Anything else falls
// back to the daemon baked into the image, so first installs, older deployments without
// the mount and a Node change in a new image keep working.
// CLI: prints the entry, then the release's bin folder (empty for the baked daemon).
const fs = require("node:fs");
const path = require("node:path");

const RELEASE_ROOT = "/opt/vorteo/dev-releases";
const BAKED_POINTER = "/etc/paseo-server-entry";
const RECEIPT = ".vorteo-dev-release.json";
const ENTRY = "lib/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js";
const COMMIT = /^[a-f0-9]{40}$/;

function baked(pointer, reason) {
  return { entry: fs.readFileSync(pointer, "utf8").trim(), bin: "", release: null, reason };
}

function resolveServerEntry({
  root = RELEASE_ROOT,
  pointer = BAKED_POINTER,
  modules = process.versions.modules,
  arch = process.arch,
} = {}) {
  const link = path.join(root, "current");
  try {
    fs.lstatSync(link);
  } catch {
    return baked(pointer, "no Dev release is selected");
  }
  try {
    const canonicalRoot = fs.realpathSync(root);
    const release = fs.realpathSync(link);
    const name = path.basename(release);
    if (path.dirname(release) !== canonicalRoot || !COMMIT.test(name))
      throw new Error("current does not name a release folder");
    const receipt = JSON.parse(fs.readFileSync(path.join(release, RECEIPT), "utf8"));
    if (receipt.format !== 1 || receipt.sourceCommit !== name)
      throw new Error("its receipt does not match its folder");
    if (receipt.modules !== modules || receipt.arch !== arch)
      throw new Error(
        `it was built for Node ABI ${receipt.modules} on ${receipt.arch}, not ${modules} on ${arch}`,
      );
    const entry = path.join(release, ENTRY);
    if (!fs.statSync(entry).isFile()) throw new Error("its entry is missing");
    return { entry, bin: path.join(release, "bin"), release: name, reason: null };
  } catch (error) {
    return baked(pointer, `the selected Dev release is unusable: ${error.message}`);
  }
}

module.exports = { resolveServerEntry, RELEASE_ROOT, RECEIPT, ENTRY };

if (require.main === module) {
  const choice = resolveServerEntry();
  process.stderr.write(
    choice.release
      ? `[paseo] running Dev release ${choice.release}\n`
      : `[paseo] running the image's daemon: ${choice.reason}\n`,
  );
  process.stdout.write(`${choice.entry}\n${choice.bin}\n`);
}
