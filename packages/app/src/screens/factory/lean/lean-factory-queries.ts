import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveProviderType } from "@getpaseo/protocol/provider-preferences";
import { builderProviderOptions } from "./lean-config-model";
import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import type { FactoryInvoke } from "../queue";
import {
  FACTORY_LEAN_FEATURE,
  createLeanSource,
  isLeanFactory,
  leanQueryKeys,
} from "./lean-factory-source";

/** The lean gate for one host's project, read from the host's advertised features. */
export function useIsLeanFactory(
  serverId: string,
  state: Pick<ProjectFactoryState, "mode"> | undefined,
): boolean {
  const advertised = useHostFeature(serverId, FACTORY_LEAN_FEATURE);
  return isLeanFactory({ [FACTORY_LEAN_FEATURE]: advertised }, state);
}

/** Status and view reads, which cost GitHub reads on the primary, so they poll slowly. */
const LEAN_POLL_MS = 60_000;

/**
 * A lean Factory's status and view for one project. Reads only when `enabled` (the lean gate
 * passed and the surface is visible); polls only when `polling`. Null until read or on failure.
 */
export function useLeanFactoryReads(input: {
  serverId: string;
  projectId: string;
  invoke: FactoryInvoke | undefined;
  enabled: boolean;
  polling: boolean;
}) {
  const { serverId, projectId, invoke, enabled, polling } = input;
  const source = useMemo(
    () => (invoke ? createLeanSource(invoke, projectId) : null),
    [invoke, projectId],
  );
  const live = enabled && source !== null;
  const status = useFetchQuery({
    dataShape: "value",
    queryKey: leanQueryKeys.status(serverId, projectId),
    staleTimeMs: 30_000,
    enabled: live,
    refetchInterval: live && polling ? LEAN_POLL_MS : false,
    queryFn: () => source!.status(),
  });
  const view = useFetchQuery({
    dataShape: "value",
    queryKey: leanQueryKeys.view(serverId, projectId),
    staleTimeMs: 30_000,
    enabled: live,
    refetchInterval: live && polling ? LEAN_POLL_MS : false,
    queryFn: () => source!.view(),
  });
  return {
    source,
    status: status.data ?? null,
    view: view.data ?? null,
    /** The view's read error, already one line; the overview shows it with Retry. */
    error: view.error ?? null,
    retry: view.refetch,
  };
}

/** The newest activity entries, read while the overview is visible. */
export function useLeanActivity(input: {
  serverId: string;
  projectId: string;
  invoke: FactoryInvoke | undefined;
  enabled: boolean;
}) {
  const { serverId, projectId, invoke, enabled } = input;
  const live = enabled && invoke !== undefined;
  const activity = useFetchQuery({
    dataShape: "value",
    queryKey: leanQueryKeys.activity(serverId, projectId),
    staleTimeMs: 30_000,
    enabled: live,
    refetchInterval: live ? LEAN_POLL_MS : false,
    queryFn: () => createLeanSource(invoke!, projectId).activity(),
  });
  return activity.data?.entries ?? [];
}

/** The repository's Factory config file and the installations it may name. */
export function useLeanConfig(input: {
  serverId: string;
  projectId: string;
  invoke: FactoryInvoke | undefined;
  enabled: boolean;
}) {
  const { serverId, projectId, invoke, enabled } = input;
  const source = useMemo(
    () => (invoke ? createLeanSource(invoke, projectId) : null),
    [invoke, projectId],
  );
  const config = useFetchQuery({
    dataShape: "value",
    queryKey: leanQueryKeys.config(serverId, projectId),
    staleTimeMs: 30_000,
    enabled: enabled && source !== null,
    queryFn: () => source!.config(),
  });
  return { source, config: config.data ?? null, error: config.error, reload: config.refetch };
}

/** Builder provider choices from the provider types this installation has enabled. */
export function useBuilderProviderOptions(
  serverId: string,
  current: string | null,
  /** Given entries replace the host's snapshot, as on the demo page; the host is not read. */
  given?: readonly { provider: string; enabled: boolean }[],
) {
  const { entries } = useProvidersSnapshot(given ? null : serverId, { cwd: null });
  const { config } = useDaemonConfig(given ? null : serverId);
  return useMemo(
    () =>
      builderProviderOptions({
        entries: given ?? entries ?? [],
        resolveType: (provider) => resolveProviderType(provider, config?.providers ?? {}),
        current,
      }),
    [config, current, entries, given],
  );
}
