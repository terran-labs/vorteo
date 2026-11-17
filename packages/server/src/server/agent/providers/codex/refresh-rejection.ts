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

/** Identifies one stored sign-in by `auth.json` metadata. Never holds credential content. */
export interface CodexAuthGeneration {
  authMtimeMs: number;
  authSize: number;
}

/** The generation of the sign-in now in `<codexHome>/auth.json`, or null when there is none. */
export async function readCodexAuthGeneration(
  codexHome: string,
): Promise<CodexAuthGeneration | null> {
  try {
    const auth = await stat(join(codexHome, "auth.json"));
    return { authMtimeMs: auth.mtimeMs, authSize: auth.size };
  } catch {
    return null;
  }
}

function sameGeneration(a: CodexAuthGeneration, b: CodexAuthGeneration): boolean {
  return a.authMtimeMs === b.authMtimeMs && a.authSize === b.authSize;
}

/**
 * Records that Codex refused to refresh the sign-in `generation`, captured when the failing turn
 * started. A failure that arrives after a newer sign-in replaced `auth.json` records nothing, so a
 * completed reconnect is never marked rejected. Returns whether a record was written.
 */
export async function recordCodexRefreshRejection(
  codexHome: string,
  generation: CodexAuthGeneration,
): Promise<boolean> {
  const current = await readCodexAuthGeneration(codexHome);
  if (!current || !sameGeneration(current, generation)) return false;
  const file = join(codexHome, MARKER);
  await mkdir(join(codexHome, ".vorteo-signin"), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...generation, at: Date.now() }), { mode: 0o600 });
  await rename(temporary, file);
  return true;
}

/** Whether the sign-in in `<codexHome>/auth.json` is the one Codex last refused to refresh. */
export async function codexRefreshRejected(codexHome: string): Promise<boolean> {
  try {
    const marker = MarkerSchema.parse(JSON.parse(await readFile(join(codexHome, MARKER), "utf8")));
    const current = await readCodexAuthGeneration(codexHome);
    // No sign-in to compare with: nothing is known to be rejected.
    return current !== null && sameGeneration(current, marker);
  } catch {
    // No record: nothing is known to be rejected.
    return false;
  }
}
