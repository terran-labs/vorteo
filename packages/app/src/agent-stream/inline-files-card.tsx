import { useCallback, useMemo } from "react";
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
  return (
    <>
      <WorkspaceDetailTile kind="files" workspaceKey={workspaceKey} />
      {isGit ? <WorkspaceDetailTile kind="changes_tree" workspaceKey={workspaceKey} /> : null}
      {hasPullRequest ? (
        <WorkspaceDetailTile kind="pull_request" workspaceKey={workspaceKey} />
      ) : null}
    </>
  );
}

function WorkspaceDetailTile({ kind, workspaceKey }: { kind: DetailKind; workspaceKey: string }) {
  const host = useSheetPaneHostIfAny();
  // Changes and the pull request share the phone's "changes" disclosure; the most recent request
  // decides which of the two is open, so they never expand together.
  const changesOpen = usePanelStore((state) => state.inlineCardExpanded.changes ?? false);
  const filesOpen = usePanelStore((state) => state.inlineCardExpanded.files ?? false);
  const requestedKind = useSupportingCardRequests(
    (state) => state.requests[workspaceKey]?.kind ?? null,
  );
  const expanded =
    kind === "files"
      ? filesOpen
      : changesOpen && (requestedKind === "pull_request") === (kind === "pull_request");
  const toggle = useCallback(() => {
    if (expanded) {
      usePanelStore
        .getState()
        .setSupportingCardExpanded(kind === "files" ? "files" : "changes", false, "inline");
      return;
    }
    requestSupportingCard(workspaceKey, kind, "inline");
  }, [expanded, kind, workspaceKey]);
  const tab = useMemo<WorkspaceTabDescriptor>(() => {
    const target = { kind } as WorkspaceTabTarget;
    const tabId = buildDeterministicWorkspaceTabId(target);
    return { key: tabId, tabId, kind, target };
  }, [kind]);
  const collapse = useCallback(() => {
    usePanelStore
      .getState()
      .setSupportingCardExpanded(kind === "files" ? "files" : "changes", false, "inline");
  }, [kind]);
  const content = useMemo(
    () => (host && expanded ? host.buildContent(tab, collapse) : null),
    [host, expanded, tab, collapse],
  );
  const icon = useMemo(() => <TaskCardIcon kind={iconKinds[kind]} />, [kind]);
  return (
    <TaskCard bodyVisible={expanded} panelHeight="fill" testID={`supporting-card-${kind}`}>
      <TaskCardHeader>
        <CardDisclosure
          title={titles[kind]}
          expanded={expanded}
          onPress={toggle}
          icon={icon}
          testID={`supporting-card-${kind}-toggle`}
        />
      </TaskCardHeader>
      {content && host ? (
        <WorkspacePaneContent
          content={content}
          isWorkspaceFocused={host.isWorkspaceFocused}
          isPaneFocused={host.isWorkspaceFocused}
        />
      ) : null}
    </TaskCard>
  );
}
