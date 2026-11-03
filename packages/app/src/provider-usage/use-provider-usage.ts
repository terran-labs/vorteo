import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { providerUsageCopy } from "./copy";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";

import { PROVIDER_USAGE_STALE_TIME_MS } from "./quota-reading";
import { retainLastKnownUsage } from "./usage-cache";
import { providerUsageView } from "./usage-view";
export { PROVIDER_USAGE_STALE_TIME_MS } from "./quota-reading";

type ProviderUsageClient = Pick<DaemonClient, "listProviderUsage">;

export function providerUsageQueryKey(serverId: string | null | undefined) {
  return ["providerUsage", serverId ?? ""] as const;
}

interface ProviderUsageFetch {
  client: ProviderUsageClient;
  queryClient: QueryClient;
  serverId: string | null | undefined;
  forceRefresh?: boolean;
}

async function fetchProviderUsage({
  client,
  queryClient,
  serverId,
  forceRefresh,
}: ProviderUsageFetch): Promise<ProviderUsageListPayload> {
  const next = await client.listProviderUsage(forceRefresh ? { forceRefresh } : undefined);
  return retainLastKnownUsage(
    next,
    queryClient.getQueryData<ProviderUsageListPayload>(providerUsageQueryKey(serverId)),
  );
}

/**
 * Replaces the cached reading with one the daemon reads fresh, bypassing its own cache. A
 * failure lands in the query state like any other refresh.
 */
export async function forceRefreshProviderUsage(
  input: Omit<ProviderUsageFetch, "forceRefresh">,
): Promise<void> {
  const queryKey = providerUsageQueryKey(input.serverId);
  // An in-flight ordinary read would otherwise be reused and return the daemon's cached reading.
  await input.queryClient.cancelQueries({ queryKey });
  await input.queryClient.prefetchQuery({
    queryKey,
    queryFn: () => fetchProviderUsage({ ...input, forceRefresh: true }),
    staleTime: 0,
  });
}

/** Refreshes usage past both caches, or does nothing when this host cannot list usage. */
export function useForceProviderUsageRefresh(serverId: string | null | undefined) {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  return useCallback(async () => {
    if (!serverId || !client || !isConnected || !supportsProviderUsage) return;
    await forceRefreshProviderUsage({ client, queryClient, serverId });
  }, [client, isConnected, queryClient, serverId, supportsProviderUsage]);
}

interface UseProviderUsageOptions {
  enabled?: boolean;
  refreshOnMount?: boolean;
  pollActivity?: boolean;
  pollUsage?: boolean;
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  refresh: () => Promise<void>;
  canFetch: boolean;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  const queryKey = useMemo(() => providerUsageQueryKey(serverId), [serverId]);
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);
  const enabled = Boolean((options.enabled ?? true) && canFetch);
  let refetchInterval: number | false = false;
  if (enabled && options.pollUsage) refetchInterval = 60_000;
  if (enabled && options.pollActivity) refetchInterval = 15_000;

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(providerUsageCopy.clientUnavailable);
    }
    return fetchProviderUsage({ client, queryClient, serverId });
  }, [client, queryClient, serverId]);

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: options.pollActivity ? 15_000 : PROVIDER_USAGE_STALE_TIME_MS,
    gcTime: Infinity,
    refetchOnMount: options.refreshOnMount ? "always" : true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
    refetchInterval,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) return;
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.fetchQuery({
      queryKey,
      queryFn,
      staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    });
  }, [canFetch, queryClient, queryFn, queryKey]);

  const view = useMemo(
    () =>
      providerUsageView({
        hasHost: Boolean(serverId),
        connected: Boolean(client && isConnected),
        supported: supportsProviderUsage,
        data: query.data,
        fetching: query.isFetching,
        error: query.isError ? query.error : undefined,
      }),
    [
      serverId,
      client,
      isConnected,
      supportsProviderUsage,
      query.data,
      query.isFetching,
      query.isError,
      query.error,
    ],
  );

  return { view, refresh, canFetch };
}
