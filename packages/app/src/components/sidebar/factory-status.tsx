import { StyleSheet } from "react-native-unistyles";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { useProjectFactory } from "./factory-instructions";
import type { ProjectFactoryState } from "./project-factory";
import { freshFactoryStatus } from "./project-factory-model";
export function FactoryStatusLine({
  status,
  label,
}: {
  label?: string;
  status: ProjectFactoryState["roles"][number]["status"] | undefined;
}) {
  const date = useMemo(() => (status ? new Date(status.updatedAt) : null), [status]);
  const age = useTimeAgo(date);
  return freshFactoryStatus(status) ? (
    <Text style={styles.text} numberOfLines={1}>
      {label ? `${label}: ` : ""}
      {status!.line} · {age}
    </Text>
  ) : null;
}
export function FactoryRoleStatus({
  serverId,
  projectId,
  workspaceId,
  enabled,
}: {
  serverId: string;
  projectId: string;
  workspaceId: string;
  enabled: boolean;
}) {
  const state = useProjectFactory(serverId, projectId, enabled);
  if (!enabled) return null;
  const status = state.data?.roles.find((role) => role.workspaceId === workspaceId)?.status;
  return <FactoryStatusLine status={status} />;
}
export function FactoryFolderStatus({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string;
}) {
  const state = useProjectFactory(serverId, projectId, true);
  const lines =
    state.data?.roles.filter(
      (role) =>
        (role.role === "factory-intake" || role.role === "factory-builds") &&
        freshFactoryStatus(role.status),
    ) ?? [];
  return (
    <View style={styles.summary}>
      {lines.map((role) => (
        <FactoryStatusLine key={role.role} status={role.status} label={role.title} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  summary: { flexDirection: "row", gap: 8, overflow: "hidden" },
}));
