import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import { useSettingsHostSelection } from "@/navigation/settings-presentation";
import { executeSystemAction } from "./system-actions";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  useInstallationSystemModel,
  useInstallationOwnerClient,
} from "@/execution-installation/panel";
import { getHostRuntimeStore, useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "@/execution-installation/policy";
import {
  useInstallationUpgradeActions,
  useInstallationUpgradeStatus,
} from "@/execution-installation/use-installation-upgrades";
import { upgradeOffer } from "@/execution-installation/installation-upgrades-model";
import { useVortonUpdate } from "@/vorton-updates/use-update";
import { useToast } from "@/contexts/toast-context";
import { reportSyncError } from "@/components/settings/sync-error-notification";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { useSessionStore } from "@/stores/session-store";
import { resolveAppVersion } from "@/utils/app-version";
import { isVersionMismatch } from "@/desktop/updates/desktop-updates";
import { updateDaemonFromSettings } from "../daemon-lifecycle";
import type { SystemAction } from "./system-status-model";
import {
  selectSystemEnvironments,
  systemEnvironmentState,
  systemServicesState,
  type SystemTarget,
} from "./system-adapter-model";
const noSubscription = () => () => {};

export function useSystemAdapter(serverId?: string) {
  const installation = readExecutionInstallation();
  const hosts = useHosts();
  const selected = useSettingsHostSelection();
  const { hostId, devId } = selectSystemEnvironments(installation, hosts, serverId, selected);
  const host = useHostRuntimeSnapshot(hostId ?? "");
  const dev = useHostRuntimeSnapshot(devId ?? "");
  const model = useInstallationSystemModel();
  const read = useCallback(() => model?.getState() ?? null, [model]);
  const state = useSyncExternalStore(model?.subscribe ?? noSubscription, read, read);
  const client = useInstallationOwnerClient();
  const upgrades = useInstallationUpgradeStatus(client);
  const upgradeActions = useInstallationUpgradeActions(client);
  const update = useVortonUpdate();
  const offer = upgradeOffer({
    status: state?.unlocked ? upgrades.data : null,
    latestRelease: update.data?.latestRelease,
    updateAvailable: update.data?.status === "available",
  });
  const hostInfo = useSessionStore((store) => store.sessions[hostId ?? ""]?.serverInfo);
  const devInfo = useSessionStore((store) => store.sessions[devId ?? ""]?.serverInfo);
  const [updating, setUpdating] = useState<{ serverId: string; action: SystemAction } | null>(null);
  const toast = useToast();
  const previousNotice = useRef(state?.notice);
  useEffect(() => {
    const error = systemSyncError(state, upgrades.error);
    reportSyncError(`system:${installation?.installationId ?? hostId}`, error, () =>
      toast.error(toErrorMessage(error)),
    );
    if (state?.notice && state.notice !== previousNotice.current) toast.show(state.notice);
    previousNotice.current = state?.notice;
  }, [state, toast, upgrades.error, installation?.installationId, hostId]);
  const runAction = useCallback(
    async (target: SystemTarget, action: SystemAction) => {
      const id = target === "host" ? hostId : devId;
      if (!id) return;
      try {
        await executeSystemAction(
          {
            serverId: id,
            target,
            installation,
            state,
            upgrades: upgrades.data?.upgrades ?? [],
            offer,
            upgradeStatus: upgrades.data,
          },
          action,
          {
            confirm: confirmDialog,
            reconnect: async (selectedId) => {
              getHostRuntimeStore().ensureConnectedAll({ verify: true });
              await getHostRuntimeStore().runProbeCycleNow(selectedId);
            },
            restart: async (job, decision) => {
              if (!model) throw new Error("Unlock System controls first");
              await model.decide(job, decision);
            },
            upgrade: (upgrade, decision) =>
              upgradeActions.decide.mutateAsync({ upgrade, decision }),
            requestUpgrade: (release) => upgradeActions.create.mutateAsync(release),
            updateStandalone: async (selectedId) => {
              const runtime = getHostRuntimeStore().getClient(selectedId);
              if (!runtime) throw new Error("Reconnect before updating.");
              setUpdating({ serverId: selectedId, action });
              await updateDaemonFromSettings(selectedId, {
                updateDaemon: () => runtime.updateDaemon(`settings_update_${selectedId}`),
                getStatus: async () => ({
                  ...(await runtime.getDaemonStatus()),
                  serverId: runtime.getLastServerInfoMessage()?.serverId ?? "",
                  version: runtime.getLastServerInfoMessage()?.version ?? null,
                }),
              });
              toast.show("Host updated");
            },
          },
        );
      } catch (error) {
        const detail = toErrorMessage(error);
        toast.error(
          !installation && action.kind === "update" ? `Could not update Host: ${detail}` : detail,
        );
      } finally {
        setUpdating(null);
      }
    },
    [hostId, devId, state, model, installation, upgrades.data, upgradeActions, offer, toast],
  );
  const version = (info: typeof hostInfo) =>
    !installation &&
    info?.features?.daemonSelfUpdate &&
    !info.desktopManaged &&
    isVersionMismatch(resolveAppVersion(), info.version)
      ? resolveAppVersion()
      : null;
  return {
    installation,
    hostId,
    devId,
    host,
    dev,
    hostInfo,
    devInfo,
    model,
    state,
    client,
    upgrades,
    runAction,
    pendingUpdate: updating,
    busy: Boolean(
      state?.busy || upgradeActions.create.isPending || upgradeActions.decide.isPending || updating,
    ),
    ...buildEnvironmentStatuses({
      state,
      host,
      dev,
      hostId,
      devId,
      upgrades: upgrades.data,
      offer,
      standaloneVersion: version(hostInfo),
      installation,
      updating: updating?.serverId ?? null,
    }),
  };
}

function buildEnvironmentStatuses({
  state,
  host,
  dev,
  hostId,
  devId,
  upgrades,
  offer,
  standaloneVersion,
  installation,
  updating,
}: {
  state: import("./system-adapter-model").InstallationSystemState | null;
  host: import("@/runtime/host-runtime").HostRuntimeSnapshot | null;
  dev: import("@/runtime/host-runtime").HostRuntimeSnapshot | null;
  hostId: string | null;
  devId: string | null;
  upgrades: import("@getpaseo/protocol/installation-upgrades").UpgradeStatus | null | undefined;
  offer: string | null;
  standaloneVersion: string | null;
  installation: ExecutionInstallation | null;
  updating: string | null;
}) {
  return {
    services: systemServicesState(state),
    hostStatus: systemEnvironmentState({
      target: "host",
      snapshot: host,
      installation: state,
      upgrades: upgrades?.upgrades,
      availableVersion: installation ? offer : standaloneVersion,
      reconnectingAfterAction: updating === hostId && updating !== null,
    }),
    devStatus: systemEnvironmentState({
      target: "container-daemon",
      snapshot: dev,
      installation: state,
      upgrades: upgrades?.upgrades,
      reconnectingAfterAction: updating === devId && updating !== null,
    }),
  };
}

function systemSyncError(
  state: import("./system-adapter-model").InstallationSystemState | null,
  upgradeError: unknown,
) {
  if (!state) return upgradeError;
  return [
    state.error,
    state.helperError,
    state.enrollmentError,
    state.serviceQueueError,
    state.daemonAutomationError,
    state.maintenanceDelegationError,
    state.liveDevError,
    upgradeError,
  ].find(Boolean);
}
