import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";

/**
 * Reads a small regular file that another process, possibly an untrusted one, may have
 * replaced. In Dev the preview broker's channel is agent-writable, so a name there can be
 * a FIFO, a link to a device or an endless file.
 *
 * - `lstat` first refuses a symbolic link (on Windows, also a junction) and anything that is
 *   not a regular file, on every platform. Windows has no O_NOFOLLOW, so opening alone would
 *   follow a link there.
 * - On POSIX, O_NOFOLLOW and O_NONBLOCK still guard the open itself: a FIFO swapped in after
 *   the check opens at once instead of waiting for a writer.
 * - The opened file must be the one `lstat` saw (same device, and same file ID where the
 *   platform reports one), so a link or another file swapped in between is refused.
 * - The size comes from the opened descriptor, and at most `maxBytes + 1` bytes are read.
 *
 * Returns null for a missing, linked, non-regular, replaced, oversized or unreadable file.
 * The preset fence policy reader (#595) follows the same steps.
 */
export async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
): Promise<{ text: string; stamp: string } | null> {
  let seen: Stats;
  try {
    seen = await lstat(path);
  } catch {
    return null;
  }
  if (seen.isSymbolicLink() || !seen.isFile()) return null;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !sameFile(seen, info) || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    // The file grew past the limit after the size check.
    if (length > maxBytes) return null;
    return {
      text: buffer.subarray(0, length).toString("utf8"),
      stamp: `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The same file, by device and file ID. A platform reporting no file ID (0) compares by device. */
function sameFile(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev) return false;
  return left.ino === 0 || right.ino === 0 || left.ino === right.ino;
}
