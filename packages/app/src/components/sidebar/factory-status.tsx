import { StyleSheet } from "react-native-unistyles";
import { useMemo } from "react";
import { Text } from "react-native";
import { useTimeAgo } from "@/hooks/use-time-ago";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useProjectFactory } from "./factory-instructions";
import type { ProjectFactoryState } from "./project-factory";
import { freshFactoryStatus } from "./project-factory-model";

type FactoryRoleStatusLine = ProjectFactoryState["roles"][number]["status"];

/** "4 min ago", or null without a status. */
export function useFactoryStatusAge(status: FactoryRoleStatusLine | undefined): string | null {
  const date = useMemo(() => (status ? new Date(status.updatedAt) : null), [status]);
  const age = useTimeAgo(date);
  return status ? age : null;
}

export function FactoryStatusLine({
  status,
  label,
}: {
  label?: string;
  status: FactoryRoleStatusLine | undefined;
}) {
  const age = useFactoryStatusAge(status);
  return freshFactoryStatus(status) ? (
    <Text style={styles.text} numberOfLines={1}>
      {label ? `${label}: ` : ""}
      {status!.line} · {age}
    </Text>
  ) : null;
}

/** Workspaces whose rows can carry a status line: Factory roles and the optimization runner. */
export function workspaceHasStatusLine(workspace: SidebarWorkspaceEntry): boolean {
  return Boolean(
    workspace.factoryMembership || workspace.systemMembership?.role === "optimization-runner",
  );
}

/** A workspace's latest fresh status report, read from its project's Factory state. */
export function useWorkspaceStatusLine(
  workspace: SidebarWorkspaceEntry,
  enabled: boolean,
): FactoryRoleStatusLine | undefined {
  const active = enabled && workspaceHasStatusLine(workspace);
  const state = useProjectFactory(workspace.serverId, workspace.projectId ?? "", active);
  if (!active) return undefined;
  const status = state.data?.roles.find(
    (role) => role.workspaceId === workspace.workspaceId,
  )?.status;
  return freshFactoryStatus(status) ?? undefined;
}

/** The second row of a workspace, shown when the status line setting is Always. */
export function WorkspaceStatusLine({
  workspace,
  enabled,
}: {
  workspace: SidebarWorkspaceEntry;
  enabled: boolean;
}) {
  const status = useWorkspaceStatusLine(workspace, enabled);
  return status ? <FactoryStatusLine status={status} /> : null;
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
