import { useCallback } from "react";
import { readExecutionInstallation } from "@/execution-installation/policy";
import type { PrimaryConnectionChoice } from "@/execution-installation/primary-connection";
import { useHostFeature } from "@/runtime/host-features";
import { useDaemonConfig } from "./use-daemon-config";

/**
 * A standalone daemon's primary connection, kept in its own config. An installation chooses
 * centrally, so `supported` is false for its environments and their pages show nothing.
 * `primary` is undefined while loading or not chosen yet, and null when the owner has to choose.
 */
export function useDaemonPrimaryConnection(serverId: string | null) {
  const managed = Boolean(
    readExecutionInstallation()?.environments.some(
      (environment) => environment.serverId === serverId,
    ),
  );
  const supported = useHostFeature(serverId, "primaryConnectionSetting") && !managed;
  const { config, patchConfig } = useDaemonConfig(supported ? serverId : null);
  // On a standalone daemon the choice's providerId is the daemon's own provider id.
  const choose = useCallback(
    async (choice: PrimaryConnectionChoice) => {
      const saved = await patchConfig({
        primaryConnection: {
          provider: choice.providerId,
          ...(choice.profileId ? { profileId: choice.profileId } : {}),
        },
      });
      if (!saved) throw new Error("Reconnect to the host and try again.");
      return saved;
    },
    [patchConfig],
  );
  return {
    supported,
    loaded: Boolean(supported && config),
    primary: config?.primaryConnection,
    choose,
  };
}
