import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AgentSkillSelection,
  AgentSkillsSaveResult,
  AgentSkillsStatus,
} from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useInstallationSettings } from "@/execution-installation/settings";
import { useOwnerAccess } from "@/execution-installation/owner-access";
import {
  previewInstallationSkills,
  installationSkillStatus,
  installationSkillConfirmations,
} from "@/execution-installation/skills";
import { confirmDialog } from "@/utils/confirm-dialog";

export type AgentSkillsController = ReturnType<typeof useAgentSkills>;

export function useAgentSkills(serverId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const localConnected = useHostRuntimeIsConnected(serverId);
  const localSupported = useHostFeature(serverId, "skillManagement");
  const { installation, data: shared, save: saveShared } = useInstallationSettings();
  const managed = Boolean(
    installation?.environments.some((environment) => environment.serverId === serverId),
  );
  const sharedSelection = shared?.settings?.skills?.selection;
  // Shared skill settings need owner access. Locked is a state to show, not an error.
  const owner = useOwnerAccess();
  const locked = managed && owner.status !== "unlocked";
  const connected = managed || localConnected;
  const supported = managed || localSupported;
  const installationId = installation?.installationId;
  const queryKey = useMemo(
    () =>
      managed
        ? (["installation", installationId, "agent-skills"] as const)
        : (["host", serverId, "agent-skills"] as const),
    [managed, installationId, serverId],
  );
  const reportedQueryError = useRef<Error | null>(null);
  // Failures show in the section's status line, next to the controls, rather than a toast.
  const [problem, setProblem] = useState<string | null>(null);
  const report = useCallback(
    (message: string, error: Error) => {
      console.error(`[Agent skills: ${serverId}]`, error);
      setProblem(message);
    },
    [serverId],
  );
  const query = useFetchQuery<AgentSkillsStatus, Error>({
    queryKey,
    queryFn: async () => {
      if (managed) {
        if (!installation || !sharedSelection)
          throw new Error("Load shared skill settings before continuing.");
        const preview = await previewInstallationSkills(sharedSelection);
        return installationSkillStatus({
          preview,
          environments: installation.environments,
          selection: sharedSelection,
        });
      }
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.getAgentSkillsStatus();
    },
    enabled: managed ? !locked && Boolean(sharedSelection) : supported && client !== null,
    refetchInterval: managed ? 5000 : false,
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
  useEffect(() => {
    if (!query.error || query.error === reportedQueryError.current) return;
    reportedQueryError.current = query.error;
    report(t("settings.host.skills.statusFailed"), query.error);
  }, [query.error, report, t]);
  const setStatus = useCallback(
    (status: AgentSkillsStatus) => {
      setProblem(null);
      queryClient.setQueryData(queryKey, status);
    },
    [queryClient, queryKey],
  );
  const reconcile = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.reconcileAgentSkills();
    },
    onSuccess: setStatus,
    onError: (error: Error) => report(t("settings.host.skills.updateFailed"), error),
  });
  const uninstall = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.uninstallAgentSkills();
    },
    onSuccess: setStatus,
    onError: (error: Error) => report(t("settings.host.skills.uninstallFailed"), error),
  });
  const save = useMutation<
    AgentSkillsSaveResult,
    Error,
    { selection: AgentSkillSelection; confirmedRemovals: readonly string[] }
  >({
    mutationFn: async ({ selection, confirmedRemovals }) => {
      if (managed) {
        if (!installation || !shared?.settings)
          throw new Error("Load shared skill settings before saving.");
        const preview = await previewInstallationSkills(selection);
        const status = installationSkillStatus({
          preview,
          environments: installation.environments,
          selection,
        });
        if (status.confirmationRequired?.removals.some((name) => !confirmedRemovals.includes(name)))
          return status;
        await saveShared({
          expectedRevision: shared.revision,
          settings: { skills: { selection } },
          confirmedSkillRemovals: installationSkillConfirmations({
            preview,
            environments: installation.environments,
            confirmed: confirmedRemovals,
          }),
        });
        return { ...status, confirmationRequired: null };
      }
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.saveAgentSkillsSelection(selection, confirmedRemovals);
    },
    onSuccess: (result) => {
      if (!result.confirmationRequired) setStatus(result);
    },
    onError: (error) => report(t("settings.host.skills.saveSelectionFailed"), error),
  });
  const isWorking = reconcile.isPending || uninstall.isPending || save.isPending;
  const refetch = query.refetch;
  const reconcileAsync = reconcile.mutateAsync;
  const uninstallAsync = uninstall.mutateAsync;
  const saveAsync = save.mutateAsync;
  const saveWithConfirmation = useCallback(
    async (selection: AgentSkillSelection) => {
      const result = await saveAsync({ selection, confirmedRemovals: [] });
      if (!result.confirmationRequired) return true;
      const removals = result.confirmationRequired.removals;
      const confirmed = await confirmDialog({
        title: t("settings.host.skills.removeTitle"),
        message: t("settings.host.skills.removeMessage", { skills: removals.join(", ") }),
        confirmLabel: t("settings.host.skills.actions.remove"),
        destructive: true,
      });
      if (!confirmed) return false;
      const retry = await saveAsync({ selection, confirmedRemovals: removals });
      if (retry.confirmationRequired) throw new Error(t("settings.host.skills.saveFailed"));
      return true;
    },
    [saveAsync, t],
  );
  // `refetch` runs even a disabled query, so a refresh waits for readable shared settings.
  const refresh = useCallback(async () => {
    if (locked || (managed && !sharedSelection)) return;
    await refetch();
  }, [locked, managed, sharedSelection, refetch]);
  const runReconcile = useCallback(async () => {
    if (managed) {
      if (!sharedSelection) return false;
      return saveWithConfirmation(sharedSelection).catch((error: Error) => {
        report(t("settings.host.skills.updateFailed"), error);
        return false;
      });
    }
    return reconcileAsync().then(
      (status) => status.state !== "not-installed",
      () => false,
    );
  }, [reconcileAsync, managed, sharedSelection, saveWithConfirmation, report, t]);
  const runUninstall = useCallback(async () => {
    if (managed) {
      return saveWithConfirmation({ mode: "custom", skills: [] }).catch((error: Error) => {
        report(t("settings.host.skills.uninstallFailed"), error);
        return false;
      });
    }
    const confirmed = await confirmDialog({
      title: t("settings.host.skills.uninstallTitle"),
      message: t("settings.host.skills.uninstallMessage"),
      confirmLabel: t("settings.host.skills.actions.uninstall"),
      destructive: true,
    });
    if (!confirmed) return false;
    return uninstallAsync().then(
      (status) => status.state === "not-installed",
      () => false,
    );
  }, [uninstallAsync, managed, saveWithConfirmation, report, t]);
  const saveSelection = useCallback(
    (selection: AgentSkillSelection, confirmedRemovals: readonly string[] = []) =>
      saveAsync({ selection, confirmedRemovals }),
    [saveAsync],
  );
  return {
    managed,
    locked,
    /** The latest failed check or action, shown in the section status. */
    problem,
    connected,
    supported,
    status: query.data ?? null,
    error: query.error,
    isLoading: query.isLoading,
    isWorking,
    refresh,
    reconcile: runReconcile,
    uninstall: runUninstall,
    saveSelection,
  };
}
