import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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
 * directory, its executable and mapped native code, and paths on its command line. `root`
 * must be canonical, because the kernel reports canonical paths. A release that was renamed
 * while in use is reported under its new name. Throws when the listing cannot be read, so a
 * caller never mistakes a failed listing for no processes.
 */
export async function releaseProcessPaths(root: string): Promise<string[]> {
  if (process.platform === "linux") return releasePathsInProcessListing(root, await linuxListing());
  if (process.platform !== "darwin")
    throw new Error(`Running processes cannot be listed on ${process.platform}`);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Running processes cannot be listed without a user");
  const options = { timeout: 120_000, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" as const };
  const [files, commands] = await Promise.all([
    run("/usr/sbin/lsof", ["-a", "-u", String(uid), "-d", "cwd,txt", "-Fn"], options),
    run("/bin/ps", ["-axww", "-o", "command="], options),
  ]);
  return releasePathsInProcessListing(root, { files: files.stdout, commands: commands.stdout });
}
