import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { hostSupportsFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";
import { syncPluginCatalog } from "./catalog-sync-model";

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const audio = useVoiceAudioEngineOptional();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore((state) => {
    const serverInfo = state.sessions[serverId]?.serverInfo;
    return serverInfo ? hostSupportsFeature(serverInfo, "plugins") : null;
  });

  useEffect(
    () =>
      syncPluginCatalog({
        serverId,
        client,
        audio,
        connected,
        supported,
        registry: pluginRegistry,
      }),
    [audio, client, connected, serverId, supported],
  );

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
