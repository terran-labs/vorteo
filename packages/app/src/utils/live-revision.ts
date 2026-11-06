/// <reference types="expo/types/metro-require" />

/**
 * Live dev's record of committed work since the build the app's version names. `live-dev.mjs`
 * writes the gitignored `live-revision.local.json` beside this file after every change to the
 * live checkout's Git state. Static exports, CI and tests never have it, so it is read through
 * Metro's `require.context`, which tolerates a missing file and hot-reloads one that appears or
 * changes. Outside Metro, `require.context` does not exist and there is no record.
 */
export interface LiveRevision {
  /** The app version the release commit set, without a `v` prefix. */
  version: string;
  /** Commits on the live branch after that release commit. */
  ahead: number;
}

function readRecord(): unknown {
  if (typeof require !== "function" || typeof require.context !== "function") return null;
  const context = require.context("./", false, /^\.\/live-revision\.local\.json$/);
  const [key] = context.keys();
  return key ? context(key) : null;
}

export function resolveLiveRevision(): LiveRevision | null {
  try {
    const record = readRecord() as Partial<LiveRevision> | null;
    if (typeof record?.version !== "string") return null;
    if (typeof record.ahead !== "number" || !Number.isInteger(record.ahead)) return null;
    return { version: record.version, ahead: record.ahead };
  } catch {
    return null;
  }
}

/**
 * `v26.11.302+53` when the live branch carries commits past the running version's release
 * commit. A record written for another version is stale, so it adds nothing.
 */
export function formatLiveVersionSuffix(appVersion: string | null): string {
  const live = resolveLiveRevision();
  if (!live || live.ahead <= 0 || !appVersion) return "";
  if (live.version !== appVersion.replace(/^v/i, "")) return "";
  return `+${live.ahead}`;
}
