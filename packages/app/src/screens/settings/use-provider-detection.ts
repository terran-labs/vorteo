import { useMemo, useRef } from "react";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { ProviderDetectionSource } from "./shared-providers-model";

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
