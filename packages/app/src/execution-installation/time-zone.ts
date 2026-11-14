import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  effectiveTimeZone,
  type InstallationSettingsSnapshot,
  type InstallationTimeZone,
} from "@getpaseo/protocol/installation-settings";
import { useHostFeature } from "@/runtime/host-features";
import { useOwnerAccess } from "./owner-access";
import { installationHostServerId, readExecutionInstallation } from "./policy";
import {
  InstallationSettingsConflictError,
  requestInstallationSettings,
  useInstallationSettings,
} from "./settings";

/** The zone this browser reports, or null where the runtime cannot tell. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// Used only where Intl.supportedValuesOf is missing, such as older Hermes builds.
const FALLBACK_ZONES = [
  "UTC",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Halifax",
  "America/Sao_Paulo",
  "Atlantic/Azores",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Athens",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** IANA zones the owner can choose from, including the browser's own and the saved choice. */
export function timeZoneChoices(...extra: (string | null | undefined)[]): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }
  ).supportedValuesOf?.("timeZone");
  const zones = new Set(supported?.length ? supported : FALLBACK_ZONES);
  for (const zone of extra) if (zone) zones.add(zone);
  return [...zones].sort();
}

/** Repeats `change` against fresh settings when another owner saved first. */
async function writeTimeZone(
  change: (current: InstallationTimeZone) => InstallationTimeZone | null,
): Promise<InstallationSettingsSnapshot | null> {
  for (let attempt = 1; ; attempt += 1) {
    const snapshot = await requestInstallationSettings();
    const current = snapshot.settings?.timeZone;
    if (!current) return null;
    const next = change(current);
    if (!next) return snapshot;
    try {
      return await requestInstallationSettings({
        expectedRevision: snapshot.revision,
        settings: { timeZone: next },
      });
    } catch (failure) {
      if (!(failure instanceof InstallationSettingsConflictError) || attempt >= 2) throw failure;
    }
  }
}

/**
 * The installation's time zone for Settings. `supported` needs the Host daemon's
 * timeZoneSetting and a coordinator that sends the key, so older installations show an
 * explanation instead of a control that could not save.
 */
export function useOwnerTimeZone() {
  const installation = readExecutionInstallation();
  const daemonSupports = useHostFeature(installationHostServerId(installation), "timeZoneSetting");
  const settings = useInstallationSettings(daemonSupports);
  const value = settings.data?.settings?.timeZone;
  const queryClient = useQueryClient();
  const installationId = installation?.installationId;
  const choose = useCallback(
    async (override: string | null) => {
      const saved = await writeTimeZone((current) => ({
        override,
        reported: current.reported ?? browserTimeZone(),
      }));
      if (saved) queryClient.setQueryData(["installation-settings", installationId], saved);
    },
    [queryClient, installationId],
  );
  return {
    supported: daemonSupports && value !== undefined,
    loaded: value !== undefined,
    value,
    effective: effectiveTimeZone(value),
    choose,
  };
}

/**
 * Reports this browser's zone once per page load while the owner is unlocked, so daemons know
 * the automatic zone when no client is connected. When owner clients in different zones are
 * open, the last one to load wins; an explicit choice overrides every report.
 */
export function BrowserTimeZoneReporter() {
  const installation = readExecutionInstallation();
  const owner = useOwnerAccess();
  const supported = useHostFeature(installationHostServerId(installation), "timeZoneSetting");
  const reported = useRef(false);
  const ready = installation !== null && owner.status === "unlocked" && supported;
  useEffect(() => {
    if (!ready || reported.current) return;
    const zone = browserTimeZone();
    if (!zone) return;
    reported.current = true;
    void writeTimeZone((current) =>
      current.reported === zone ? null : { override: current.override, reported: zone },
    ).catch(() => {
      // A later page load reports again; the setting is advisory, so failures stay quiet.
      reported.current = false;
    });
  }, [ready]);
  return null;
}
