import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  primaryConnectionBinding,
  type InstallationPrimaryConnection,
  type InstallationSettingsSnapshot,
  type InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { useHostFeature } from "@/runtime/host-features";
import { installationHostServerId, readExecutionInstallation } from "./policy";
import { PrimaryConnectionUnavailableError } from "./primary-connection-error";
import {
  InstallationSettingsConflictError,
  requestInstallationSettings,
  useInstallationSettings,
} from "./settings";

export { PrimaryConnectionUnavailableError };

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
 * Whether the primary connection can run system threads anywhere: on in the catalog, ready in
 * an environment that binds it, and not waiting for a sign-in. "unknown" while an environment
 * that binds it is still checking, so the Status row never flickers on a slow first read.
 */
export function primaryConnectionAvailability(input: {
  primary: InstallationPrimaryConnection;
  definitions: readonly InstallationProvider[];
  sources: readonly {
    serverId: string;
    entries: readonly { provider: string; status: string; enabled?: boolean }[] | undefined;
  }[];
  /** Local provider ids whose usage reading asks for a new sign-in. */
  signedOut?: ReadonlySet<string>;
}): "available" | "unavailable" | "unknown" {
  let checking = false;
  for (const source of input.sources) {
    const definition = primaryConnectionBinding(
      { primaryConnection: input.primary, providerDefinitions: [...input.definitions] },
      source.serverId,
    );
    if (!definition || definition.policy.enabled === false) continue;
    const localId = definition.bindings[source.serverId]!;
    if (!source.entries) {
      checking = true;
      continue;
    }
    const entry = source.entries.find((candidate) => candidate.provider === localId);
    if (entry?.status === "loading") checking = true;
    if (entry?.status === "ready" && entry.enabled !== false && !input.signedOut?.has(localId))
      return "available";
  }
  return checking ? "unknown" : "unavailable";
}

/**
 * Turning off the primary connection asks first: system threads then wait until the owner
 * chooses another, because Vorteo never picks one for them.
 */
export function confirmDisablePrimary(
  name: string,
  confirm: (dialog: {
    title: string;
    message: string;
    confirmLabel: string;
    destructive?: boolean;
  }) => Promise<boolean>,
): Promise<boolean> {
  return confirm({
    title: `Turn off ${name}?`,
    message: `${name} is the primary connection. System threads, such as the Optimizer and Factory, will wait until you choose another primary connection.`,
    confirmLabel: "Turn off",
    destructive: true,
  });
}

/** A fixed choice, or one worked out from the exact settings snapshot about to be written. */
export type PrimaryConnectionInput =
  | PrimaryConnectionChoice
  | ((snapshot: InstallationSettingsSnapshot) => PrimaryConnectionChoice | null);

/**
 * Records the setup guide's single connection as the installation's primary connection.
 * A resolver runs against the snapshot that is read, and the write carries that snapshot's
 * revision, so a choice is never saved against settings it was not made from. When another
 * owner saves first, it reads again, resolves again and retries once. A resolver returning
 * null, or the server refusing a removed or turned off connection, rejects with
 * PrimaryConnectionUnavailableError and writes nothing. Requires unlocked Installation
 * controls, like every shared settings write.
 */
export async function recordPrimaryConnection(input: PrimaryConnectionInput) {
  for (let attempt = 1; ; attempt += 1) {
    const current = await requestInstallationSettings();
    if (!current.settings)
      throw new Error("Shared settings are still being set up. Try again in a moment.");
    const choice = typeof input === "function" ? input(current) : input;
    if (!choice) throw new PrimaryConnectionUnavailableError();
    try {
      return await requestInstallationSettings(primaryConnectionUpdate(current, choice));
    } catch (failure) {
      if (!(failure instanceof InstallationSettingsConflictError) || attempt >= 2) throw failure;
    }
  }
}

/**
 * The installation's primary connection for Settings. `supported` needs both the Host daemon's
 * primaryConnectionSetting and a coordinator that owns the setting: only those send the key,
 * as null while nothing is chosen. An older coordinator would refuse the write, so its owners
 * see no control at all. `primary` is null or undefined while none is chosen.
 */
export function usePrimaryConnection() {
  const installation = readExecutionInstallation();
  const daemonSupports = useHostFeature(
    installationHostServerId(installation),
    "primaryConnectionSetting",
  );
  const settings = useInstallationSettings(daemonSupports);
  const supported = daemonSupports && settings.data?.settings?.primaryConnection !== undefined;
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
