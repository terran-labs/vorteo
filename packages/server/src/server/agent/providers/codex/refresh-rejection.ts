import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Codex's own message when its refresh grant is dead, as of Codex 0.13x: "Your access token could
 * not be refreshed because your refresh token has expired. Please log out and sign in again." The
 * access token can keep answering the usage API for a while after that, so Settings showed the
 * account as connected while every new agent on it failed (2026-11-12).
 */
const REFRESH_REJECTED =
  /access token could not be refreshed|refresh token (has expired|was already used|has been revoked|is (no longer )?valid)/i;

/** Lives beside the Host-owned sign-in journal; holds file metadata only, never a credential. */
const MARKER = join(".vorteo-signin", "refresh-rejected.json");

const MarkerSchema = z.object({ authMtimeMs: z.number(), authSize: z.number() });

export function isCodexRefreshRejection(message: string | undefined): boolean {
  return message !== undefined && REFRESH_REJECTED.test(message);
}

/**
 * Records that Codex rejected the sign-in now stored in `<codexHome>/auth.json`. The record names
 * that file's modification time and size, so any later sign-in that rewrites it clears the record.
 */
export async function recordCodexRefreshRejection(codexHome: string): Promise<void> {
  const auth = await stat(join(codexHome, "auth.json"));
  const file = join(codexHome, MARKER);
  await mkdir(join(codexHome, ".vorteo-signin"), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ authMtimeMs: auth.mtimeMs, authSize: auth.size, at: Date.now() }),
    { mode: 0o600 },
  );
  await rename(temporary, file);
}

/** Whether the sign-in in `<codexHome>/auth.json` is the one Codex last refused to refresh. */
export async function codexRefreshRejected(codexHome: string): Promise<boolean> {
  try {
    const marker = MarkerSchema.parse(JSON.parse(await readFile(join(codexHome, MARKER), "utf8")));
    const auth = await stat(join(codexHome, "auth.json"));
    return auth.mtimeMs === marker.authMtimeMs && auth.size === marker.authSize;
  } catch {
    // No record, or no sign-in to compare with: nothing is known to be rejected.
    return false;
  }
}
