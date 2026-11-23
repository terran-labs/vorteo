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

/**
 * What a running preview's compact list row shows. Its state comes from the broker, not from
 * the action: a newer failed or unconfirmed restart offers "try again", but the preview is
 * still not responding. An old report shows its full "Last known" line under the name
 * instead, so a long label never squeezes the name.
 */
export function runningPreviewListLabel(
  script: WorkspaceScriptPayload,
  preview: PreviewDescription | null,
):
  | { valueKey: "previewStatus.short.notResponding" | "workspace.scripts.states.running" }
  | { description: string } {
  if (preview && script.preview?.stale) return { description: preview.line };
  if (preview && script.preview?.state === "not_responding") {
    return { valueKey: "previewStatus.short.notResponding" };
  }
  return { valueKey: "workspace.scripts.states.running" };
}
