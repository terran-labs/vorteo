import { useCallback, useEffect, useMemo, useRef } from "react";
import * as Clipboard from "expo-clipboard";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useToast } from "@/contexts/toast-context";
import {
  resolveWorkspaceScriptLink,
  type WorkspaceScriptLinkKind,
  type WorkspaceScriptLinkTarget,
} from "@/utils/workspace-script-links";
import { useWorkspaceServiceRoutePreferencesStore } from "@/workspace-service-routes/store";

type WorkspaceScript = WorkspaceDescriptor["scripts"][number];

export interface WorkspaceScriptLinks {
  /** The URL this host's route preference picks, or null when the script serves none. */
  selected: WorkspaceScriptLinkTarget | null;
  targets: WorkspaceScriptLinkTarget[];
}

export interface WorkspaceScriptActions {
  start: (scriptName: string) => void;
  stop: (scriptName: string) => void;
  /**
   * Stops the script, then starts it again once the daemon reports it stopped. A managed
   * preview restarts through the preview broker instead, after asking, so its link stays.
   */
  restart: (scriptName: string) => void;
  /** Whether this script's Run and Restart go through the preview broker. */
  isManagedPreview: (script: WorkspaceScript) => boolean;
  copyUrl: (target: WorkspaceScriptLinkTarget) => void;
  selectRoute: (kind: WorkspaceScriptLinkKind) => void;
  resolveLinks: (script: WorkspaceScript) => WorkspaceScriptLinks;
  isStartPending: boolean;
  /** A preview start or restart request is in flight; Restart waits for it. */
  isPreviewPending: boolean;
  /** Whether this preview's own start, restart or stop request is still being sent. */
  isPreviewPendingFor: (scriptName: string) => boolean;
  isStopPending: boolean;
  /** Whether this script's own terminal stop is still being sent. */
  isStopPendingFor: (scriptName: string) => boolean;
}

export interface UseWorkspaceScriptActionsInput {
  serverId: string;
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  onScriptTerminalStarted?: (terminalId: string) => void;
}

/**
 * Run, stop, restart and URL handling for a workspace's scripts, shared by every surface that
 * lists them.
 *
 * A restart outlives the press that asked for it — the second half waits for the daemon to
 * report the script stopped — so mount this with whatever owns the menu, not inside a menu page
 * that unmounts when the menu closes.
 */
export function useWorkspaceScriptActions({
  serverId,
  workspaceId,
  scripts,
  onScriptTerminalStarted,
}: UseWorkspaceScriptActionsInput): WorkspaceScriptActions {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const activeConnection = useHostRuntimeSnapshot(serverId)?.activeConnection ?? null;
  const preferredRouteKind = useWorkspaceServiceRoutePreferencesStore(
    (state) => state.byServerId[serverId] ?? null,
  );
  const setPreferredRoute = useWorkspaceServiceRoutePreferencesStore(
    (state) => state.setPreferredRoute,
  );
  const pendingRestartRef = useRef<Set<string>>(new Set());
  const previewRestartSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.previewRestart === true,
  );
  // A daemon that can stop previews through the broker records an owner's stop as a stop.
  // It must also name each outcome's mode: one with previewStop alone reports a failed stop
  // like a failed start, so the app keeps the terminal stop there.
  const previewStopSupported = useSessionStore((state) => {
    const features = state.sessions[serverId]?.serverInfo?.features;
    return features?.previewStop === true && features?.previewStopOutcome === true;
  });
  // Named by the host's own label, so the refusal is true for Host and Dev workspaces alike.
  const hostLabel = useHosts().find((host) => host.serverId === serverId)?.label ?? null;
  const isManagedPreview = useCallback(
    (script: WorkspaceScript) =>
      previewRestartSupported && script.type === "service" && script.preview !== undefined,
    [previewRestartSupported],
  );

  // A reserved preview starts through the broker, so the link stays the same and the broker
  // records the start; a plain start would bring the server up with its link still withdrawn.
  const previewMutation = useMutation({
    mutationFn: async (input: { scriptName: string; mode: "start" | "restart" | "stop" }) => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      const result = await client.restartWorkspaceScriptPreview(
        workspaceId,
        input.scriptName,
        input.mode,
      );
      if (!result.accepted) throw new Error(previewRefusal(result.refusalCode, result.error));
      return result;
    },
    onError: (error) => {
      toast.show(error instanceof Error ? error.message : t("previewStatus.refusals.failed"), {
        variant: "error",
      });
    },
  });
  const previewRefusal = (code: string | null | undefined, error: string | null): string => {
    switch (code) {
      case "busy":
        return t("previewStatus.refusals.busy");
      case "capacity":
        return t("previewStatus.refusals.capacity");
      case "workspace_unavailable":
        return t("previewStatus.refusals.archived");
      case "needs_review":
        return t("previewStatus.refusals.needsReview");
      case "owner_app_only":
        return hostLabel
          ? t("previewStatus.refusals.ownerAppOnly", { host: hostLabel })
          : t("previewStatus.refusals.ownerAppOnlyUnnamed");
      case "broker_unavailable":
      case "no_reservation":
        return t("previewStatus.refusals.unavailable");
      default:
        return error ?? t("previewStatus.refusals.failed");
    }
  };
  const startPreview = previewMutation.mutate;

  const startScriptMutation = useMutation({
    mutationFn: async (scriptName: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.startWorkspaceScript(workspaceId, scriptName);
      if (result.error) {
        throw new Error(result.error);
      }
      return result;
    },
    onError: (error, scriptName) => {
      toast.show(
        error instanceof Error
          ? error.message
          : t("workspace.scripts.states.startFailed", { scriptName }),
        {
          variant: "error",
        },
      );
    },
    onSuccess: (result) => {
      if (result.terminalId) {
        onScriptTerminalStarted?.(result.terminalId);
      }
    },
  });
  const startScript = startScriptMutation.mutate;

  const stopScriptMutation = useMutation({
    mutationFn: async (scriptName: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const terminalId = scripts.find((s) => s.scriptName === scriptName)?.terminalId;
      if (!terminalId) {
        throw new Error(t("workspace.scripts.states.stopFailed", { scriptName }));
      }
      const result = await client.killTerminal(terminalId);
      if (!result.success) {
        throw new Error(t("workspace.scripts.states.stopFailed", { scriptName }));
      }
    },
    onError: (error, scriptName) => {
      pendingRestartRef.current.delete(scriptName);
      toast.show(
        error instanceof Error
          ? error.message
          : t("workspace.scripts.states.stopFailed", { scriptName }),
        {
          variant: "error",
        },
      );
    },
  });
  const stopScript = stopScriptMutation.mutate;

  // Restart = kill the script terminal, then start again once the daemon
  // reports the script as stopped (it tears the runtime entry down on exit).
  useEffect(() => {
    const pending = pendingRestartRef.current;
    if (pending.size === 0) return;
    for (const script of scripts) {
      if (!pending.has(script.scriptName) || script.lifecycle === "running") continue;
      pending.delete(script.scriptName);
      startScript(script.scriptName);
    }
  }, [scripts, startScript]);

  const restartPlain = useCallback(
    (scriptName: string) => {
      pendingRestartRef.current.add(scriptName);
      stopScript(scriptName);
    },
    [stopScript],
  );

  const managedScript = useCallback(
    (scriptName: string) => {
      const script = scripts.find((entry) => entry.scriptName === scriptName);
      return script && isManagedPreview(script) ? script : null;
    },
    [scripts, isManagedPreview],
  );

  // A reserved preview stops through the broker, so the stop is recorded as one and its
  // outcome names mode "stop". Older daemons without previewStop keep the terminal stop.
  const stop = useCallback(
    (scriptName: string) => {
      if (previewStopSupported && managedScript(scriptName)) {
        startPreview({ scriptName, mode: "stop" });
      } else {
        stopScript(scriptName);
      }
    },
    [previewStopSupported, managedScript, startPreview, stopScript],
  );

  const start = useCallback(
    (scriptName: string) => {
      if (managedScript(scriptName)) startPreview({ scriptName, mode: "start" });
      else startScript(scriptName);
    },
    [managedScript, startPreview, startScript],
  );

  const restart = useCallback(
    (scriptName: string) => {
      if (!managedScript(scriptName)) {
        restartPlain(scriptName);
        return;
      }
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("previewStatus.confirmRestart.title"),
          message: t("previewStatus.confirmRestart.message"),
          confirmLabel: t("previewStatus.confirmRestart.confirm"),
          cancelLabel: t("previewStatus.confirmRestart.cancel"),
        });
        if (confirmed) startPreview({ scriptName, mode: "restart" });
      })();
    },
    [managedScript, restartPlain, startPreview, t],
  );

  const copyUrl = useCallback(
    (target: WorkspaceScriptLinkTarget) => {
      void Clipboard.setStringAsync(target.url);
      toast.copied(target.label);
    },
    [toast],
  );

  const selectRoute = useCallback(
    (kind: WorkspaceScriptLinkKind) => setPreferredRoute(serverId, kind),
    [serverId, setPreferredRoute],
  );

  const resolveLinks = useCallback(
    (script: WorkspaceScript): WorkspaceScriptLinks => {
      const link = resolveWorkspaceScriptLink({ script, activeConnection });
      const selected =
        link.targets.find((target) => target.kind === preferredRouteKind) ?? link.primary;
      return { selected, targets: link.targets };
    },
    [activeConnection, preferredRouteKind],
  );

  return useMemo(
    () => ({
      start,
      stop,
      restart,
      isManagedPreview,
      copyUrl,
      selectRoute,
      resolveLinks,
      isStartPending: startScriptMutation.isPending || previewMutation.isPending,
      isPreviewPending: previewMutation.isPending,
      // Keyed by preview, so one request does not disable every row's Stop and Restart.
      isPreviewPendingFor: (scriptName: string) =>
        previewMutation.isPending && previewMutation.variables?.scriptName === scriptName,
      isStopPending: stopScriptMutation.isPending,
      isStopPendingFor: (scriptName: string) =>
        stopScriptMutation.isPending && stopScriptMutation.variables === scriptName,
    }),
    [
      start,
      stop,
      restart,
      isManagedPreview,
      copyUrl,
      selectRoute,
      resolveLinks,
      startScriptMutation.isPending,
      previewMutation.isPending,
      previewMutation.variables,
      stopScriptMutation.isPending,
      stopScriptMutation.variables,
    ],
  );
}
