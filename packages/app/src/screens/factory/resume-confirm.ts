import type { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import {
  ProjectFactoryStateSchema,
  type ProjectFactoryState,
} from "@/components/sidebar/factory-state";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isOwnerStop } from "./factory-reads";
import type { FactoryInvoke } from "./queue";

/**
 * What one project's Resume may do. Resuming a project also takes it out of any stop, so:
 * a hand-paused project resumes at once; one stopped by Stop all asks first; one held by another
 * process, for example Builds before a restart or update, offers no Resume anywhere.
 */
export type ProjectResume = "direct" | "confirm" | "hidden";

export function projectResume(drain: { reason: string } | null | undefined): ProjectResume {
  if (!drain) return "direct";
  return isOwnerStop(drain) ? "confirm" : "hidden";
}

/**
 * Re-reads the project now and decides from that state: resumes are never decided on a stale
 * reading. Resolves true when the caller may resume, or a message when it now must not.
 */
export async function checkProjectResume(input: {
  client: QueryClient;
  serverId: string;
  projectId: string;
  invoke: FactoryInvoke;
  t: TFunction;
}): Promise<{ resume: boolean; message: string | null }> {
  const { client, serverId, projectId, invoke, t } = input;
  const state: ProjectFactoryState = await client.fetchQuery({
    queryKey: ["projectFactory", serverId, projectId],
    queryFn: async () =>
      ProjectFactoryStateSchema.parse(await invoke("factory.project.get", { projectId })),
    staleTime: 0,
  });
  const drain = state.drain ?? null;
  switch (projectResume(drain)) {
    case "direct":
      return { resume: true, message: null };
    case "hidden":
      return {
        resume: false,
        message: t("projectFactory.stopAll.nowHeld", { reason: drain!.reason }),
      };
    case "confirm": {
      const confirmed = await confirmDialog({
        title: t("projectFactory.stopAll.resumeProjectTitle"),
        message: t("projectFactory.stopAll.resumeProjectMessage"),
        confirmLabel: t("projectFactory.resumeMenu"),
      });
      return { resume: confirmed, message: null };
    }
  }
}
