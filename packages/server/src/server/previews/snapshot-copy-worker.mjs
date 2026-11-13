/* oxlint-disable paseo/no-sync-io -- This file is its own short-lived process, never the daemon. Synchronous calls keep each directory change and the opens that depend on it strictly in order, which the safety argument below relies on. */
// Copies a published file or directory into a snapshot, then exits.
//
// The source is agent-controlled and may be rewritten while it is copied, including by a
// party less trusted than the daemon (a shared folder a container can write). Checking a
// path and then opening it is racy however carefully it is done, because only the final
// path component can be opened without following links. This worker never opens a source
// file by a multi-component path. It walks the tree by changing its own working directory
// one component at a time and asks the kernel where it ended up: after each step the
// working directory must be exactly the expected child of the previous one. A component
// swapped for a link lands somewhere else and is refused. Files are then opened by bare
// name, relative to that directory, without following links. Changing directory is
// process-wide, which is why this runs as its own short-lived process.
//
// Usage: node snapshot-copy-worker.mjs <source> <destination-dir> <max-bytes> <max-files>
// Prints {"bytes":n,"entry":"name-or-empty"} on success. Exit 3 means too large, 1 refused.
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
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
let bytes = 0;
let files = 0;
const buffer = Buffer.allocUnsafe(1024 * 1024);

/** Step into one child directory and prove the kernel put us exactly there. */
function enter(name) {
  const before = process.cwd();
  process.chdir(name);
  if (process.cwd() !== path.join(before, name))
    throw new Refused(`Refused to copy ${path.join(before, name)}: it is not a plain directory.`);
}

/** Step back out and prove we are where we came from, even if the tree was moved. */
function leave(expected) {
  process.chdir("..");
  if (process.cwd() !== expected)
    throw new Refused("Refused to copy: the published directory moved during the copy.");
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
        writeSync(output, buffer, 0, read);
      }
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
}

function copyDirectory(to) {
  const here = process.cwd();
  for (const entry of readdirSync(".", { withFileTypes: true })) {
    if (SKIPPED_NAMES.has(entry.name) || SKIPPED_PATTERN.test(entry.name)) continue;
    if (entry.isDirectory()) {
      const target = path.join(to, entry.name);
      mkdirSync(target, { mode: 0o700 });
      enter(entry.name);
      copyDirectory(target);
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
  let isDirectory = true;
  try {
    // The publishing agent chose this path, so resolving it once is the starting point.
    process.chdir(source);
  } catch {
    isDirectory = false;
  }
  if (isDirectory) {
    copyDirectory(destination);
  } else {
    process.chdir(path.dirname(source));
    entry = path.basename(source);
    copyFile(entry, path.join(destination, entry));
  }
  process.stdout.write(JSON.stringify({ bytes, entry }));
  process.exit(0);
} catch (error) {
  if (error instanceof TooLarge) process.exit(3);
  process.stderr.write(error instanceof Refused ? error.message : "The snapshot copy failed.");
  process.exit(1);
}
