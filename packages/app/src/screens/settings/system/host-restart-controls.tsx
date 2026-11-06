import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import { useToast } from "@/contexts/toast-context";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { HostProfile } from "@/types/host-connection";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isConnectionError } from "@/utils/error-messages";
import { useReportActionError } from "@/hooks/use-action-error";
import { restartDaemonFromSettings } from "../daemon-lifecycle";

export function HostRestartControls({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const toast = useToast();
  const graceful = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.features?.gracefulRestart === true,
  );
  const daemonClient = useHostRuntimeClient(host.serverId);
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const runtime = getHostRuntimeStore();
  const [isRestarting, setIsRestarting] = useState(false);
  // Rendered in the card, not an Alert.alert: react-native-web's Alert is a no-op, and a failed
  // close-terminals restart must name the processes left running until the user retries.
  const [restartError, setRestartError] = useState<string | null>(null);
  useEffect(() => {
    if (restartError) toast.error(restartError);
  }, [restartError, toast]);
  const isMountedRef = useRef(true);
  // COMPAT(terminalsSurviveRestart): added in v0.12.0, remove gate after 2027-04-21.
  const terminalsSurviveRestart = useSessionStore(
    (state) =>
      state.sessions[host.serverId]?.serverInfo?.features?.terminalsSurviveRestart === true,
  );

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isHostConnected = useCallback(
    () => isHostRuntimeConnected(runtime.getSnapshot(host.serverId)),
    [host.serverId, runtime],
  );

  const reportActionError = useReportActionError();
  const waitForDaemonRestart = useCallback(
    async (request: Promise<void>) => {
      try {
        await request;
      } catch (error) {
        if (isConnectionError(error)) reportActionError(error);
        console.error("[HostPage] Daemon restart failed", error);
        if (isMountedRef.current) {
          setRestartError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (isMountedRef.current) setIsRestarting(false);
      }
    },
    [reportActionError],
  );

  const startRestart = useCallback(
    (killTerminals: boolean) => {
      if (!daemonClient) {
        toast.error("Reconnect before restarting this environment.");
        return;
      }
      if (!isHostConnected()) {
        toast.error("Reconnect before restarting this environment.");
        return;
      }

      let message =
        "This environment restarts. The app reconnects automatically. Review running work before continuing.";
      if (graceful) message = "Current turns finish before the restart. New work waits.";
      if (killTerminals)
        message =
          "This environment restarts and every terminal closes, ending the programs running in them. The app reconnects automatically.";
      void confirmDialog({
        title: t("settings.host.daemon.restart.confirmTitle", { name: host.label }),
        message,
        confirmLabel: killTerminals
          ? t("settings.host.daemon.restart.closeTerminals")
          : t("settings.host.daemon.restart.confirm"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      })
        .then((confirmed) => {
          if (!confirmed) return;
          setRestartError(null);
          setIsRestarting(true);
          const restartRequest = restartDaemonFromSettings(
            host.serverId,
            `settings_daemon_restart_${host.serverId}`,
            {
              restartServer: (reason, options) =>
                daemonClient.restartServer(reason, undefined, {
                  ...options,
                  ...(!killTerminals && graceful ? { idleMode: "drain" as const } : {}),
                }),
              getStatus: async () => ({
                ...(await daemonClient.getDaemonStatus()),
                serverId: daemonClient.getLastServerInfoMessage()?.serverId ?? "",
                version: daemonClient.getLastServerInfoMessage()?.version ?? null,
              }),
            },
            { killTerminals },
          );
          void waitForDaemonRestart(restartRequest);
          return;
        })
        .catch((error) => {
          console.error(`[HostPage] Failed to open restart confirmation for ${host.label}`, error);
          if (isMountedRef.current) {
            setRestartError(t("settings.host.daemon.restart.dialogFailedMessage"));
          }
        });
    },
    [
      daemonClient,
      host.label,
      host.serverId,
      isHostConnected,
      t,
      waitForDaemonRestart,
      graceful,
      toast,
    ],
  );

  const handleRestart = useCallback(() => startRestart(false), [startRestart]);
  const handleRestartAndCloseTerminals = useCallback(() => startRestart(true), [startRestart]);

  return (
    <View style={settingsStyles.card} testID="host-page-restart-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{`Restart ${host.label}`}</Text>
          <Text style={settingsStyles.rowHint}>
            Current turns can finish before restarting. Review the confirmation before continuing.
          </Text>
        </View>
        <Button
          variant="outline"
          onPress={handleRestart}
          disabled={isRestarting || !daemonClient || !isConnected}
          testID="host-page-restart-button"
        >
          {isRestarting
            ? t("settings.host.daemon.restart.restarting")
            : t("settings.host.daemon.restart.confirm")}
        </Button>
      </View>
      {terminalsSurviveRestart ? (
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.daemon.restart.closeTerminalsHint")}
            </Text>
          </View>
          <Button
            variant="outline"
            onPress={handleRestartAndCloseTerminals}
            disabled={isRestarting || !daemonClient || !isConnected}
            testID="host-page-restart-close-terminals-button"
          >
            {t("settings.host.daemon.restart.closeTerminals")}
          </Button>
        </View>
      ) : null}
      <SettingsStatusLine message={restartError} testID="host-page-restart-error" />
    </View>
  );
}
