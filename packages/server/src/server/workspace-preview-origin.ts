import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readBoundedRegularFile } from "./bounded-file-read.js";

/** A reservation is a few hundred bytes; anything larger is not one. */
const MAX_RESERVATION_BYTES = 4096;
const ORIGINS_DIRECTORY = join(homedir(), ".local/share/paseo-preview/https/origins");
/**
 * The most reservation files the claim index reads. The broker holds at most 32
 * reservations and leaves stale files behind, so this leaves room for those.
 */
const MAX_INDEXED_RESERVATIONS = 128;
/** How long a claim index serves, matching the broker status poll. */
const CLAIM_INDEX_TTL_MS = 5_000;

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

interface ClaimIndex {
  builtAt: number;
  directoryMtimeMs: number;
  /** How many (workspace, service) reservations name each origin; null when over the cap. */
  claims: Map<string, number> | null;
}

const claimIndexes = new Map<string, { index?: ClaimIndex; building?: Promise<ClaimIndex> }>();

async function buildClaimIndex(directory: string, directoryMtimeMs: number): Promise<ClaimIndex> {
  const builtAt = Date.now();
  let names: string[];
  try {
    names = (await readdir(directory)).filter((entry) => entry.endsWith(".json")).sort();
  } catch {
    return { builtAt, directoryMtimeMs, claims: new Map() };
  }
  // Past the cap a forged claim could hide unread, so no origin is trusted at all.
  if (names.length > MAX_INDEXED_RESERVATIONS) return { builtAt, directoryMtimeMs, claims: null };
  const claims = new Map<string, number>();
  for (const name of names) {
    const parts = name.slice(0, -".json".length).split(".");
    if (parts.length !== 2) continue;
    const origin = await readWorkspacePreviewOrigin(parts[0], parts[1], directory);
    if (origin) claims.set(origin, (claims.get(origin) ?? 0) + 1);
  }
  return { builtAt, directoryMtimeMs, claims };
}

/**
 * Who claims each origin across every workspace. Built at most once per status poll, or
 * sooner when a file is added, renamed or removed, with one read shared by every caller: at
 * most 128 bounded reads of 4 KiB each per build. A file rewritten in place, which leaves
 * the directory's time unchanged, is seen within one poll.
 */
async function originClaims(directory: string): Promise<Map<string, number> | null> {
  let directoryMtimeMs: number;
  try {
    directoryMtimeMs = (await stat(directory)).mtimeMs;
  } catch {
    return new Map();
  }
  const cached = claimIndexes.get(directory) ?? {};
  claimIndexes.set(directory, cached);
  const { index } = cached;
  if (
    index &&
    index.directoryMtimeMs === directoryMtimeMs &&
    Date.now() - index.builtAt < CLAIM_INDEX_TTL_MS
  ) {
    return index.claims;
  }
  cached.building ??= buildClaimIndex(directory, directoryMtimeMs).finally(() => {
    cached.building = undefined;
  });
  cached.index = await cached.building;
  return cached.index.claims;
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
  // The broker gives each reservation its own port, so two reservations naming one origin,
  // in this workspace or any other, mean a forged or stale file. A link must never match the
  // wrong preview, so every claimant loses the origin.
  const local = new Map<string, number>();
  for (const origin of origins.values()) local.set(origin, (local.get(origin) ?? 0) + 1);
  const claims = await originClaims(directory);
  for (const [service, origin] of origins) {
    if (!claims || (local.get(origin) ?? 0) > 1 || (claims.get(origin) ?? 0) > 1) {
      origins.delete(service);
    }
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
