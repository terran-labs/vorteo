import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  InstallationPrimaryConnection,
  InstallationSettingsSnapshot,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { useHostFeature } from "@/runtime/host-features";
import { installationHostServerId, readExecutionInstallation } from "./policy";
import { requestInstallationSettings, useInstallationSettings } from "./settings";

export type PrimaryConnectionChoice = InstallationPrimaryConnection;

/** The update that makes `choice` the installation's primary connection. */
export function primaryConnectionUpdate(
  snapshot: Pick<InstallationSettingsSnapshot, "revision">,
  choice: PrimaryConnectionChoice,
): InstallationSettingsUpdate {
  return {
    expectedRevision: snapshot.revision,
    settings: {
      primaryConnection: {
        providerId: choice.providerId,
        ...(choice.profileId ? { profileId: choice.profileId } : {}),
      },
    },
  };
}

/** Whether a connection, given as the definitions it groups, is the primary connection. */
export function isPrimaryConnection(
  primary: InstallationPrimaryConnection | null | undefined,
  definitions: readonly Pick<InstallationProvider, "id">[],
): boolean {
  return Boolean(primary && definitions.some((entry) => entry.id === primary.providerId));
}

/**
 * Whether a connection row offers Make primary: the setting is available, the connection is
 * not already primary, it is on, and it is signed in and ready in at least one environment.
 */
export function canMakePrimary(input: {
  primary: boolean | null;
  enabled: boolean;
  states: readonly { kind: string }[];
}): boolean {
  return (
    input.primary === false && input.enabled && input.states.some((state) => state.kind === "ready")
  );
}

/**
 * The deliberate Make primary action: confirm first, then save and report the result as a
 * toast. Returns true when the connection became primary.
 */
export async function confirmPrimaryConnection(input: {
  name: string;
  providerId: string;
  confirm(dialog: { title: string; message: string; confirmLabel: string }): Promise<boolean>;
  choose(choice: PrimaryConnectionChoice): Promise<unknown>;
  toast: { show(message: string): void; error(message: string): void };
  describeError(failure: unknown): string;
}): Promise<boolean> {
  const confirmed = await input.confirm({
    title: `Make ${input.name} the primary connection?`,
    message:
      "System threads, such as the Optimizer and Factory, use it from their next start. Threads that are running keep their current connection.",
    confirmLabel: "Make primary",
  });
  if (!confirmed) return false;
  try {
    await input.choose({ providerId: input.providerId });
  } catch (failure) {
    input.toast.error(input.describeError(failure));
    return false;
  }
  input.toast.show(`${input.name} is now the primary connection.`);
  return true;
}

/**
 * Records the setup guide's single connection as the installation's primary connection.
 * Reads the current revision first, so it never overwrites a newer owner change silently:
 * a concurrent edit makes the write fail with the usual "Shared settings changed" error.
 * Requires unlocked Installation controls, like every shared settings write.
 */
export async function recordPrimaryConnection(choice: PrimaryConnectionChoice) {
  const current = await requestInstallationSettings();
  if (!current.settings)
    throw new Error("Shared settings are still being set up. Try again in a moment.");
  return requestInstallationSettings(primaryConnectionUpdate(current, choice));
}

/**
 * The installation's primary connection for Settings. `supported` is false until the Host
 * reports the setting, so older installations never see a control they cannot save.
 * `primary` is undefined while loading or not chosen yet, and null when the owner has to choose.
 */
export function usePrimaryConnection() {
  const installation = readExecutionInstallation();
  const supported = useHostFeature(
    installationHostServerId(installation),
    "primaryConnectionSetting",
  );
  const settings = useInstallationSettings(supported);
  const queryClient = useQueryClient();
  const installationId = installation?.installationId;
  const choose = useCallback(
    async (choice: PrimaryConnectionChoice) => {
      const saved = await recordPrimaryConnection(choice);
      queryClient.setQueryData(["installation-settings", installationId], saved);
      return saved;
    },
    [queryClient, installationId],
  );
  const loaded = Boolean(supported && settings.data?.settings);
  return {
    supported,
    loaded,
    primary: settings.data?.settings?.primaryConnection,
    choose,
  };
}
