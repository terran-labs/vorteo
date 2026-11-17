import { lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TMPDIR must be local to this runtime, outside shared home/project mounts.
// A stable private path avoids accumulating provider per-cwd state on restart.
export async function getProviderProbeCwd(): Promise<string> {
  const uid = process.getuid?.();
  const directory = join(tmpdir(), `vorteo-provider-probes-${uid ?? "user"}`);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  const wrongOwner = uid !== undefined && info.uid !== uid;
  const publicPermissions = process.platform !== "win32" && (info.mode & 0o077) !== 0;
  if (!info.isDirectory() || wrongOwner || publicPermissions) {
    throw new Error(
      "Provider probe directory must be a private directory owned by the daemon user",
    );
  }
  return directory;
}
