import { useTranslation } from "react-i18next";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { describePreview, type PreviewDescription } from "./describe";

/**
 * What to show for a script's managed preview, or null when it has none or the daemon cannot
 * restart previews. Callers pass whether the script is a managed preview on this host.
 */
export function usePreviewDescription(
  script: WorkspaceScriptPayload,
  isManagedPreview: boolean,
): PreviewDescription | null {
  const { t, i18n } = useTranslation();
  if (!isManagedPreview || !script.preview) return null;
  return describePreview(script.preview, new Date(), i18n.language, t);
}

/** A managed preview that is starting, unavailable or waiting for repair offers no start. */
export function previewBlocksStart(
  script: WorkspaceScriptPayload,
  preview: PreviewDescription | null,
): boolean {
  return preview !== null && script.lifecycle !== "running" && preview.action === null;
}

/** The label of a managed preview's start control. */
export function previewStartLabelKey(
  preview: PreviewDescription,
): "previewStatus.actions.retry" | "previewStatus.actions.start" {
  return preview.action === "retry" ? "previewStatus.actions.retry" : "previewStatus.actions.start";
}
