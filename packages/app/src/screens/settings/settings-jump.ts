/**
 * Jumps into the settings page that is already on screen, from controls outside it such as the
 * sidebar's "System needs attention" button.
 *
 * Navigating instead would push a second settings screen over the first. The first stays mounted
 * underneath with the same element ids, and a route that already names the target section changes
 * nothing, so the jump either goes nowhere or measures the hidden page. A focused settings page
 * registers here; callers fall back to navigation when none is listening.
 */

export interface SettingsJumpTarget {
  pane: string;
  /** Catalog entry whose row to land on. */
  settingId?: string;
  /** DOM id of an element inside the pane to land on, web only. */
  anchorId?: string;
  /** Moves keyboard focus to the target once it is in view. */
  focus?: boolean;
}

type Listener = (target: SettingsJumpTarget) => void;

// The newest registration is the page in front; earlier ones belong to screens beneath it.
const listeners: Listener[] = [];

export function registerSettingsJump(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.lastIndexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

/** Returns false when no settings page is listening, so the caller can navigate instead. */
export function requestSettingsJump(target: SettingsJumpTarget): boolean {
  const listener = listeners[listeners.length - 1];
  if (!listener) return false;
  listener(target);
  return true;
}

/** The System health list, where "System needs attention" leads. */
export const SYSTEM_HEALTH_ANCHOR_ID = "settings-system-health-list";
export const SYSTEM_HEALTH_TARGET: SettingsJumpTarget = {
  pane: "system.health",
  anchorId: SYSTEM_HEALTH_ANCHOR_ID,
  focus: true,
};
/** Address of the health list for callers outside an open settings page. */
export const SYSTEM_HEALTH_ROUTE = "/settings/health";
