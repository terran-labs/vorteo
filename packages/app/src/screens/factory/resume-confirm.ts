import type { TFunction } from "i18next";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isOwnerStop } from "./factory-reads";

/**
 * Whether one project's Resume may go ahead. Resuming a project also takes it out of any stop, so
 * a project stopped by Stop all asks first, and one held by someone else, such as Builds before a
 * restart or update, asks with a destructive warning. A hand-paused project resumes at once.
 */
export async function confirmProjectResume(
  drain: { reason: string } | null | undefined,
  t: TFunction,
): Promise<boolean> {
  if (!drain) return true;
  const owner = isOwnerStop(drain);
  return confirmDialog({
    title: t("projectFactory.stopAll.resumeProjectTitle"),
    message: t(
      owner
        ? "projectFactory.stopAll.resumeProjectMessage"
        : "projectFactory.stopAll.resumeHeldMessage",
      { reason: drain.reason },
    ),
    confirmLabel: t("projectFactory.resumeMenu"),
    destructive: !owner,
  });
}
