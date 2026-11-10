import { useCallback, useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQueries } from "@/data/query";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { requestProviderSuggestions, type ProviderSuggestions } from "./suggestions";

type SuggestionsResponse = Awaited<ReturnType<DaemonClient["listProjectSuggestions"]>>;

// History changes slowly. Opening the step still re-asks, keeping the rows already shown.
const SUGGESTIONS_STALE_TIME_MS = 5 * 60 * 1000;

export type ProjectSuggestionsState =
  | { status: "unsupported" }
  /** The provider list itself has not arrived yet. */
  | { status: "loading" }
  | {
      status: "ready";
      providers: ProviderSuggestions[];
      failedProviders: string[];
      retryingProviders: string[];
      retryProvider: (provider: string) => void;
    };

/** Stands in for a provider when the provider list itself could not be read. */
export const PROVIDER_LIST_FAILURE = "providers";

function suggestionsQueryKey(serverId: string, provider: string) {
  return ["project-suggestions", serverId, provider] as const;
}

/**
 * Asks the host for suggestions once per enabled provider, in parallel. The queries are shared, so
 * calling this early (when setup opens) means the Projects step usually finds them answered.
 */
export function useProviderSuggestions(serverId: string): ProjectSuggestionsState {
  const supported = useHostFeature(serverId, "projectSuggestions");
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const snapshot = useProvidersSnapshot(serverId, { enabled: supported });
  const { entries } = snapshot;
  const available = supported && snapshot.supportsSnapshot;
  const providers = useMemo(
    () => entries?.filter((entry) => entry.enabled !== false).map((entry) => entry.provider),
    [entries],
  );

  const results = useFetchQueries<SuggestionsResponse>(
    (available && providers ? providers : []).map((provider) => ({
      queryKey: suggestionsQueryKey(serverId, provider),
      dataShape: "value",
      enabled: Boolean(client) && isConnected,
      // Do not retry automatically; failed providers keep their own visible retry action.
      retry: false,
      staleTimeMs: SUGGESTIONS_STALE_TIME_MS,
      queryFn: () => {
        if (!client) throw new Error("Host disconnected");
        return requestProviderSuggestions({
          supported: available,
          provider,
          request: (options) => client.listProjectSuggestions(options),
        });
      },
    })),
  );

  const retryProvider = useCallback(
    (provider: string) => {
      if (!available) return;
      const index = providers?.indexOf(provider) ?? -1;
      if (index >= 0) void results[index]?.refetch();
      else void snapshot.refresh();
    },
    [available, providers, results, snapshot],
  );

  return useMemo((): ProjectSuggestionsState => {
    if (!available) return { status: "unsupported" };
    if (!providers) {
      if (snapshot.error)
        return {
          status: "ready",
          providers: [],
          failedProviders: [PROVIDER_LIST_FAILURE],
          retryingProviders: snapshot.isRefreshing ? [PROVIDER_LIST_FAILURE] : [],
          retryProvider,
        };
      return { status: "loading" };
    }
    return {
      status: "ready",
      retryingProviders: providers.filter((_, index) => results[index]?.isFetching),
      failedProviders: providers.filter((provider, index) => {
        const result = results[index];
        return Boolean(
          result?.error ||
          result?.data?.providerErrors.some((error) => error.provider === provider),
        );
      }),
      retryProvider,
      providers: providers.map((provider, index) =>
        toProviderSuggestions(provider, results[index]),
      ),
    };
  }, [available, providers, results, snapshot.error, snapshot.isRefreshing, retryProvider]);
}

function toProviderSuggestions(
  provider: string,
  result: { data?: SuggestionsResponse; error: Error | null; isFetching: boolean } | undefined,
): ProviderSuggestions {
  if (result?.data) {
    return { provider, status: "answered", suggestions: result.data.suggestions };
  }
  if (result?.error && !result.isFetching) {
    return { provider, status: "answered", suggestions: [] };
  }
  return { provider, status: "loading" };
}
