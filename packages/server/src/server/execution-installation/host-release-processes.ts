import { execFile } from "node:child_process";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveReference } from "./host-release-retention.js";

const run = promisify(execFile);

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Paths under `root` found in `lsof -Fn` output (one `n<path>` line per open file) and in
 * process command lines. Command lines are matched as text, so a path with spaces is cut at
 * the first one; the job folder name at its start is what retention needs and has none.
 */
export function releasePathsInProcessListing(
  root: string,
  listing: { files: string; commands: string },
): string[] {
  const found = new Set<string>();
  for (const line of listing.files.split("\n"))
    if (line.startsWith(`n${root}${path.sep}`)) found.add(line.slice(1));
  const inCommand = new RegExp(`${escapePattern(root + path.sep)}[^\\s"']+`, "g");
  for (const match of listing.commands.matchAll(inCommand)) found.add(match[0]);
  return [...found];
}

/**
 * Paths under `root` that command lines reach through a link outside it, such as the release
 * link a job is started through. The link is resolved as it points now. A process started
 * through a link that has since moved is not found this way; its working directory and
 * mapped native code are what name its release.
 */
export async function linkedReleasePathsInCommands(
  root: string,
  commands: string,
): Promise<string[]> {
  const outside = new Set<string>();
  for (const match of commands.matchAll(/(?:^|[\s="'])(\/[^\s"']+)/gm))
    if (!match[1]!.startsWith(root + path.sep)) outside.add(match[1]!);
  const found = new Set<string>();
  for (const candidate of outside) {
    const resolved = await resolveReference(candidate).catch(() => null);
    if (resolved?.startsWith(root + path.sep)) found.add(resolved);
  }
  return [...found];
}

async function pathsInListing(
  root: string,
  listing: { files: string; commands: string },
): Promise<string[]> {
  return [
    ...releasePathsInProcessListing(root, listing),
    ...(await linkedReleasePathsInCommands(root, listing.commands)),
  ];
}

async function linuxListing(): Promise<{ files: string; commands: string }> {
  const files: string[] = [];
  const commands: string[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    // A process that exited, or one of another user, cannot be read; neither runs this
    // installation's releases, which all run as this user.
    for (const link of ["cwd", "exe"])
      await readlink(path.join("/proc", pid, link)).then(
        (target) => files.push(`n${target}`),
        () => undefined,
      );
    await readFile(path.join("/proc", pid, "cmdline"), "utf8").then(
      (text) => commands.push(text.replaceAll("\0", " ")),
      () => undefined,
    );
  }
  return { files: files.join("\n"), commands: commands.join("\n") };
}

/**
 * Every path under `root` that a running process of this user executes from: its working
 * directory, its executable and mapped native code, and paths on its command line, including
 * ones that reach the root through a link outside it. `root`
 * must be canonical, because the kernel reports canonical paths. A release that was renamed
 * while in use is reported under its new name. Throws when the listing cannot be read, so a
 * caller never mistakes a failed listing for no processes.
 */
export async function releaseProcessPaths(root: string): Promise<string[]> {
  if (process.platform === "linux") return pathsInListing(root, await linuxListing());
  if (process.platform !== "darwin")
    throw new Error(`Running processes cannot be listed on ${process.platform}`);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Running processes cannot be listed without a user");
  const options = { timeout: 120_000, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" as const };
  const [files, commands] = await Promise.all([
    run("/usr/sbin/lsof", ["-a", "-u", String(uid), "-d", "cwd,txt", "-Fn"], options),
    run("/bin/ps", ["-axww", "-o", "command="], options),
  ]);
  return pathsInListing(root, { files: files.stdout, commands: commands.stdout });
}

/** Larger files are not configuration a release could be launched from; refuse, never skip. */
const PERSISTENT_FILE_LIMIT = 4 * 1024 * 1024;

const JOB_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Files outside the installation configuration that launch code from a release by absolute
 * path and outlive any one process: the Chrome native host wrapper Claude Code writes into
 * each account directory, which execs the release's `claude.exe`, and every LaunchAgent
 * property list. All LaunchAgents are read, loaded or not, because a job that is not loaded
 * now can be loaded later; keeping a release longer is the safe side.
 */
export async function persistentReferenceFiles(input: {
  hostHome: string;
  /** `~/Library/LaunchAgents` on macOS; null where there is none. */
  launchAgents: string | null;
}): Promise<string[]> {
  const files: string[] = [];
  const accounts = path.join(input.hostHome, "claude-accounts");
  for (const account of await readdirIfPresent(accounts))
    files.push(path.join(accounts, account, "chrome", "chrome-native-host"));
  if (input.launchAgents)
    for (const name of await readdirIfPresent(input.launchAgents))
      if (name.endsWith(".plist")) files.push(path.join(input.launchAgents, name));
  return files;
}

async function readdirIfPresent(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Job folders under `root` that the files name by absolute path, through `root` itself or any
 * of `aliases` (other spellings of the same directory, such as the configured, non-canonical
 * path). Binary property lists keep ASCII strings intact, so a byte search finds paths in both
 * formats. A missing file names nothing; any other read failure, or a file over the size
 * limit, throws so cleanup is skipped. File contents are never logged or reported: they can
 * hold credentials.
 */
export async function jobFoldersNamedInFiles(
  root: string,
  aliases: readonly string[],
  files: readonly string[],
): Promise<string[]> {
  const prefixes = [...new Set([root, ...aliases])].map((prefix) =>
    prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(`(?:${prefixes.join("|")})/(${JOB_ID})(?![0-9a-zA-Z-])`, "g");
  const found = new Set<string>();
  for (const file of files) {
    let contents: Buffer;
    try {
      const info = await stat(file);
      if (info.size > PERSISTENT_FILE_LIMIT)
        throw new Error(`${file} is too large to check for release references`);
      contents = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const match of contents.toString("latin1").matchAll(pattern))
      found.add(path.join(root, match[1]!));
  }
  return [...found];
}
