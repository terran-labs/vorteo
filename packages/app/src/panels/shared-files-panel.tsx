import type { WorkspaceSharedFile } from "@getpaseo/protocol/messages";
import { FolderClock } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Text, View, type ListRenderItemInfo } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { FlatList } from "@/components/ui/scroll-view";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { SharedFileRow } from "@/shared-files/row";
import { useSharedFiles, useSharedFilesSupported } from "@/shared-files/use-shared-files";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";

const ThemedFolderClock = withUnistyles(FolderClock);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const sharedFilesPanelPresentation = {
  label: (t) => t("panels.sharedFiles.label"),
  subtitle: (t) => t("panels.sharedFiles.subtitle"),
  tooltip: (t) => t("panels.sharedFiles.tooltip"),
  icon: ThemedFolderClock,
} satisfies PanelPresentation;

type KindFilter = "all" | WorkspaceSharedFile["kind"];

function fileKey(file: WorkspaceSharedFile): string {
  return file.source.type === "link" ? `link:${file.source.path}` : file.source.attachmentId;
}

/** Workspace files open by relative path, so a file reached both ways shares one tab. */
function tabPath(path: string, workspaceRoot: string | null): string {
  const prefix = workspaceRoot ? `${workspaceRoot.replace(/\/+$/, "")}/` : null;
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function SharedFilesPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "shared_files", "SharedFilesPanel requires shared_files target");
  const supported = useSharedFilesSupported(serverId);
  const query = useSharedFiles({ serverId, workspaceId, enabled: supported });
  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);

  if (!supported) {
    return <Notice title={t("panels.sharedFiles.unsupported")} />;
  }
  if (query.data) {
    return (
      <SharedFilesList
        serverId={serverId}
        workspaceId={workspaceId}
        files={query.data.files}
        truncated={query.data.truncated}
      />
    );
  }
  if (query.isError) {
    return (
      <Notice title={t("panels.sharedFiles.loadFailed")}>
        <Button variant="ghost" size="sm" onPress={retry}>
          {t("panels.sharedFiles.retry")}
        </Button>
      </Notice>
    );
  }
  return (
    <View style={styles.notice}>
      <ThemedLoadingSpinner size="large" uniProps={mutedColorMapping} />
    </View>
  );
}

function Notice({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.notice} testID="shared-files-notice">
      <Text style={styles.noticeTitle}>{title}</Text>
      {description ? <Text style={styles.noticeDescription}>{description}</Text> : null}
      {children}
    </View>
  );
}

function SharedFilesList({
  serverId,
  workspaceId,
  files,
  truncated,
}: {
  serverId: string;
  workspaceId: string;
  files: readonly WorkspaceSharedFile[];
  truncated: boolean;
}) {
  const { t } = useTranslation();
  const { openTab, openFileInWorkspace } = usePaneContext();
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const [kind, setKind] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");

  const kindOptions = useMemo(
    () => [
      { value: "all" as const, label: t("panels.sharedFiles.filterAll") },
      { value: "image" as const, label: t("panels.sharedFiles.filterImages") },
      { value: "file" as const, label: t("panels.sharedFiles.filterFiles") },
    ],
    [t],
  );
  const untitled = t("panels.sharedFiles.untitledThread");
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return files.flatMap((file) => {
      const threadTitle = agents?.get(file.agentId)?.title?.trim() || untitled;
      const matchesKind = kind === "all" || file.kind === kind;
      const matchesSearch =
        !needle ||
        file.name.toLowerCase().includes(needle) ||
        threadTitle.toLowerCase().includes(needle);
      return matchesKind && matchesSearch ? [{ file, threadTitle }] : [];
    });
  }, [agents, files, kind, search, untitled]);

  const openPath = useCallback(
    (path: string) => {
      openFileInWorkspace({
        location: { path: tabPath(path, workspaceRoot) },
        disposition: "preferred",
      });
    },
    [openFileInWorkspace, workspaceRoot],
  );
  const openThread = useCallback(
    (agentId: string) => openTab({ kind: "agent", agentId }),
    [openTab],
  );
  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<(typeof rows)[number]>) => (
      <SharedFileRow
        serverId={serverId}
        file={item.file}
        threadTitle={item.threadTitle}
        onOpenPath={openPath}
        onOpenThread={openThread}
      />
    ),
    [openPath, openThread, serverId],
  );

  if (files.length === 0) {
    return (
      <Notice
        title={t("panels.sharedFiles.emptyTitle")}
        description={t("panels.sharedFiles.emptyDescription")}
      />
    );
  }
  return (
    <View style={styles.container} testID="shared-files-panel">
      <View style={styles.controls}>
        <SearchField
          value={search}
          onChangeText={setSearch}
          placeholder={t("panels.sharedFiles.searchPlaceholder")}
          clearAccessibilityLabel={t("panels.sharedFiles.clearSearch")}
          style={styles.search}
          testID="shared-files-search"
        />
        <SegmentedControl
          size="sm"
          options={kindOptions}
          value={kind}
          onValueChange={setKind}
          accessibilityLabel={t("panels.sharedFiles.filterLabel")}
          testID="shared-files-kind"
        />
      </View>
      {rows.length === 0 ? (
        <Notice title={t("panels.sharedFiles.noMatches")} />
      ) : (
        <FlatList
          data={rows}
          renderItem={renderRow}
          keyExtractor={rowKey}
          contentContainerStyle={styles.list}
          ListFooterComponent={truncated ? TruncatedNote : null}
        />
      )}
    </View>
  );
}

function TruncatedNote() {
  const { t } = useTranslation();
  return <Text style={styles.truncated}>{t("panels.sharedFiles.truncated")}</Text>;
}

function rowKey(row: { file: WorkspaceSharedFile }): string {
  return fileKey(row.file);
}

export const sharedFilesPanelRegistration = definePanel("shared_files", {
  component: SharedFilesPanel,
  presentation: sharedFilesPanelPresentation,
});

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  search: { flexGrow: 1, flexBasis: 200 },
  list: { paddingHorizontal: theme.spacing[2], paddingBottom: theme.spacing[4] },
  truncated: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  notice: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 24,
  },
  noticeTitle: { color: theme.colors.foreground },
  noticeDescription: { color: theme.colors.foregroundMuted, textAlign: "center" },
}));
