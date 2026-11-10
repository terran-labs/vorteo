import { useCallback, useEffect, useMemo, useState } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useWorkspace } from "@/stores/session-store-hooks";
import { usePanelStore } from "@/stores/panel-store";
import { useHasPullRequest } from "@/panels/pull-request/discovery";
import { useSheetPaneHostIfAny } from "@/screens/workspace/sheet-pane";
import { WorkspacePaneContent } from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  registerInlineDetailTiles,
  requestSupportingCard,
  useSupportingCardRequests,
} from "@/workspace-tabs/supporting-card-requests";
import { TaskCard, TaskCardHeader } from "./task-card";
import { TaskCardIcon } from "./task-card-icon";
import { CardDisclosure } from "./card-disclosure";

type DetailKind = "files" | "changes_tree" | "pull_request";
const iconKinds = { files: "files", changes_tree: "changes", pull_request: "pullRequest" } as const;
const titles = { files: "Files", changes_tree: "Changes", pull_request: "Pull request" };

/**
 * Phone workspace details share the conversation tile row and expand in place. Files they open
 * still use the sheet stack, through the workspace sheet host's pane content.
 */
export function InlineFilesCard({
  serverId,
  workspaceId,
  cwd,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string;
}) {
  const workspace = useWorkspace(serverId, workspaceId);
  const active = useRetainedPanelActive();
  const isGit = workspace?.projectKind === "git";
  const hasPullRequest = useHasPullRequest({ serverId, cwd, enabled: active && isGit });
  const workspaceKey = `${serverId}:${workspaceId}`;
  // Only the visible conversation receives phone navigation; hidden retained ones defer to sheets.
  useEffect(
    () => (active ? registerInlineDetailTiles(workspaceKey) : undefined),
    [active, workspaceKey],
  );
  const requestedChangesKind = useSupportingCardRequests(
    (state) => state.inlineChangesKind[workspaceKey] ?? "changes_tree",
  );
  // Changes and the pull request share the phone's "changes" disclosure; without a pull request
  // tile, its saved choice falls back to Changes.
  const changesKind = hasPullRequest ? requestedChangesKind : "changes_tree";
  return (
    <>
      <WorkspaceDetailTile
        kind="files"
        workspaceKey={workspaceKey}
        active={active}
        changesKind={changesKind}
      />
      {isGit ? (
        <WorkspaceDetailTile
          kind="changes_tree"
          workspaceKey={workspaceKey}
          active={active}
          changesKind={changesKind}
        />
      ) : null}
      {hasPullRequest ? (
        <WorkspaceDetailTile
          kind="pull_request"
          workspaceKey={workspaceKey}
          active={active}
          changesKind={changesKind}
        />
      ) : null}
    </>
  );
}

function WorkspaceDetailTile({
  kind,
  workspaceKey,
  active,
  changesKind,
}: {
  kind: DetailKind;
  workspaceKey: string;
  active: boolean;
  changesKind: "changes_tree" | "pull_request";
}) {
  const host = useSheetPaneHostIfAny();
  const disclosure = kind === "files" ? "files" : "changes";
  const open = usePanelStore((state) => state.inlineCardExpanded[disclosure] ?? false);
  const expanded = open && (kind === "files" || kind === changesKind);
  const collapse = useCallback(() => {
    usePanelStore.getState().setSupportingCardExpanded(disclosure, false, "inline");
  }, [disclosure]);
  const toggle = useCallback(() => {
    if (expanded) collapse();
    else requestSupportingCard(workspaceKey, kind, "inline");
  }, [collapse, expanded, kind, workspaceKey]);
  // These panels keep view state such as folded files and commits on their tab. The tile has no
  // layout tab, so it holds that state for as long as the conversation stays mounted.
  const [tabState, setTabState] = useState<WorkspaceTabDescriptor["state"]>(undefined);
  const tab = useMemo<WorkspaceTabDescriptor>(() => {
    const target = { kind } as WorkspaceTabTarget;
    const tabId = buildDeterministicWorkspaceTabId(target);
    return { key: tabId, tabId, kind, target, state: tabState };
  }, [kind, tabState]);
  const showBody = expanded && active && host !== null;
  const content = useMemo(() => {
    if (!showBody || !host) return null;
    const model = host.buildContent(tab, collapse);
    return {
      ...model,
      paneContextValue: { ...model.paneContextValue, setCurrentTabState: setTabState },
    };
  }, [showBody, host, tab, collapse]);
  const icon = useMemo(() => <TaskCardIcon kind={iconKinds[kind]} />, [kind]);
  return (
    <TaskCard bodyVisible={showBody} panelHeight="fill" testID={`supporting-card-${kind}`}>
      <TaskCardHeader>
        <CardDisclosure
          title={titles[kind]}
          expanded={showBody}
          onPress={toggle}
          icon={icon}
          testID={`supporting-card-${kind}-toggle`}
        />
      </TaskCardHeader>
      {content && host ? (
        <WorkspacePaneContent
          content={content}
          isWorkspaceFocused={host.isWorkspaceFocused}
          isPaneFocused={host.isWorkspaceFocused && active}
        />
      ) : null}
    </TaskCard>
  );
}
