import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readBoundedRegularFile } from "./bounded-file-read.js";

/** A reservation is a few hundred bytes; anything larger is not one. */
const MAX_RESERVATION_BYTES = 4096;
const ORIGINS_DIRECTORY = join(homedir(), ".local/share/paseo-preview/https/origins");

const reservationSchema = z.object({
  workspaceId: z.string(),
  service: z.string(),
  origin: z.string().url(),
});

function validOrigin(json: unknown, workspaceId: string, service: string): string | null {
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
 * Read the broker's stable reservation; service lifecycle supplies running state. The
 * origins directory is agent-writable in Dev, so the file is read with a bounded,
 * non-blocking, link-refusing read that a planted FIFO or device cannot stall.
 */
export async function readWorkspacePreviewOrigin(
  workspaceId: string,
  service: string,
  directory = ORIGINS_DIRECTORY,
): Promise<string | null> {
  if (![workspaceId, service].every((value) => /^[a-zA-Z0-9_-]+$/.test(value))) return null;
  const file = await readBoundedRegularFile(
    join(directory, `${workspaceId}.${service}.json`),
    MAX_RESERVATION_BYTES,
  );
  if (!file) return null;
  try {
    return validOrigin(JSON.parse(file.text), workspaceId, service);
  } catch {
    return null;
  }
}

/** Every reservation of one workspace, by service, for a synchronous projection. */
export async function readWorkspacePreviewOrigins(
  workspaceId: string,
  directory = ORIGINS_DIRECTORY,
): Promise<Map<string, string>> {
  const origins = new Map<string, string>();
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) return origins;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return origins;
  }
  const prefix = `${workspaceId}.`;
  for (const name of names
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
    .slice(0, 64)) {
    const service = name.slice(prefix.length, -".json".length);
    const origin = await readWorkspacePreviewOrigin(workspaceId, service, directory);
    if (origin) origins.set(service, origin);
  }
  return origins;
}

/**
 * Every preview origin the broker has reserved. Previews may be published under a
 * different hostname than this daemon, so pages that must name the origins allowed to
 * embed or follow them read the reservations instead of assuming a shared hostname.
 */
export async function listReservedPreviewOrigins(directory = ORIGINS_DIRECTORY): Promise<string[]> {
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
      const file = await readBoundedRegularFile(join(directory, name), MAX_RESERVATION_BYTES);
      if (!file) continue;
      const result = reservationSchema.safeParse(JSON.parse(file.text));
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
