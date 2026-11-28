import type { WorkspaceSharedFile } from "@getpaseo/protocol/messages";
import { MessageSquare } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AttachmentLightbox } from "@/components/attachment-lightbox";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { useQueueAttachmentOpener } from "@/message-queue/shared-attachments";
import { hoverStyle } from "@/styles/hover";
import type { Theme } from "@/styles/theme";

const ThemedMessageSquare = withUnistyles(MessageSquare);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const FILE_ICON_SIZE = 16;
const THREAD_ICON_SIZE = 16;

type SharedFileSource = WorkspaceSharedFile["source"];

export interface SharedFileRowProps {
  serverId: string;
  file: WorkspaceSharedFile;
  threadTitle: string;
  onOpenPath: (path: string) => void;
  onOpenThread: (agentId: string) => void;
}

export function SharedFileRow({ serverId, file, onOpenPath, ...frame }: SharedFileRowProps) {
  if (file.source.type === "upload") {
    return <UploadRow serverId={serverId} file={file} source={file.source} {...frame} />;
  }
  return <LinkRow file={file} source={file.source} onOpenPath={onOpenPath} {...frame} />;
}

interface FrameProps {
  file: WorkspaceSharedFile;
  threadTitle: string;
  onOpenThread: (agentId: string) => void;
}

function LinkRow({
  source,
  onOpenPath,
  ...frame
}: FrameProps & {
  source: Extract<SharedFileSource, { type: "link" }>;
  onOpenPath: (path: string) => void;
}) {
  const open = useCallback(() => onOpenPath(source.path), [onOpenPath, source.path]);
  return <RowFrame {...frame} missing={!source.exists} busy={false} onOpen={open} />;
}

function UploadRow({
  serverId,
  source,
  ...frame
}: FrameProps & { serverId: string; source: Extract<SharedFileSource, { type: "upload" }> }) {
  const { busy, open, preview, closePreview } = useQueueAttachmentOpener({
    serverId,
    agentId: frame.file.agentId,
    messageId: source.messageId,
    attachmentId: source.attachmentId,
  });
  return (
    <>
      <RowFrame {...frame} missing={false} busy={busy} onOpen={open} />
      <AttachmentLightbox source={preview} onClose={closePreview} />
    </>
  );
}

function RowFrame({
  file,
  threadTitle,
  missing,
  busy,
  onOpen,
  onOpenThread,
}: FrameProps & { missing: boolean; busy: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const sharedAt = useMemo(() => new Date(file.timestamp), [file.timestamp]);
  const timeAgo = useCompactTimeAgo(sharedAt);
  const openThread = useCallback(() => onOpenThread(file.agentId), [file.agentId, onOpenThread]);
  const sender =
    file.role === "user" ? t("panels.sharedFiles.fromYou") : t("panels.sharedFiles.fromAgent");
  const detail = missing
    ? t("panels.sharedFiles.missing", { sender, thread: threadTitle })
    : t("panels.sharedFiles.detail", { sender, thread: threadTitle });
  return (
    <View style={styles.row} testID="shared-file-row">
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={t("panels.sharedFiles.open", { name: file.name })}
        disabled={missing || busy}
        onPress={onOpen}
        style={styles.open}
      >
        <View style={missing ? styles.dimmed : undefined}>
          <MaterialFileIcon fileName={file.name} size={FILE_ICON_SIZE} />
        </View>
        <View style={styles.text}>
          <Text numberOfLines={1} style={missing ? styles.nameMissing : styles.name}>
            {file.name}
          </Text>
          <Text numberOfLines={1} style={styles.detail}>
            {detail}
          </Text>
        </View>
        <Text style={styles.time}>{timeAgo}</Text>
      </PressHighlight>
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={t("panels.sharedFiles.openThread", { thread: threadTitle })}
        onPress={openThread}
        style={styles.thread}
        testID="shared-file-open-thread"
      >
        <ThemedMessageSquare size={THREAD_ICON_SIZE} uniProps={mutedColorMapping} />
      </PressHighlight>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[1],
  },
  open: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    ...hoverStyle({ backgroundColor: theme.colors.surface2 }),
  },
  thread: {
    width: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    ...hoverStyle({ backgroundColor: theme.colors.surface2 }),
  },
  dimmed: { opacity: theme.opacity[50] },
  text: { flex: 1, minWidth: 0 },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  nameMissing: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textDecorationLine: "line-through",
  },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  time: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
