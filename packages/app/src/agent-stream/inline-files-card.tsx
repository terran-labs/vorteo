import { useCallback, useMemo } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useHasPullRequest } from "@/panels/pull-request/discovery";
import { TaskCard, TaskCardHeader } from "./task-card";
import { TaskCardIcon } from "./task-card-icon";
import { CardDisclosure } from "./card-disclosure";

type DetailKind = "files" | "changes_tree" | "pull_request";
const iconKinds = { files: "files", changes_tree: "changes", pull_request: "pullRequest" } as const;
const titles = { files: "Files", changes_tree: "Changes", pull_request: "Pull request" };

/** Phone workspace details share the conversation tile row and the existing sheet stack. */
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
  const open = useCallback(() => {
    useWorkspaceLayoutStore
      .getState()
      .openTab({ workspaceKey, target: { kind }, intent: "reveal" });
  }, [kind, workspaceKey]);
  const icon = useMemo(() => <TaskCardIcon kind={iconKinds[kind]} />, [kind]);
  return (
    <TaskCard bodyVisible={false} testID={`supporting-card-${kind}`}>
      <TaskCardHeader>
        <CardDisclosure
          title={titles[kind]}
          expanded={false}
          onPress={open}
          icon={icon}
          testID={`supporting-card-${kind}-toggle`}
        />
      </TaskCardHeader>
    </TaskCard>
  );
}
