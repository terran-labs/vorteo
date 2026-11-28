import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  primaryConnectionBinding,
  type InstallationPrimaryConnection,
  type InstallationSettingsSnapshot,
  type InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { AutomaticPrimary } from "@getpaseo/protocol/messages";
import { useHostFeature } from "@/runtime/host-features";
import { providerUsageQueryKey, useProviderUsage } from "@/provider-usage/use-provider-usage";
import { installationHostServerId, readExecutionInstallation } from "./policy";
import { PrimaryConnectionUnavailableError } from "./primary-connection-error";
import {
  InstallationSettingsConflictError,
  requestInstallationSettings,
  useInstallationSettings,
} from "./settings";

export { PrimaryConnectionUnavailableError };

export type PrimaryConnectionChoice = InstallationPrimaryConnection;

/** Choosing no connection, so system threads use Automatic. */
export const AUTOMATIC_PRIMARY = "automatic";

/** The update that makes `choice` the installation's primary connection; Automatic is null. */
export function primaryConnectionUpdate(
  snapshot: Pick<InstallationSettingsSnapshot, "revision">,
  choice: PrimaryConnectionChoice | typeof AUTOMATIC_PRIMARY,
): InstallationSettingsUpdate {
  const primaryConnection =
    choice === AUTOMATIC_PRIMARY
      ? null
      : {
          providerId: choice.providerId,
          ...(choice.profileId ? { profileId: choice.profileId } : {}),
        };
  return { expectedRevision: snapshot.revision, settings: { primaryConnection } };
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
 * not already primary, it is on, and it is signed in and ready where the Optimizer runs. That is
 * the Host when the row reports one, because a primary that is missing, excluded or signed out
 * there would leave the Optimizer waiting; otherwise any environment.
 */
export function canMakePrimary(input: {
  primary: boolean | null;
  enabled: boolean;
  states: readonly { kind: string; environment?: { kind: string } }[];
}): boolean {
  if (input.primary !== false || !input.enabled) return false;
  const host = input.states.find((state) => state.environment?.kind === "host");
  return host ? host.kind === "ready" : input.states.some((state) => state.kind === "ready");
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
 * Choosing Automatic asks first, since it can move system threads to another account, then saves
 * and reports the result as a toast. Returns true when Automatic is the choice.
 */
export async function confirmAutomaticPrimary(input: {
  copy: { title: string; message: string; confirmLabel: string; saved: string };
  confirm(dialog: { title: string; message: string; confirmLabel: string }): Promise<boolean>;
  choose(choice: typeof AUTOMATIC_PRIMARY): Promise<unknown>;
  toast: { show(message: string): void; error(message: string): void };
  describeError(failure: unknown): string;
}): Promise<boolean> {
  const { title, message, confirmLabel, saved } = input.copy;
  if (!(await input.confirm({ title, message, confirmLabel }))) return false;
  try {
    await input.choose(AUTOMATIC_PRIMARY);
  } catch (failure) {
    input.toast.error(input.describeError(failure));
    return false;
  }
  input.toast.show(saved);
  return true;
}

/**
 * Whether the primary connection can run system threads in every environment that runs them:
 * the Host for the Optimizer, plus each environment with a running Factory. Each environment
 * launches from its own copy of the choice, so the connection must be bound there, on, not
 * excluded, ready and not waiting for a sign-in in that environment's own usage reading.
 * "unknown" while a required environment is still checking or not reporting, so the Status row
 * never flickers on a slow first read.
 */
export function primaryConnectionAvailability(input: {
  primary: InstallationPrimaryConnection;
  definitions: readonly InstallationProvider[];
  /** Server ids of the environments that run system threads. */
  required: readonly string[];
  exclusions?: Readonly<Record<string, { providerIds?: readonly string[] }>>;
  sources: readonly {
    serverId: string;
    entries?: readonly { provider: string; status: string; enabled?: boolean }[];
  }[];
  /** Per server id, local provider ids whose usage reading there asks for a new sign-in. */
  signedOut?: ReadonlyMap<string, ReadonlySet<string>>;
}): "available" | "unavailable" | "unknown" {
  if (input.required.length === 0) return "unknown";
  let checking = false;
  for (const serverId of input.required) {
    const definition = primaryConnectionBinding(
      { primaryConnection: input.primary, providerDefinitions: [...input.definitions] },
      serverId,
    );
    if (
      !definition ||
      definition.policy.enabled === false ||
      input.exclusions?.[serverId]?.providerIds?.includes(definition.id)
    )
      return "unavailable";
    const source = input.sources.find((candidate) => candidate.serverId === serverId);
    if (!source?.entries) {
      checking = true;
      continue;
    }
    const localId = definition.bindings[serverId]!;
    const entry = source.entries.find((candidate) => candidate.provider === localId);
    if (entry?.status === "loading") {
      checking = true;
      continue;
    }
    if (
      entry?.status !== "ready" ||
      entry.enabled === false ||
      input.signedOut?.get(serverId)?.has(localId)
    )
      return "unavailable";
  }
  return checking ? "unknown" : "available";
}

/**
 * Turning off the primary connection asks first. Turning it off clears the choice: where
 * Automatic is supported system threads then use Automatic, otherwise they wait until the owner
 * chooses another.
 */
export function confirmDisablePrimary(
  name: string,
  confirm: (dialog: {
    title: string;
    message: string;
    confirmLabel: string;
    destructive?: boolean;
  }) => Promise<boolean>,
  automatic = false,
): Promise<boolean> {
  const next = automatic
    ? "will use Automatic instead."
    : "will wait until you choose another primary connection.";
  return confirm({
    title: `Turn off ${name}?`,
    message: `${name} is the primary connection. System threads, such as the Optimizer and Factory, ${next}`,
    confirmLabel: "Turn off",
    destructive: true,
  });
}

/** A fixed choice, Automatic, or one worked out from the exact settings snapshot about to be written. */
export type PrimaryConnectionInput =
  | PrimaryConnectionChoice
  | typeof AUTOMATIC_PRIMARY
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
 * What Automatic does on a daemon, from its usage list: `supported` once the daemon reports
 * Automatic's pick, which it does only where an unchosen primary means Automatic; `current` is
 * that pick, or null when no account can run system threads. Undefined until the list loads.
 */
export interface AutomaticPrimaryState {
  supported: boolean;
  current: AutomaticPrimary | null | undefined;
}

export function useAutomaticPrimary(
  serverId: string | null,
  enabled = true,
): AutomaticPrimaryState {
  const supportsFeature = useHostFeature(serverId, "primaryConnectionAutomatic");
  const { view } = useProviderUsage(serverId, { enabled: enabled && supportsFeature });
  const payload = view.kind === "ready" ? view.payload : null;
  const reported = payload !== null && payload.automaticPrimary !== undefined;
  return {
    supported: supportsFeature && reported,
    current: reported ? payload.automaticPrimary : undefined,
  };
}

/**
 * The installation's primary connection for Settings. `supported` needs both the Host daemon's
 * primaryConnectionSetting and a coordinator that owns the setting: only those send the key,
 * as null while nothing is chosen. An older coordinator would refuse the write, so its owners
 * see no control at all. `primary` is null or undefined while none is chosen, which means
 * Automatic where `automatic.supported` is true: the Host daemon only reports Automatic's pick
 * once its coordinator says so.
 */
export function usePrimaryConnection() {
  const installation = readExecutionInstallation();
  const hostId = installationHostServerId(installation);
  const daemonSupports = useHostFeature(hostId, "primaryConnectionSetting");
  const settings = useInstallationSettings(daemonSupports);
  const supported = daemonSupports && settings.data?.settings?.primaryConnection !== undefined;
  const automatic = useAutomaticPrimary(supported ? hostId : null);
  const queryClient = useQueryClient();
  const installationId = installation?.installationId;
  const choose = useCallback(
    async (choice: PrimaryConnectionChoice | typeof AUTOMATIC_PRIMARY) => {
      const saved = await recordPrimaryConnection(choice);
      queryClient.setQueryData(["installation-settings", installationId], saved);
      // Automatic's current pick is reported with usage; read it again for the new choice.
      void queryClient.invalidateQueries({ queryKey: providerUsageQueryKey(hostId) });
      return saved;
    },
    [queryClient, installationId, hostId],
  );
  const loaded = Boolean(supported && settings.data?.settings);
  return {
    supported,
    loaded,
    primary: settings.data?.settings?.primaryConnection,
    automatic,
    choose,
  };
}
