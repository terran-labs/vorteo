import { useMemo, useRef } from "react";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ProviderDetectionSource, SignInSource } from "./shared-providers-model";

/**
 * Host and Dev provider snapshots for the shared catalog's default rule. The snapshots are
 * pushed when a daemon re-checks its providers, so detection follows them without polling.
 */
export function useProviderDetection(
  environments: readonly InstallationEnvironment[],
): ProviderDetectionSource[] {
  const hostId = environments.find((environment) => environment.kind === "host")?.serverId ?? null;
  const devId =
    environments.find((environment) => environment.kind === "container")?.serverId ?? null;
  const { entries: hostEntries, isLoading: hostLoading } = useProvidersSnapshot(hostId);
  const { entries: devEntries, isLoading: devLoading } = useProvidersSnapshot(devId);
  const previous = useRef(new Map<string, ProviderDetectionSource["entries"]>());
  if (hostId && hostEntries) previous.current.set(hostId, hostEntries);
  if (devId && devEntries) previous.current.set(devId, devEntries);
  const knownHost = hostEntries ?? (hostId ? previous.current.get(hostId) : undefined);
  const knownDev = devEntries ?? (devId ? previous.current.get(devId) : undefined);
  return useMemo(() => {
    const sources: ProviderDetectionSource[] = [];
    // An environment that is offline reports nothing; leave it out rather than wait for it.
    if (hostId && (knownHost || hostLoading))
      sources.push({ serverId: hostId, kind: "host", entries: knownHost });
    if (devId && (knownDev || devLoading))
      sources.push({ serverId: devId, kind: "container", entries: knownDev });
    return sources;
  }, [hostId, devId, knownHost, hostLoading, knownDev, devLoading]);
}

function useSignInSource(environment: InstallationEnvironment | undefined): SignInSource | null {
  const serverId = environment?.serverId ?? null;
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const { config } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const { view } = useProviderUsage(serverId, { enabled: Boolean(serverId && connected) });
  const usage = view.kind === "ready" ? view.payload.providers : undefined;
  return useMemo<SignInSource | null>(
    () =>
      environment && connected
        ? {
            serverId: environment.serverId,
            kind: environment.kind === "host" ? "host" : "container",
            providers: config?.providers,
            entries,
            usage,
          }
        : null,
    [environment, connected, config?.providers, entries, usage],
  );
}

/**
 * Host and Dev views that tell which shared connections are signed out or expired. Offline
 * environments are left out, so a disconnected Dev container never reports a false sign-in.
 */
export function useSignInSources(environments: readonly InstallationEnvironment[]): SignInSource[] {
  const host = useSignInSource(environments.find((environment) => environment.kind === "host"));
  const dev = useSignInSource(environments.find((environment) => environment.kind === "container"));
  return useMemo(
    () => [host, dev].filter((source): source is SignInSource => source !== null),
    [host, dev],
  );
}
