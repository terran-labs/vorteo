import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { auditLeanShadow } from "./metrics.js";

type ShadowAudit = ReturnType<typeof auditLeanShadow>;
const maxBytes = 1024 * 1024;

function requirePrivate(stat: Stats, kind: "directory" | "file"): void {
  const expectedType = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (
    !expectedType ||
    typeof process.getuid !== "function" ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("The Factory shadow audit path must be private and owned by the daemon user.");
  }
}

function auditPaths(home: string, projectId: string) {
  if (!isAbsolute(home) || !projectId || /[/\\]/u.test(projectId) || projectId.includes("\0")) {
    throw new Error("Use an absolute daemon home and a valid Factory project identifier.");
  }
  const directory = join(home, "factory-shadow");
  return { directory, file: join(directory, projectId + ".json") };
}

/** Keep one bounded, redacted observation per project, outside the operational ledger. */
export function createLeanShadowAuditSink(home: string, projectId: string) {
  const { directory, file } = auditPaths(home, projectId);
  return async (audit: ShadowAudit): Promise<void> => {
    const body = JSON.stringify({ version: 1, ...audit }) + "\n";
    if (Buffer.byteLength(body) > maxBytes)
      throw new Error("Factory shadow audit exceeds its limit.");
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    requirePrivate(await lstat(directory), "directory");
    const temporary = join(directory, "." + randomUUID() + ".tmp");
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
}

export async function readLeanShadowAudit(
  home: string,
  projectId: string,
): Promise<{ version: 1 } & ShadowAudit> {
  const { directory, file } = auditPaths(home, projectId);
  requirePrivate(await lstat(directory), "directory");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    requirePrivate(stat, "file");
    if (stat.size > maxBytes) throw new Error("Factory shadow audit exceeds its limit.");
    const result = JSON.parse(await handle.readFile("utf8"));
    if (result?.version !== 1) throw new Error("Unsupported Factory shadow audit version.");
    return result;
  } finally {
    await handle.close();
  }
}
