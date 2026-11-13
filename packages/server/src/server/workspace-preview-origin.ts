import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const reservationSchema = z.object({
  workspaceId: z.string(),
  service: z.string(),
  origin: z.string().url(),
});

/** Read the broker's stable reservation; service lifecycle supplies running state. */
export function readWorkspacePreviewOrigin(
  workspaceId: string,
  service: string,
  directory = join(homedir(), ".local/share/paseo-preview/https/origins"),
): string | null {
  if (![workspaceId, service].every((value) => /^[a-zA-Z0-9_-]+$/.test(value))) return null;
  let text: string;
  try {
    text = readFileSync(join(directory, `${workspaceId}.${service}.json`), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const result = reservationSchema.safeParse(json);
  if (!result.success) return null;
  const reservation = result.data;
  if (reservation.workspaceId !== workspaceId || reservation.service !== service) return null;
  const url = new URL(reservation.origin);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".ts.net") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return null;
  return url.origin;
}

/**
 * Every preview origin the broker has reserved. Previews may be published under a
 * different hostname than this daemon, so pages that must name the origins allowed to
 * embed or follow them read the reservations instead of assuming a shared hostname.
 */
export async function listReservedPreviewOrigins(
  directory = join(homedir(), ".local/share/paseo-preview/https/origins"),
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const origins = new Set<string>();
  // The broker holds at most 32 reservations; the cap bounds a directory it does not own.
  for (const name of names.filter((entry) => entry.endsWith(".json")).slice(0, 128)) {
    try {
      const result = reservationSchema.safeParse(
        JSON.parse(await readFile(join(directory, name), "utf8")),
      );
      if (!result.success) continue;
      const url = new URL(result.data.origin);
      if (
        url.protocol === "https:" &&
        url.hostname.endsWith(".ts.net") &&
        url.origin === result.data.origin
      )
        origins.add(url.origin);
    } catch {
      // An unreadable or malformed reservation grants nothing.
    }
  }
  return [...origins];
}
