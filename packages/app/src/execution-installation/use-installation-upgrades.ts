import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CoordinatorFollowDecision,
  CoordinatorFollowJob,
  CoordinatorSettingsDecision,
  CoordinatorSettingsJob,
  InstallationUpgrade,
  UpdatePolicyChange,
  UpgradeDecision,
  UpgradeStatus,
} from "@getpaseo/protocol/installation-upgrades";
import { useFetchQuery } from "@/data/query";
import type { InstallationClient } from "./client";
import { activeUpgrade, coordinatorFollowInProgress } from "./installation-upgrades-model";
import { coordinatorSettingsInProgress } from "./coordinator-settings-model";

export const INSTALLATION_UPGRADES_KEY = ["installation-upgrades"] as const;
export const INSTALLATION_SNAPSHOTS_KEY = ["installation-snapshots"] as const;
export const COORDINATOR_FOLLOW_KEY = ["installation-coordinator-follow"] as const;
export const COORDINATOR_SETTINGS_KEY = ["installation-coordinator-settings"] as const;

function requireClient(client: InstallationClient | null): InstallationClient {
  if (!client) throw new Error("Unlock installation controls first");
  return client;
}

/**
 * Upgrade status shared by the update section and Installation controls. Data is null when the
 * coordinator predates upgrades. Active upgrades refresh every five seconds.
 */
export function useInstallationUpgradeStatus(client: InstallationClient | null) {
  return useFetchQuery({
    dataShape: "value",
    queryKey: INSTALLATION_UPGRADES_KEY,
    queryFn: () => requireClient(client).upgradeStatus(),
    enabled: client !== null,
    staleTimeMs: 0,
    // Poll quickly only while an upgrade runs; a pending one can wait for the owner for days,
    // and the sidebar mounts this query in every open interface.
    refetchInterval: (query) => {
      const status = activeUpgrade(query.state.data)?.status;
      // An upgrade can wait for current work for a long time; 15 seconds is enough to follow it.
      return status === "approved" || status === "running" ? 15_000 : 60_000;
    },
    retry: false,
  });
}

export function useInstallationUpgradeActions(client: InstallationClient | null) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: INSTALLATION_UPGRADES_KEY });
  const store = (status: UpgradeStatus) =>
    queryClient.setQueryData(INSTALLATION_UPGRADES_KEY, status);
  const create = useMutation({
    mutationFn: (release: string) => requireClient(client).requestUpgrade(release),
    onSettled: refresh,
  });
  const decide = useMutation({
    mutationFn: (input: { upgrade: InstallationUpgrade; decision: UpgradeDecision["decision"] }) =>
      requireClient(client).decideUpgrade(input.upgrade, input.decision),
    onSettled: refresh,
  });
  const changePolicy = useMutation({
    mutationFn: (change: UpdatePolicyChange) => requireClient(client).changeUpdatePolicy(change),
    onSuccess: store,
    onSettled: refresh,
  });
  const check = useMutation({
    mutationFn: () => requireClient(client).checkForUpdates(),
    onSuccess: store,
    onSettled: refresh,
  });
  return { create, decide, changePolicy, check };
}

/** Snapshot list; data is null when the coordinator predates snapshots. */
export function useInstallationSnapshots(client: InstallationClient | null, restoring: boolean) {
  return useFetchQuery({
    dataShape: "value",
    queryKey: INSTALLATION_SNAPSHOTS_KEY,
    queryFn: () => requireClient(client).snapshots(),
    enabled: client !== null,
    staleTimeMs: 0,
    // A restore restarts the coordinator; poll quickly so the page reloads when it returns.
    refetchInterval: (query) =>
      restoring || query.state.data?.restore?.status === "running" ? 3000 : 60_000,
    retry: false,
  });
}

/** Coordinator update status; data is null when the coordinator predates it. */
export function useCoordinatorFollowStatus(client: InstallationClient | null) {
  return useFetchQuery({
    dataShape: "value",
    queryKey: COORDINATOR_FOLLOW_KEY,
    queryFn: () => requireClient(client).coordinatorFollowStatus(),
    enabled: client !== null,
    staleTimeMs: 0,
    refetchInterval: (query) => (coordinatorFollowInProgress(query.state.data) ? 3000 : 60_000),
    retry: false,
  });
}

export function useCoordinatorFollowActions(client: InstallationClient | null) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: COORDINATOR_FOLLOW_KEY });
  const start = useMutation({
    mutationFn: (next: string) => requireClient(client).updateCoordinator(next),
    onSettled: refresh,
  });
  const decide = useMutation({
    mutationFn: (input: {
      job: CoordinatorFollowJob;
      decision: CoordinatorFollowDecision["decision"];
    }) => requireClient(client).decideCoordinatorFollow(input.job, input.decision),
    onSettled: refresh,
  });
  return { start, decide };
}

/** Coordinator settings status; data is null when the coordinator predates it. */
export function useCoordinatorSettingsStatus(client: InstallationClient | null) {
  return useFetchQuery({
    dataShape: "value",
    queryKey: COORDINATOR_SETTINGS_KEY,
    queryFn: () => requireClient(client).coordinatorSettingsStatus(),
    enabled: client !== null,
    staleTimeMs: 0,
    refetchInterval: (query) => (coordinatorSettingsInProgress(query.state.data) ? 3000 : 60_000),
    retry: false,
  });
}

export function useCoordinatorSettingsActions(client: InstallationClient | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      job: CoordinatorSettingsJob;
      decision: CoordinatorSettingsDecision["decision"];
      follow?: CoordinatorFollowJob | string;
    }) => requireClient(client).decideCoordinatorSettings(input.job, input.decision, input.follow),
    // A combined approval also changes the coordinator update.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: COORDINATOR_SETTINGS_KEY }),
        queryClient.invalidateQueries({ queryKey: COORDINATOR_FOLLOW_KEY }),
      ]),
  });
}
