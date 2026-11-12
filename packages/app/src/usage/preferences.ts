import { z } from "zod";

/** Whether percentages read as the share used or the share left. */
export type UsageDisplayAs = "used" | "remaining";

/** Device-local. */
export interface UsagePreferences {
  displayAs: UsageDisplayAs;
  /** The host the user picked to show usage for; null until they pick one. */
  serverId: string | null;
}

export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = {
  displayAs: "used",
  serverId: null,
};

/**
 * Older builds also stored `pins` (and before that `pinned`): windows pinned to a sidebar Usage
 * summary that no longer exists. `z.object` drops those keys on read, so old values load cleanly
 * and disappear the next time settings are saved.
 */
export const UsagePreferencesSchema = z
  .object({
    displayAs: z.enum(["used", "remaining"]).catch("used"),
    serverId: z.string().nullable().catch(null),
  })
  .catch(DEFAULT_USAGE_PREFERENCES);

export function setUsageDisplayAs(
  preferences: UsagePreferences,
  displayAs: UsageDisplayAs,
): UsagePreferences {
  return { ...preferences, displayAs };
}

export function setUsageHost(preferences: UsagePreferences, serverId: string): UsagePreferences {
  return { ...preferences, serverId };
}
