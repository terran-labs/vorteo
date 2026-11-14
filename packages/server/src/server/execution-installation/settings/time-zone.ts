import { isDeepStrictEqual } from "node:util";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import {
  UNSET_TIME_ZONE,
  isKnownTimeZone,
  type InstallationSettings,
} from "@getpaseo/protocol/installation-settings";
import {
  InstallationSettingsAdmissionError,
  type InstallationSettingsAdmission,
} from "./admission.js";

/** Only the two documented fields, so passthrough keys never reach the daemon's copy. */
export function pickTimeZone(
  value: NonNullable<MutableDaemonConfig["timeZone"]>,
): NonNullable<MutableDaemonConfig["timeZone"]> {
  return { override: value.override, reported: value.reported };
}

/** The patch's time zone as a supported patch field, or nothing. */
export function pickTimeZonePatch(patch: { timeZone?: MutableDaemonConfig["timeZone"] }): {
  timeZone?: NonNullable<MutableDaemonConfig["timeZone"]>;
} {
  return patch.timeZone === undefined ? {} : { timeZone: pickTimeZone(patch.timeZone) };
}

/** The daemon's setting, or the unset value so the key always signals support. */
export function daemonTimeZone(
  value: MutableDaemonConfig["timeZone"],
): NonNullable<MutableDaemonConfig["timeZone"]> {
  return value ?? { ...UNSET_TIME_ZONE };
}

/**
 * The coordinator's time zone for one daemon's patch. Only daemons that report the key receive
 * it; older ones would drop it and never verify.
 */
export function projectTimeZone(
  settings: Pick<InstallationSettings, "timeZone">,
  localConfig: MutableDaemonConfig,
): { timeZone?: NonNullable<MutableDaemonConfig["timeZone"]> } {
  if (localConfig.timeZone === undefined) return {};
  return { timeZone: structuredClone(settings.timeZone ?? UNSET_TIME_ZONE) };
}

/** A time zone update must name zones the coordinator knows. */
export function assertTimeZoneUpdate(
  value: InstallationSettings["timeZone"],
  refuse: () => Error,
): void {
  if (!value) return;
  if ([value.override, value.reported].some((zone) => zone !== null && !isKnownTimeZone(zone)))
    throw refuse();
}

export function changesTimeZone(
  current: MutableDaemonConfig,
  patch: MutableDaemonConfigPatch,
): boolean {
  return (
    patch.timeZone !== undefined &&
    !isDeepStrictEqual(pickTimeZone(patch.timeZone), current.timeZone ?? UNSET_TIME_ZONE)
  );
}

/** Both names must be zones this runtime knows, so prompts never name a misspelled zone. */
export function assertKnownTimeZones(value: MutableDaemonConfigPatch["timeZone"]): void {
  if (!value) return;
  for (const zone of [value.override, value.reported])
    if (zone !== null && !isKnownTimeZone(zone))
      throw new Error(`Unknown time zone: ${zone.slice(0, 64)}`);
}

/**
 * A standalone daemon stores its own choice. An installation daemon's copy only mirrors the
 * coordinator, so a change there must match the coordinator's current answer.
 */
export function assertTimeZoneProjection(input: {
  current: MutableDaemonConfig;
  patch: MutableDaemonConfigPatch;
  admission?: InstallationSettingsAdmission;
}): void {
  const { current, patch, admission } = input;
  assertKnownTimeZones(patch.timeZone);
  if (!current.sharedProviderPreferences?.installation || !changesTimeZone(current, patch)) return;
  if (
    !admission ||
    !isDeepStrictEqual(
      pickTimeZone(patch.timeZone!),
      admission.settings.timeZone ?? UNSET_TIME_ZONE,
    )
  )
    throw new InstallationSettingsAdmissionError(
      "Change the time zone in the installation's General settings.",
    );
}
