import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Reads a small regular file that another process, possibly an untrusted one, may have
 * replaced. In Dev the preview broker's channel is agent-writable, so a name there can be
 * a FIFO, a link to a device or an endless file.
 *
 * - O_NOFOLLOW refuses a link in the last path component.
 * - O_NONBLOCK makes opening a FIFO return at once instead of waiting for a writer.
 * - The type and size come from the opened descriptor, so the file cannot be swapped
 *   between the check and the read, and at most `maxBytes + 1` bytes are ever read.
 *
 * Returns null for a missing, non-regular, oversized or unreadable file.
 */
export async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
): Promise<{ text: string; stamp: string } | null> {
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
    if (!info.isFile() || info.size > maxBytes) return null;
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
