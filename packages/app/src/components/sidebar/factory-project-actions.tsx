import { useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import { useInstalledPlugins } from "@/plugins/registry";
import { useMenuContext } from "@/components/ui/menu";
import { factoryListQueryKey } from "@/screens/factory/factory-reads";
import { checkProjectResume, projectResume } from "@/screens/factory/resume-confirm";
import { openFactoryInstructions } from "./factory-instructions";
import { openFactoryDialog, factoryActions, type ProjectFactoryState } from "./project-factory";
import { ProjectMenuItem, type ProjectMenuSurface } from "./project-menu-item";
export function FactoryProjectActions({
  surface,
  settingsTarget,
  projectPath,
}: {
  surface: ProjectMenuSurface;
  settingsTarget: { serverId: string; projectId: string } | null;
  projectPath: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const plugins = useInstalledPlugins();
  const factoryPlugin = plugins.find(
    (plugin) => plugin.id === "factory" && plugin.serverId === settingsTarget?.serverId,
  );
  const factoryScreenAvailable = !!factoryPlugin;
  const { open: factoryMenuOpen } = useMenuContext("ProjectMenuItems");
  const factoryQueryClient = useQueryClient();
  const [factoryState, setFactoryState] = useState<ProjectFactoryState | null>(null);
  const [factoryError, setFactoryError] = useState<string | null>(null);
  const [factoryPending, setFactoryPending] = useState(false);
  useEffect(() => {
    if (!factoryMenuOpen || !factoryScreenAvailable || !factoryPlugin || !settingsTarget) return;
    setFactoryError(null);
    let active = true;
    void factoryPlugin
      .invoke("factory.project.get", { projectId: settingsTarget.projectId })
      .then((state) => {
        if (active) setFactoryState(state as ProjectFactoryState);
        return state;
      })
      .catch((error) => {
        if (active)
          setFactoryError(error instanceof Error ? error.message : t("projectFactory.failed"));
      });
    return () => {
      active = false;
    };
  }, [factoryMenuOpen, factoryScreenAvailable, factoryPlugin, settingsTarget, t]);
  const applyFactoryState = useCallback(
    (state: ProjectFactoryState) => {
      setFactoryState(state);
      if (!settingsTarget) return;
      factoryQueryClient.setQueryData(
        ["projectFactory", settingsTarget.serverId, settingsTarget.projectId],
        state,
      );
      // The list carries pause and drain state for the All Factories card and overview.
      void factoryQueryClient.invalidateQueries({
        queryKey: factoryListQueryKey(settingsTarget.serverId),
      });
    },
    [settingsTarget, factoryQueryClient],
  );
  const factoryAction = useCallback(
    (action: "enable" | "pause" | "resume" | "disable") => {
      if (!factoryPlugin || !settingsTarget || factoryPending) return;
      if (action === "enable" || action === "disable") {
        void openFactoryDialog({
          action,
          ...settingsTarget,
          projectPath,
          repository: factoryState?.repository ?? null,
          invoke: factoryPlugin.invoke,
          onResult: applyFactoryState,
        });
        return;
      }
      setFactoryPending(true);
      // Resume decides from a fresh read, as the overview does: a project another process now
      // holds is not resumed, and one stopped by Stop all asks first.
      const check =
        action === "resume"
          ? checkProjectResume({
              client: factoryQueryClient,
              ...settingsTarget,
              invoke: factoryPlugin.invoke,
              t,
            })
          : Promise.resolve({ resume: true, message: null });
      void check
        .then(async ({ resume: allowed, message }) => {
          if (!allowed) {
            const fresh = factoryQueryClient.getQueryData<ProjectFactoryState>([
              "projectFactory",
              settingsTarget.serverId,
              settingsTarget.projectId,
            ]);
            if (fresh) setFactoryState(fresh);
            if (message) setFactoryError(message);
            return undefined;
          }
          const state = await factoryPlugin.invoke(`factory.project.${action}`, {
            projectId: settingsTarget.projectId,
          });
          applyFactoryState(state as ProjectFactoryState);
          return state;
        })
        .catch((error) =>
          toast.error(error instanceof Error ? error.message : t("projectFactory.failed")),
        )
        .finally(() => setFactoryPending(false));
    },
    [
      factoryPlugin,
      settingsTarget,
      factoryPending,
      projectPath,
      factoryState,
      factoryQueryClient,
      toast,
      t,
      applyFactoryState,
    ],
  );
  const held = projectResume(factoryState?.drain) === "hidden";
  const openInstructions = useCallback(() => {
    if (settingsTarget) openFactoryInstructions(settingsTarget);
  }, [settingsTarget]);
  const openModels = useCallback(() => {
    if (settingsTarget) openFactoryInstructions({ ...settingsTarget, modelsOnly: true });
  }, [settingsTarget]);
  return (
    <>
      {settingsTarget &&
      factoryState &&
      (factoryState.state === "on" || factoryState.state === "paused") ? (
        <ProjectMenuItem surface={surface} onSelect={openInstructions}>
          {t("projectFactory.instructions")}
        </ProjectMenuItem>
      ) : null}
      {settingsTarget &&
      factoryState &&
      factoryState.state !== "off" &&
      factoryState.state !== "unavailable" ? (
        <ProjectMenuItem surface={surface} onSelect={openModels}>
          {t("projectFactory.workerModels")}
        </ProjectMenuItem>
      ) : null}
      {factoryState && held ? (
        <ProjectMenuItem surface={surface} disabled>
          {t("projectFactory.needsYou.kinds.held", { subject: factoryState.drain!.reason })}
        </ProjectMenuItem>
      ) : null}
      {factoryState
        ? factoryActions(factoryState.state)
            // Another process holds this project, so it offers no Resume, as in the overview.
            .filter((action) => !(held && action === "resume"))
            .map((action) => (
              <FactoryActionItem
                key={action}
                surface={surface}
                action={action}
                pending={factoryPending}
                onAction={factoryAction}
              />
            ))
        : null}
      {factoryError || !factoryState || factoryState.state === "unavailable" ? (
        <ProjectMenuItem surface={surface} disabled>
          {factoryError ?? factoryState?.reason ?? t("projectFactory.loading")}
        </ProjectMenuItem>
      ) : null}
    </>
  );
}
function FactoryActionItem({
  surface,
  action,
  pending,
  onAction,
}: {
  surface: ProjectMenuSurface;
  action: "enable" | "pause" | "resume" | "disable";
  pending: boolean;
  onAction: (action: "enable" | "pause" | "resume" | "disable") => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => onAction(action), [onAction, action]);
  return (
    <ProjectMenuItem surface={surface} disabled={pending} onSelect={select}>
      {t(`projectFactory.${action}Menu`)}
    </ProjectMenuItem>
  );
}
