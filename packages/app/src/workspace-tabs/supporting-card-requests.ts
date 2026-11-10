import { usePanelStore } from "@/stores/panel-store";
import { create } from "zustand";
import type { WorkspaceTabTarget } from "./model";

type InlineChangesKind = "changes_tree" | "pull_request";

interface SupportingCardRequests {
  requests: Record<string, { kind: WorkspaceTabTarget["kind"]; revision: number }>;
  /** Which phone tile the shared "changes" disclosure belongs to, per workspace. */
  inlineChangesKind: Record<string, InlineChangesKind>;
}

// Ephemeral navigation intent, not a saved layout. A repeated command must reveal
// a folded card even when its tab was already the selected supporting view.
export const useSupportingCardRequests = create<SupportingCardRequests>(() => ({
  requests: {},
  inlineChangesKind: {},
}));

// Visible phone detail tiles, per workspace. Without one, phone navigation falls back to a sheet
// so callers outside an agent conversation, such as terminals and drafts, still show the view.
const inlineTileHosts = new Map<string, number>();

export function registerInlineDetailTiles(workspaceKey: string): () => void {
  inlineTileHosts.set(workspaceKey, (inlineTileHosts.get(workspaceKey) ?? 0) + 1);
  return () => {
    const count = (inlineTileHosts.get(workspaceKey) ?? 1) - 1;
    if (count > 0) inlineTileHosts.set(workspaceKey, count);
    else inlineTileHosts.delete(workspaceKey);
  };
}

export function hasInlineDetailTiles(workspaceKey: string): boolean {
  return (inlineTileHosts.get(workspaceKey) ?? 0) > 0;
}

export function requestSupportingCard(
  workspaceKey: string,
  kind: WorkspaceTabTarget["kind"],
  layout: "inline" | "sidebar" = "sidebar",
) {
  usePanelStore
    .getState()
    .setSupportingCardExpanded(kind === "files" ? "files" : "changes", true, layout);
  useSupportingCardRequests.setState((state) => ({
    inlineChangesKind:
      kind === "changes_tree" || kind === "pull_request"
        ? { ...state.inlineChangesKind, [workspaceKey]: kind }
        : state.inlineChangesKind,
    requests: {
      ...state.requests,
      [workspaceKey]: { kind, revision: (state.requests[workspaceKey]?.revision ?? 0) + 1 },
    },
  }));
}
