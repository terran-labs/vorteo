import type { PreviewGallery, PreviewVersion, PreviewsAction } from "@getpaseo/protocol/previews";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { useReportActionError } from "@/hooks/use-action-error";
import {
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { resolveDaemonDownloadTarget } from "@/stores/download-store";
import { buildPairUrl, withRating } from "./model";
import { openBrowserLater } from "./open-browser";

export function previewsQueryKey(serverId: string, agentId: string) {
  return ["previews", serverId, agentId] as const;
}

export function usePreviewsSupported(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.previews === true,
  );
}

/**
 * The daemon's HTTP origin for thumbnails, snapshots and pairing. Only a direct TCP connection
 * has one; relay and local socket connections return null and the card shows placeholders.
 */
export function usePreviewsHttpBase(serverId: string): string | null {
  const hosts = useHosts();
  const activeConnectionId = useHostRuntimeSnapshot(serverId)?.activeConnectionId ?? null;
  return useMemo(() => {
    const profile = hosts.find((host) => host.serverId === serverId);
    return resolveDaemonDownloadTarget(profile, activeConnectionId)?.baseUrl ?? null;
  }, [activeConnectionId, hosts, serverId]);
}

/**
 * The previews of one thread's workspace. The daemon scopes the list to the workspace of
 * the thread that asks, so nothing from another workspace reaches the app. A `previews.changed` push
 * or a reconnect refetches it, and each action's response replaces it.
 */
export function usePreviewsGallery(serverId: string, agentId: string, enabled: boolean) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = previewsQueryKey(serverId, agentId);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey,
    enabled: enabled && connected && client !== null,
    queryFn: async (): Promise<PreviewGallery> => {
      if (!client) throw new Error("Reconnect to load previews.");
      return client.listPreviews(agentId);
    },
  });
  useEffect(() => {
    if (!enabled || !client || !connected) return;
    return client.on("previews.changed", ({ payload }) => {
      const key = previewsQueryKey(serverId, agentId);
      const current = queryClient.getQueryData<PreviewGallery>(key);
      if (current && current.revision >= payload.revision) return;
      void queryClient.invalidateQueries({ queryKey: key });
    });
  }, [agentId, client, connected, enabled, queryClient, serverId]);
  return query;
}

/**
 * Owner actions on the gallery. Ratings apply optimistically and roll back on failure; every
 * failure is reported as a toast, like the Open questions card.
 */
export function usePreviewsActions(serverId: string, agentId: string, httpBase: string | null) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const reportError = useReportActionError();
  const queryKey = useMemo(() => previewsQueryKey(serverId, agentId), [agentId, serverId]);

  const store = useCallback(
    (gallery: PreviewGallery) => {
      const current = queryClient.getQueryData<PreviewGallery>(queryKey);
      if (!current || gallery.revision >= current.revision)
        queryClient.setQueryData(queryKey, gallery);
    },
    [queryClient, queryKey],
  );

  const mutation = useMutation({
    mutationFn: async (action: PreviewsAction) => {
      if (!client || !connected) throw new Error("Reconnect to change previews.");
      return client.previewsAction(action, agentId);
    },
    onMutate: async (action) => {
      if (action.kind !== "rate") return { previous: undefined };
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<PreviewGallery>(queryKey);
      if (previous)
        queryClient.setQueryData(queryKey, withRating(previous, action.versionId, action.rating));
      return { previous };
    },
    onSuccess: (result) => store(result.gallery),
    onError: (error, _action, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      reportError(error);
    },
    retry: false,
  });

  const { mutate } = mutation;
  const openInBrowser = useCallback(
    (version: PreviewVersion) => {
      if (!client || !connected || !httpBase) {
        reportError(new Error("Opening previews needs a direct connection to this host."));
        return;
      }
      // Open the tab during the tap, before the ticket round trip spends the user activation.
      const target = openBrowserLater();
      client
        .previewsAction({ kind: "ticket" }, agentId)
        .then(({ ticket }) => {
          if (!ticket) throw new Error("The host did not issue a browser ticket.");
          return target.go(buildPairUrl(httpBase, ticket, version));
        })
        .catch((error: unknown) => {
          target.cancel();
          reportError(error);
        });
    },
    [agentId, client, connected, httpBase, reportError],
  );

  const pendingKind = mutation.isPending ? mutation.variables?.kind : undefined;
  return {
    canAct: connected && client !== null,
    pending: mutation.isPending,
    pendingKind,
    act: mutate,
    openInBrowser,
  };
}

export type PreviewsActions = ReturnType<typeof usePreviewsActions>;
