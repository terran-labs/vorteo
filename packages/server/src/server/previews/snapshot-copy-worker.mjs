/* oxlint-disable paseo/no-sync-io -- This file is its own short-lived process, never the daemon. Synchronous calls keep each directory change and the opens that depend on it strictly in order, which the safety argument below relies on. */
// Copies a published file or directory into a snapshot, then exits.
//
// The source is agent-controlled and may be rewritten while it is copied, including by a
// party less trusted than the daemon (a shared folder a container can write). Checking a
// path and then opening it is racy however carefully it is done, because only the final
// path component can be opened without following links. This worker never opens a source
// file by a multi-component path. The directory named by the publish must be a real
// directory, not a link, and is checked again by device and inode after moving into it.
// From there the tree is walked by changing the working directory one component at a
// time: each child must be a real directory before the step, and the directory reached
// must be that same one. A component swapped for a link is refused. Files are opened by
// bare name, relative to that directory, without following links. Changing directory is
// process-wide, which is why this runs as its own short-lived process. Components above
// the named directory are resolved once, as the publishing agent wrote them.
//
// Usage: node snapshot-copy-worker.mjs <source> <destination-dir> <max-bytes> <max-files>
// Prints {"bytes":n,"entry":"name-or-empty"} on success. Exit 3 means too large, 1 refused.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const SKIPPED_NAMES = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  ".ssh",
  ".aws",
  ".gnupg",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".docker",
  ".kube",
]);
const SKIPPED_PATTERN = /^\.env|\.(pem|key|p12|pfx)$|^id_(rsa|dsa|ecdsa|ed25519)/i;

class Refused extends Error {}
class TooLarge extends Error {}

const [source, destination, maxBytesText, maxFilesText] = process.argv.slice(2);
const maxBytes = Number(maxBytesText);
const maxFiles = Number(maxFilesText);
// Budgets on everything visited, not only on file bytes, so a publish always ends.
const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 64;
let bytes = 0;
let files = 0;
let entries = 0;
const buffer = Buffer.allocUnsafe(1024 * 1024);

const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Count every entry visited, directories included, so an empty or deep tree is bounded too. */
function visit() {
  entries += 1;
  if (entries > MAX_ENTRIES) throw new TooLarge();
}

/**
 * Step into one child directory and prove the kernel put us exactly there: the name must be
 * a real directory, not a link, and the directory we land in must be that same one.
 */
function enter(name) {
  const before = process.cwd();
  const expected = lstatSync(name);
  if (!expected.isDirectory())
    throw new Refused(`Refused to copy ${path.join(before, name)}: it is not a plain directory.`);
  process.chdir(name);
  if (!sameNode(statSync("."), expected) || process.cwd() !== path.join(before, name))
    throw new Refused(`Refused to copy ${path.join(before, name)}: it is not a plain directory.`);
}

/** Step back out and prove we are in the directory we came from, even if the tree was moved. */
function leave(parent) {
  process.chdir("..");
  if (!sameNode(statSync("."), parent))
    throw new Refused("Refused to copy: the published directory moved during the copy.");
}

/**
 * Move into the directory the publish names. It must itself be a real directory: a link
 * here, or one swapped in between the check and the move, would publish the link's target.
 */
function enterRoot(directory) {
  let expected;
  try {
    expected = lstatSync(directory);
  } catch {
    throw new Refused(`Nothing to publish at ${directory}.`);
  }
  if (!expected.isDirectory())
    throw new Refused(`Refused to copy ${directory}: it is a link or not a directory.`);
  process.chdir(directory);
  if (!sameNode(statSync("."), expected))
    throw new Refused(`Refused to copy ${directory}: it changed during the copy.`);
}

/** Copy one file named in the current directory. Never follows a link. */
function copyFile(name, to) {
  let input;
  try {
    input = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Refused(`Refused to copy ${path.join(process.cwd(), name)}: it is not a plain file.`);
  }
  try {
    const info = fstatSync(input);
    // A second link means the same file is reachable from somewhere outside this tree.
    if (!info.isFile() || info.nlink !== 1)
      throw new Refused(
        `Refused to copy ${path.join(process.cwd(), name)}: it is not a plain file.`,
      );
    files += 1;
    if (files > maxFiles) throw new TooLarge();
    const output = openSync(
      to,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      for (;;) {
        const read = readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) break;
        // Counted as read, so a file that grows during the copy cannot pass the cap.
        bytes += read;
        if (bytes > maxBytes) throw new TooLarge();
        // A write may be short; continue until the whole chunk is on disk.
        for (let written = 0; written < read; )
          written += writeSync(output, buffer, written, read - written);
      }
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
}

function copyDirectory(to, depth) {
  if (depth > MAX_DEPTH) throw new TooLarge();
  const here = statSync(".");
  for (const entry of readdirSync(".", { withFileTypes: true })) {
    visit();
    if (SKIPPED_NAMES.has(entry.name) || SKIPPED_PATTERN.test(entry.name)) continue;
    if (entry.isDirectory()) {
      const target = path.join(to, entry.name);
      mkdirSync(target, { mode: 0o700 });
      enter(entry.name);
      copyDirectory(target, depth + 1);
      leave(here);
    } else if (entry.isFile()) {
      copyFile(entry.name, path.join(to, entry.name));
    }
    // Links, sockets and devices are left out.
  }
}

try {
  if (!source || !destination || !Number.isFinite(maxBytes) || !Number.isFinite(maxFiles))
    throw new Refused("Usage: snapshot-copy-worker <source> <destination> <max-bytes> <max-files>");
  let entry = "";
  let rootInfo;
  try {
    rootInfo = lstatSync(source);
  } catch {
    throw new Refused(`Nothing to publish at ${source}.`);
  }
  if (rootInfo.isDirectory()) {
    enterRoot(source);
    copyDirectory(destination, 0);
  } else if (rootInfo.isFile()) {
    // A single file: enter its directory the same way, then open the file by bare name.
    enterRoot(path.dirname(source));
    entry = path.basename(source);
    copyFile(entry, path.join(destination, entry));
  } else {
    throw new Refused(`Refused to copy ${source}: it is a link or not a plain file.`);
  }
  process.stdout.write(JSON.stringify({ bytes, entry }));
  process.exit(0);
} catch (error) {
  if (error instanceof TooLarge) process.exit(3);
  process.stderr.write(error instanceof Refused ? error.message : "The snapshot copy failed.");
  process.exit(1);
}
