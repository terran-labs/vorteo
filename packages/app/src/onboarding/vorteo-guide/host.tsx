import {
  recordPrimaryConnection,
  usePrimaryConnection,
} from "@/execution-installation/primary-connection";
import { queryClient } from "@/data/query-client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useInstallationOwnerClient } from "@/execution-installation/panel";
import {
  installationHostServerId,
  readExecutionInstallation,
} from "@/execution-installation/policy";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { selectIsSystemProject } from "@/workspace/lifecycle/system-membership";
import {
  createVorteoGuide,
  guidePrimaryConnectionChoice,
  type GuideHost,
  type VorteoGuideModel,
} from "./model";
import { guideStorage } from "./storage";
import { VorteoGuideView } from "./view";

const guides = new Map<string, VorteoGuideModel>();

function getGuide(installationId: string): VorteoGuideModel {
  let model = guides.get(installationId);
  if (!model) {
    model = createVorteoGuide({
      installationId,
      storage: guideStorage,
      async savePrimaryConnection(request) {
        const saved = await recordPrimaryConnection((snapshot) =>
          guidePrimaryConnectionChoice(snapshot, request),
        );
        queryClient.setQueryData(["installation-settings", installationId], saved);
      },
    });
    guides.set(installationId, model);
  }
  return model;
}

function useGuideHost(): GuideHost | null {
  const installation = readExecutionInstallation();
  // readExecutionInstallation returns a new object on every render; memoize on its identity.
  const installationId = installation?.installationId;
  const serverId = installationHostServerId(installation);
  const { supported: supportsPrimaryConnection } = usePrimaryConnection();
  const ownerClient = useInstallationOwnerClient();
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const hasHydratedWorkspaces = useSessionStore((state) =>
    Boolean(serverId && state.sessions[serverId]?.hasHydratedWorkspaces),
  );
  const hasUserProjects = useSessionStore((state) => {
    if (!serverId) return false;
    const projects = state.sessions[serverId]?.projects;
    return projects
      ? Array.from(projects.values()).some(
          (project) => !selectIsSystemProject(state, serverId, project.projectId),
        )
      : false;
  });
  return useMemo(
    () =>
      installationId && serverId
        ? {
            installationId,
            serverId,
            ownerAuthenticated: ownerClient !== null,
            isConnected,
            hasHydratedWorkspaces,
            hasUserProjects,
            supportsPrimaryConnection,
          }
        : null,
    [
      installationId,
      serverId,
      ownerClient,
      isConnected,
      hasHydratedWorkspaces,
      hasUserProjects,
      supportsPrimaryConnection,
    ],
  );
}

/** Auth remains owned by the installation panel; this guide never creates another session. */
export function VorteoGuideHost() {
  const host = useGuideHost();
  const authenticatedHost = host?.ownerAuthenticated ? host : null;
  if (!authenticatedHost) return null;
  return <GuideGate key={authenticatedHost.installationId} host={authenticatedHost} />;
}

function GuideGate({ host }: { host: GuideHost }) {
  const model = getGuide(host.installationId);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useDirectoryDemand(state.status === "hidden" ? null : host.serverId);
  useEffect(() => model.applyGate(host), [model, host]);
  if (!host.isConnected || !host.hasHydratedWorkspaces || state.status !== "open") return null;
  return <VorteoGuideView model={model} state={state} />;
}

/** Available in More only after owner sign-in and authenticated directory hydration. */
export function useOpenVorteoSetupGuide(): (() => void) | undefined {
  const host = useGuideHost();
  const open = useCallback(() => {
    if (host) getGuide(host.installationId).reopen(host);
  }, [host]);
  const ready = host?.ownerAuthenticated && host.isConnected && host.hasHydratedWorkspaces;
  return ready ? open : undefined;
}
