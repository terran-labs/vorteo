import { isDeepStrictEqual } from "node:util";
import type {
  DaemonPrimaryConnection,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import {
  primaryConnectionBinding,
  type InstallationSettings,
} from "@getpaseo/protocol/installation-settings";
import {
  InstallationSettingsAdmissionError,
  type InstallationSettingsAdmission,
} from "./admission.js";

/**
 * The daemon's copy of the installation's primary connection, named by the provider id it has
 * in that environment. Null when none is chosen, or when the connection is not bound or is
 * excluded there, so system threads in that environment wait instead of guessing.
 */
export function localPrimaryConnection(
  settings: InstallationSettings,
  serverId: string,
): DaemonPrimaryConnection | null {
  const definition = primaryConnectionBinding(settings, serverId);
  if (!definition) return null;
  if (settings.resourceExclusions[serverId]?.providerIds?.includes(definition.id)) return null;
  const profileId = settings.primaryConnection?.profileId;
  return { provider: definition.bindings[serverId]!, ...(profileId ? { profileId } : {}) };
}

export function changesPrimaryConnectionCopy(
  current: MutableDaemonConfig,
  patch: MutableDaemonConfigPatch,
): boolean {
  return (
    (patch.installationPrimaryConnection !== undefined &&
      !isDeepStrictEqual(
        patch.installationPrimaryConnection,
        current.installationPrimaryConnection ?? null,
      )) ||
    (patch.installationPrimaryConnectionSupported !== undefined &&
      patch.installationPrimaryConnectionSupported !==
        (current.installationPrimaryConnectionSupported ?? false))
  );
}

/**
 * The support marker a write should leave, or undefined to leave it alone. A fresh admission
 * answer decides it: only coordinators that own the setting answer with the key. A projection
 * without the marker comes from an older coordinator, which clears it. Clearing never grants
 * authority, so it needs no admission; transport failures never reach here and keep it.
 */
export function reconciledSupportMarker(
  current: MutableDaemonConfig,
  patch: MutableDaemonConfigPatch,
  admission?: InstallationSettingsAdmission,
): boolean | undefined {
  if (!current.sharedProviderPreferences?.installation) return undefined;
  const known = current.installationPrimaryConnectionSupported ?? false;
  if (admission) {
    const supported = admission.settings.primaryConnection !== undefined;
    return supported === known ? undefined : supported;
  }
  const projection = patch.expectedInstallationResourceRevision !== undefined;
  return projection && patch.installationPrimaryConnectionSupported === undefined && known
    ? false
    : undefined;
}

/**
 * An installation daemon's copy only mirrors the coordinator, and its own standalone choice is
 * closed while the installation owns the setting.
 */
export function assertPrimaryConnectionProjection(input: {
  current: MutableDaemonConfig;
  patch: MutableDaemonConfigPatch;
  admission?: InstallationSettingsAdmission;
}): void {
  const { current, patch, admission } = input;
  if (
    current.sharedProviderPreferences?.installation &&
    patch.primaryConnection !== undefined &&
    !isDeepStrictEqual(patch.primaryConnection, current.primaryConnection ?? null)
  )
    throw new InstallationSettingsAdmissionError(
      "Choose the primary connection in the installation's Providers settings.",
    );
  if (!changesPrimaryConnectionCopy(current, patch)) return;
  // Only a coordinator that owns the setting answers admission with the key, even when unset.
  const supported = admission?.settings.primaryConnection !== undefined;
  const copyMatches =
    patch.installationPrimaryConnection === undefined ||
    isDeepStrictEqual(
      patch.installationPrimaryConnection,
      admission ? localPrimaryConnection(admission.settings, admission.serverId) : null,
    );
  const markerMatches =
    patch.installationPrimaryConnectionSupported === undefined ||
    patch.installationPrimaryConnectionSupported === supported;
  if (!admission || !copyMatches || !markerMatches)
    throw new InstallationSettingsAdmissionError(
      "The primary connection must be chosen through the installation coordinator.",
    );
}
