import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useToast } from "@/contexts/toast-context";
import { reportSyncError } from "@/components/settings/sync-error-notification";
import { toErrorMessage } from "@/utils/error-messages";
import { Button } from "@/components/ui/button";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import { settingsStyles } from "@/styles/settings";
import { LocalDaemonSection } from "@/desktop/components/desktop-updates-section";
import {
  InstallationSystemAdvanced,
  InstallationSystemDetails,
  RestartActions,
} from "@/execution-installation/panel";
import { InstallationConnectionCheck } from "@/execution-installation/connection-check-wrapper";
import { UpstreamUpdatesSection } from "@/vorton-updates/upstream-section";
import { VORTON_BUILD_COMMIT } from "@/vorton-updates/use-update";
import { SystemView } from "./system-view";
import { SystemUpdatesRow } from "./system-updates-row";
import { HostRestartControls } from "./host-restart-controls";
import { useSystemAdapter } from "./use-system-adapter";
import type { SystemAction } from "./system-status-model";
import { currentSystemRestarts, type SystemTarget } from "./system-adapter-model";
type Adapter = ReturnType<typeof useSystemAdapter>;
const snaps = ["90%"];
const fullStatusHeader = { title: "Full status" };

function RestartMenu({
  adapter,
  target,
  serverId,
  label,
}: {
  adapter: Adapter;
  target: SystemTarget;
  serverId: string;
  label: "Host" | "Dev";
}) {
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const host = useHosts().find((entry) => entry.serverId === serverId);
  const namedHost = useMemo(() => (host ? { ...host, label } : null), [host, label]);
  const header = useMemo(() => ({ title: `Restart ${label}` }), [label]);
  const jobs = adapter.state?.unlocked
    ? currentSystemRestarts(adapter.state).filter(
        (job) => job.target === target && job.status !== "failed",
      )
    : [];
  return (
    <>
      <DropdownMenu>
        <DropdownTrigger accessibilityLabel={`${label} actions`}>More</DropdownTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={open}>Restart…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AdaptiveModalSheet
        visible={visible}
        header={header}
        onClose={close}
        desktopHeight={640}
        snapPoints={snaps}
        testID={`system-restart-${target}`}
      >
        {namedHost ? (
          <HostRestartControls host={namedHost} />
        ) : (
          <Text>Reconnect this environment to request a restart.</Text>
        )}
        {adapter.model && adapter.state?.unlocked
          ? jobs.map((job) => (
              <View key={job.id} style={styles.job}>
                <Text style={settingsStyles.rowHint}>{job.reason}</Text>
                <RestartActions
                  job={job}
                  model={adapter.model!}
                  busy={adapter.busy}
                  historical={false}
                />
              </View>
            ))
          : null}
        <SettingsStatusLine message={adapter.state?.notice} />
      </AdaptiveModalSheet>
    </>
  );
}
function EnvironmentDetails({
  serverId,
  target,
  label,
  sourceCommit,
}: {
  serverId: string;
  target: SystemTarget;
  label: "Host" | "Dev";
  sourceCommit?: string | null;
}) {
  const [fullStatus, setFullStatus] = useState(false);
  const openStatus = useCallback(() => setFullStatus(true), []);
  const closeStatus = useCallback(() => setFullStatus(false), []);
  const snapshot = useHostRuntimeSnapshot(serverId);
  const info = useSessionStore((store) => store.sessions[serverId]?.serverInfo);
  const local = useIsLocalDaemon(serverId);
  const client = snapshot?.client;
  const status = useFetchQuery({
    dataShape: "value",
    queryKey: ["system-runtime-status", serverId],
    enabled:
      snapshot?.connectionStatus === "online" &&
      Boolean(client) &&
      info?.features?.daemonStatusRpc === true,
    staleTimeMs: 5000,
    refetchInterval: 5000,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error("Reconnect to read status");
      return client.getDaemonStatus();
    },
  });
  const toast = useToast();
  useEffect(() => {
    reportSyncError(`system-status:${serverId}`, status.error, () =>
      toast.error(toErrorMessage(status.error)),
    );
  }, [serverId, status.error, toast]);
  return (
    <View style={styles.detailsBody}>
      <Text style={settingsStyles.rowTitle}>{label} details</Text>
      <Text
        selectable
        style={settingsStyles.rowHint}
      >{`Transport: ${snapshot?.activeConnection?.display ?? "Unknown"}`}</Text>
      <Text selectable style={settingsStyles.rowHint}>
        {snapshot?.activeConnection?.endpoint ?? ""}
      </Text>
      <Text
        selectable
        style={settingsStyles.rowHint}
      >{`Version: ${info?.version ?? "Unknown"}`}</Text>
      <Text
        selectable
        style={settingsStyles.rowHint}
      >{`PID: ${status.data?.pid ?? "Unknown"}`}</Text>
      <Text
        selectable
        style={settingsStyles.rowHint}
      >{`Commit: ${sourceCommit ?? "Unknown"}`}</Text>
      <Text
        selectable
        style={settingsStyles.rowHint}
      >{`App commit: ${VORTON_BUILD_COMMIT ?? "Unknown"}`}</Text>
      {local ? (
        <LocalDaemonSection />
      ) : (
        <>
          <Button variant="outline" onPress={openStatus} disabled={!status.data}>
            Full status
          </Button>
          <SettingsStatusLine message="Logs are available on the computer running this environment." />
          <AdaptiveModalSheet visible={fullStatus} header={fullStatusHeader} onClose={closeStatus}>
            <Text selectable style={settingsStyles.rowHint}>
              {JSON.stringify(status.data, null, 2)}
            </Text>
          </AdaptiveModalSheet>
        </>
      )}
      <InstallationSystemDetails target={target} />
      <InstallationConnectionCheck embedded />
    </View>
  );
}
/** Catalog entry point. An explicit serverId selects the standalone Host when no installation exists. */
export function SystemPane({
  serverId,
  restartRecovery,
}: { serverId?: string; restartRecovery?: ReactNode } = {}) {
  const adapter = useSystemAdapter(serverId);
  const hostAction = useCallback(
    (action: SystemAction) => {
      void adapter.runAction("host", action);
    },
    [adapter],
  );
  const devAction = useCallback(
    (action: SystemAction) => {
      void adapter.runAction("container-daemon", action);
    },
    [adapter],
  );
  const [advanced, setAdvanced] = useState(false);
  const toggleAdvanced = useCallback(() => setAdvanced((value) => !value), []);
  const advancedState = useMemo(() => ({ expanded: advanced }), [advanced]);
  const environments = useMemo(
    () => [
      ...(adapter.hostId
        ? [
            {
              name: "Host" as const,
              ...adapter.hostStatus,
              disabled: adapter.busy,
              onAction: hostAction,
              restartMenu: (
                <RestartMenu
                  adapter={adapter}
                  target="host"
                  serverId={adapter.hostId}
                  label="Host"
                />
              ),
              details: (
                <EnvironmentDetails
                  serverId={adapter.hostId}
                  target="host"
                  label="Host"
                  sourceCommit={
                    adapter.state?.enrollmentStatus?.services.find(
                      (service) => service.target === "host",
                    )?.selectedSource
                  }
                />
              ),
            },
          ]
        : []),
      ...(adapter.devId
        ? [
            {
              name: "Dev" as const,
              ...adapter.devStatus,
              disabled: adapter.busy,
              onAction: devAction,
              restartMenu: (
                <RestartMenu
                  adapter={adapter}
                  target="container-daemon"
                  serverId={adapter.devId}
                  label="Dev"
                />
              ),
              details: (
                <EnvironmentDetails
                  serverId={adapter.devId}
                  target="container-daemon"
                  label="Dev"
                  sourceCommit={
                    adapter.state?.enrollmentStatus?.services.find(
                      (service) => service.target === "container-daemon",
                    )?.selectedSource
                  }
                />
              ),
            },
          ]
        : []),
    ],
    [adapter, hostAction, devAction],
  );
  return (
    <SettingsSection title="System" testID="system-pane">
      {!adapter.hostId && !adapter.devId ? (
        <Text style={settingsStyles.rowHint}>
          Add a Host from the sidebar More menu to view its status.
        </Text>
      ) : null}
      <SystemView environments={environments} services={adapter.services} />
      <SystemUpdatesRow />
      {/* The coordinator supplies the restart-recovery card after the owner confirms its placement. */}
      <View testID="system-restart-recovery-slot">{restartRecovery}</View>
      <Button
        variant="ghost"
        onPress={toggleAdvanced}
        accessibilityState={advancedState}
        testID="system-advanced-toggle"
      >
        Advanced
      </Button>
      {advanced ? (
        <ScrollView style={styles.advanced} contentContainerStyle={styles.detailsBody}>
          <InstallationSystemAdvanced />
          <UpstreamUpdatesSection />
        </ScrollView>
      ) : null}
    </SettingsSection>
  );
}
const styles = StyleSheet.create((theme) => ({
  detailsBody: { padding: theme.spacing[4], gap: theme.spacing[3] },
  advanced: { height: 600 },
  job: { padding: theme.spacing[4], gap: theme.spacing[2] },
}));
