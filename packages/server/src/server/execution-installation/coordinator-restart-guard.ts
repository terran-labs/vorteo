import { hostReleaseCleanupDeleting } from "./host-release-retention.js";

/** Operations that restart the coordinator process. */
export type CoordinatorRestart = "upgrade" | "follow" | "settings" | "custom-domain";

/** Synchronous views of every lifecycle job a coordinator restart must not interrupt. */
export interface CoordinatorRestartState {
  upgradeActive(): boolean;
  followDispatching(): boolean;
  settingsDispatching(): boolean;
  customDomainRunning(): boolean;
  /** A Host restart or source update job that is approved or running. */
  hostJobBusy(): boolean;
  /** A bootstrap coordinator request that is open. */
  coordinatorRequestOpen(): boolean;
  /** Known only once the lab journal has loaded; false before that. */
  labUpdateActive(): boolean;
  /**
   * A Host release cleanup in this coordinator that renames and deletes, which a restart would
   * cut, with when the guard stops waiting for it; null for none, a dry run or off.
   */
  hostReleaseCleanup(): { lapsesAt: Date } | null;
}

/**
 * The restart state with its Host release cleanup view taken from the cleanup itself, so the
 * guard always sees the real run. The caller supplies every other view.
 */
export function coordinatorRestartState(
  views: Omit<CoordinatorRestartState, "hostReleaseCleanup">,
): CoordinatorRestartState {
  return { ...views, hostReleaseCleanup: () => hostReleaseCleanupDeleting() };
}

/**
 * Why `self` must not restart the coordinator now, or null. Coordinator updates, settings
 * changes and custom domain changes check it at request, approval and dispatch, so only one
 * coordinator restart runs at a time and none runs under lifecycle work the coordinator
 * follows. A release upgrade queues its own Host job, so for it only the other coordinator
 * restarts count.
 */
export function coordinatorRestartBlocker(
  state: CoordinatorRestartState,
  self: CoordinatorRestart,
): string | null {
  if (self !== "upgrade" && state.upgradeActive()) return "Wait for the release upgrade to finish.";
  if (self !== "follow" && state.followDispatching())
    return "Wait for the coordinator update to finish.";
  if (self !== "settings" && state.settingsDispatching())
    return "Wait for the coordinator settings change to finish.";
  if (self !== "custom-domain" && state.customDomainRunning())
    return "Wait for the custom domain change to finish.";
  if (self === "upgrade") return null;
  if (state.hostJobBusy()) return "Wait for the approved Host restart or update to finish.";
  if (state.coordinatorRequestOpen()) return "Wait for the open coordinator request to finish.";
  if (state.labUpdateActive()) return "Wait for the lab self-update to finish.";
  // A release upgrade waits for it at its own coordinator step instead.
  const cleanup = state.hostReleaseCleanup();
  if (cleanup)
    return `Host release cleanup is running; try again when it finishes. This check lapses at ${cleanup.lapsesAt.toISOString()}.`;
  return null;
}
