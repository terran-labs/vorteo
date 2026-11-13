import { CardColumnAccessory } from "@/agent-stream/columns/card-column";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSubagentsForParent, useArchiveFinishedSubagents } from "@/subagents";
import { useHasPluginComposerPills } from "@/plugins";
import { memo, useCallback, useMemo, type ReactElement } from "react";

import { ChecklistCard } from "@/task-checklist/card";
import { JournalCard } from "@/journal/card";
import { OpenQuestionsCard } from "@/open-questions/card";
import { PreviewsCard } from "@/previews/card";
import { ContextCard } from "@/components/context-breakdown/card";

import { useIsCompactFormFactor } from "@/constants/layout";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { usePaneContext } from "@/panels/pane-context";
import { useSettings } from "@/hooks/use-settings";
import { PluginComposerPills } from "@/plugins";
import { useSessionStore } from "@/stores/session-store";
import {
  type ArchiveFinishedStatus,
  useArchiveSubagent,
  useDetachSubagent,
  useSubagentSheetTab,
  type SubagentRow,
} from "@/subagents";

import { SubagentsTrack } from "@/subagents/track";
import { ParentAgentPill, useParentAgentId } from "@/subagents/parent";
import type { TodoEntry } from "@/types/stream";

import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";

export const AgentTracks = memo(function AgentTracks({
  serverId,
  workspaceId,
  agentId,
  parentAgentId,
  subagentRows,
  tasks,
  archiveFinishedStatus,
  onArchiveFinished,
  hasPluginComposerPills,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  parentAgentId?: string | null;
  subagentRows: SubagentRow[];
  tasks: TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
  hasPluginComposerPills: boolean;
}): ReactElement | null {
  const { tabId } = usePaneContext();

  const isCompact = useIsCompactFormFactor();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent();
  const detachSubagent = useDetachSubagent();
  const openSubagentTarget = useCallback(
    (target: WorkspaceTabTarget) => {
      openPreferredWorkspaceTarget({
        workspaceKey,
        target,
        source: "subagents",
        preferences: openInSidePane,
        parentTabId: tabId,
      });
    },
    [openInSidePane, tabId, workspaceKey],
  );
  const handleOpenSubagent = useCallback(
    ({ serverId: targetServerId, agentId: subagentId }: AgentAddress) => {
      const session = useSessionStore.getState().sessions[targetServerId];
      const agent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);
      // A subagent in another workspace lives in that workspace's tabs.
      if (
        targetServerId !== serverId ||
        (agent?.workspaceId && agent.workspaceId !== workspaceId)
      ) {
        navigateToAgent({ serverId: targetServerId, agentId: subagentId });
        return;
      }
      openSubagentTarget({ kind: "agent", agentId: subagentId });
    },
    [openSubagentTarget, serverId, workspaceId],
  );
  const handleOpenProviderSubagent = useCallback(
    (ownerAgentId: string, subagentId: string) => {
      openSubagentTarget({
        kind: "provider_subagent",
        parentAgentId: ownerAgentId,
        subagentId,
      });
    },
    [openSubagentTarget],
  );
  const sheetTabFor = useSubagentSheetTab(workspaceKey, tabId);

  return (
    <>
      {parentAgentId ? (
        <CardColumnAccessory>
          <View style={styles.pills}>
            <ParentAgentPill serverId={serverId} parentAgentId={parentAgentId} />
          </View>
        </CardColumnAccessory>
      ) : null}
      <OpenQuestionsCard key={`questions:${agentId}`} serverId={serverId} agentId={agentId} />
      <ChecklistCard
        key={`checklist:${agentId}`}
        serverId={serverId}
        agentId={agentId}
        tasks={tasks}
      />
      <JournalCard key={agentId} serverId={serverId} agentId={agentId} />
      <PreviewsCard key={`previews:${agentId}`} serverId={serverId} agentId={agentId} />
      <ContextCard key={`context:${agentId}`} serverId={serverId} agentId={agentId} />
      <SubagentsTrack
        inline
        serverId={serverId}
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        sheetTabFor={sheetTabFor}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      {hasPluginComposerPills ? (
        <CardColumnAccessory>
          <View style={styles.pills} testID="agent-history-plugin-pills">
            <PluginComposerPills
              serverId={serverId}
              workspaceId={workspaceId}
              agentId={agentId}
              compact={isCompact}
            />
          </View>
        </CardColumnAccessory>
      ) : null}
    </>
  );
});

export function hasAgentTracks({
  parentAgentId,
  subagentRows,
  tasks,
  archiveFinishedStatus,
  hasPluginComposerPills = false,
}: {
  parentAgentId?: string | null;
  subagentRows: readonly SubagentRow[];
  tasks: readonly TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  hasPluginComposerPills?: boolean;
}): boolean {
  return (
    Boolean(parentAgentId) ||
    subagentRows.length > 0 ||
    Boolean(tasks?.length) ||
    archiveFinishedStatus.kind !== "idle" ||
    hasPluginComposerPills
  );
}

export function AgentHistoryTracks({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  cwd: string;
}) {
  const subagentRows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const tasks = useSessionStore((state) => {
    const session = state.sessions[serverId];
    // The daemon snapshot includes the latest checklist even outside the loaded timeline window.
    if (session?.serverInfo?.features?.agentTaskSnapshots)
      return session.agents.get(agentId)?.tasks;
    // COMPAT (2026-10): older daemons expose checklists only through loaded timeline events.
    return session?.agentTasks.get(agentId);
  });
  // With a composer the parent is a pill that leads the cards; a sheet shows its callout instead.
  const showsComposer = usePaneContext().host !== "sheet";
  const parentAgentId = useParentAgentId(serverId, agentId);
  const managedRows = useMemo(
    () => subagentRows.filter((row) => row.kind === "paseo"),
    [subagentRows],
  );
  const archive = useArchiveFinishedSubagents({
    serverId,
    parentAgentId: agentId,
    rows: managedRows,
  });
  const hasPluginComposerPills = useHasPluginComposerPills(serverId, workspaceId, agentId);
  return (
    <AgentTracks
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId}
      parentAgentId={showsComposer ? parentAgentId : null}
      subagentRows={subagentRows}
      tasks={tasks}
      archiveFinishedStatus={archive.status}
      onArchiveFinished={archive.archiveFinished}
      hasPluginComposerPills={hasPluginComposerPills}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  pills: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1], alignItems: "center" },
}));
