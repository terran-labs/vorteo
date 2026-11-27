import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { LeanGateBootstrapOptions } from "../gate-bootstrap.js";

type DockerSource = NonNullable<LeanGateBootstrapOptions["docker"]>;
const fileName = "factory-gate-executor.json";
const maxBytes = 8192;
const id = z.number().int().positive().max(0x7fffffff);
const configSchema = z.strictObject({
  dockerBinary: z.string().min(1),
  socket: z.string().min(1),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  uid: id,
  gid: id,
  timeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

interface HostGateExecutorConfigInput {
  /** Canonical native Host home verified by the installation caller. */
  paseoHome: string;
  /** From trusted installation placement, including Dev data and shared project and mount roots. */
  guestRoots: readonly string[];
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function inspectIfPresent(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
}

function canonical(path: string): boolean {
  return (
    isAbsolute(path) &&
    resolve(path) === path &&
    Array.from(path).every((character) => character >= " " && character !== "\u007f")
  );
}

function inside(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

async function assertHostPlacement(path: string, guestRoots: readonly string[], uid: number) {
  if (!canonical(path) || guestRoots.some((root) => inside(path, root))) {
    throw new Error(
      "Factory gate configuration and endpoints require protected native Host paths.",
    );
  }
  if ((await realpath(path)) !== path) {
    throw new Error("Factory gate configuration and endpoints cannot use symbolic links.");
  }
  const parent = dirname(path);
  for (let directory = parent; ; directory = dirname(directory)) {
    const info = await lstat(directory);
    // A root-owned sticky ancestor cannot rename a daemon-owned child. The immediate parent
    // remains non-writable to other users, including when it holds the engine socket.
    const stickyAncestor = directory !== parent && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== uid) ||
      ((info.mode & 0o022) !== 0 && !stickyAncestor)
    ) {
      throw new Error("Factory gate paths require Host-owned directories protected from writes.");
    }
    if (await isGitDirectory(directory))
      throw new Error("Factory gate paths must be outside Git checkouts.");
    if (dirname(directory) === directory) return;
  }
}

async function isGitDirectory(directory: string): Promise<boolean> {
  if (await inspectIfPresent(join(directory, ".git"))) return true;
  if (!(await inspectIfPresent(join(directory, "HEAD")))) return false;
  const objects = await inspectIfPresent(join(directory, "objects"));
  return Boolean(objects?.isDirectory() && (await inspectIfPresent(join(directory, "config"))));
}

async function resolveGuestRoots(guestRoots: readonly string[]): Promise<string[]> {
  const roots = await Promise.all(
    guestRoots.map(async (root) => {
      if (!isAbsolute(root)) throw new Error("Factory requires absolute guest mount roots.");
      const normalized = resolve(root);
      const actual = await realpath(normalized).catch((error: unknown) => {
        if (missing(error)) return normalized;
        throw error;
      });
      return [normalized, actual];
    }),
  );
  return roots.flat();
}

async function readConfigFile(
  path: string,
  uid: number,
  guestRoots: readonly string[],
): Promise<DockerSource | undefined> {
  const before = await inspectIfPresent(path);
  if (!before) return undefined;
  await assertHostPlacement(path, guestRoots, uid);
  if (!before.isFile() || before.uid !== uid || (before.mode & 0o077) !== 0 || before.nlink !== 1) {
    throw new Error("Factory gate executor config must be a private regular Host file.");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await file.stat();
    if (
      !actual.isFile() ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      actual.uid !== uid ||
      (actual.mode & 0o077) !== 0 ||
      actual.nlink !== 1 ||
      actual.size > maxBytes
    ) {
      throw new Error("Factory gate executor config changed or exceeds its private file limit.");
    }
    const data = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== actual.size)
      throw new Error("Factory gate executor config changed during reading.");
    let decoded: unknown;
    try {
      decoded = JSON.parse(data.toString("utf8", 0, bytesRead));
    } catch {
      throw new Error("Set valid JSON in the private Factory gate executor config.");
    }
    const parsed = configSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error(
        "Set the Docker binary, Unix socket, image SHA and non-root UID and GID in the Factory gate executor config.",
      );
    }
    return parsed.data;
  } finally {
    await file.close();
  }
}

/** Read native infrastructure settings. No engine connection or filesystem mutation is performed. */
export async function readHostGateExecutorConfig(
  input: HostGateExecutorConfigInput,
): Promise<DockerSource | undefined> {
  const uid = process.getuid?.();
  const { paseoHome } = input;
  if (uid === undefined || !canonical(paseoHome) || paseoHome === sep) {
    throw new Error("Factory gate executor requires the canonical native Host daemon home.");
  }
  const home = await lstat(paseoHome);
  if (
    !home.isDirectory() ||
    home.uid !== uid ||
    (home.mode & 0o077) !== 0 ||
    (await realpath(paseoHome)) !== paseoHome
  ) {
    throw new Error("Factory gate executor requires the private native Host daemon home.");
  }
  const path = join(paseoHome, fileName);
  const guestRoots = await resolveGuestRoots(input.guestRoots);
  const config = await readConfigFile(path, uid, guestRoots);
  if (!config) return undefined;
  await Promise.all([
    assertHostPlacement(config.dockerBinary, guestRoots, uid),
    assertHostPlacement(config.socket, guestRoots, uid),
  ]);
  const [binary, socket] = await Promise.all([lstat(config.dockerBinary), lstat(config.socket)]);
  if (
    !binary.isFile() ||
    (binary.uid !== 0 && binary.uid !== uid) ||
    binary.nlink !== 1 ||
    (binary.mode & 0o6022) !== 0
  ) {
    throw new Error("Factory requires a trusted native Docker executable.");
  }
  await access(config.dockerBinary, constants.X_OK);
  if (
    !socket.isSocket() ||
    (socket.uid !== 0 && socket.uid !== uid) ||
    socket.nlink !== 1 ||
    (socket.mode & 0o002) !== 0
  ) {
    throw new Error("Factory requires a protected local Unix Docker socket.");
  }
  return config;
}
