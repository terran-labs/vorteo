import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { UnsentDictationRecording } from "./recording-store";
import type { UnsentSaveState } from "./use-save-audio";
import { formatRecordingLength, unsentRecordingSeconds } from "./use-unsent-recordings";

export interface UnsentRecordingsSheetProps {
  visible: boolean;
  onClose: () => void;
  recordings: UnsentDictationRecording[];
  /** Thread title, "Draft" or "Thread not available" for a recording's scope and Host. */
  threadLabel: (recording: UnsentDictationRecording) => string;
  /** Why Retry in this composer is unavailable right now, or null when it can run. */
  retryBlockedReason: string | null;
  onRetry: (recording: UnsentDictationRecording) => void;
  saveStates: Record<string, UnsentSaveState>;
  onSave: (recording: UnsentDictationRecording) => void;
  onDiscard: (recording: UnsentDictationRecording) => void;
}

/**
 * Unsent recordings no composer is showing: orphaned (their thread is not open) or incomplete.
 * Only Discard deletes, after a confirmation that names the recording and offers Save audio.
 */
export function UnsentRecordingsSheet(props: UnsentRecordingsSheetProps) {
  const { t } = useTranslation();
  const header: SheetHeader = useMemo(() => ({ title: t("message.dictation.unsent.title") }), [t]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible={props.visible}
      onClose={props.onClose}
      desktopMaxWidth={560}
      testID="unsent-recordings-sheet"
    >
      <View style={styles.list}>
        {props.recordings.length === 0 ? (
          <Text style={styles.muted}>{t("message.dictation.unsent.empty")}</Text>
        ) : (
          props.recordings.map((recording) => (
            <UnsentRecordingRow key={recording.key} recording={recording} {...props} />
          ))
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

function UnsentRecordingRow({
  recording,
  threadLabel,
  retryBlockedReason,
  onRetry,
  saveStates,
  onSave,
  onDiscard,
}: UnsentRecordingsSheetProps & { recording: UnsentDictationRecording }) {
  const { t, i18n } = useTranslation();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const date = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(recording.createdAt),
      ),
    [i18n.language, recording.createdAt],
  );
  const length = formatRecordingLength(unsentRecordingSeconds(recording));
  const state = describeState(recording, t);
  const saveState = saveStates[recording.key] ?? "idle";
  const saveLabel = describeSave(saveState, t);
  const handleRetry = useCallback(() => onRetry(recording), [onRetry, recording]);
  const handleSave = useCallback(() => onSave(recording), [onSave, recording]);
  const askDiscard = useCallback(() => setConfirmingDiscard(true), []);
  const keep = useCallback(() => setConfirmingDiscard(false), []);
  const handleDiscard = useCallback(() => {
    setConfirmingDiscard(false);
    onDiscard(recording);
  }, [onDiscard, recording]);

  return (
    <View style={styles.row} testID="unsent-recording-row">
      <Text style={styles.title}>{`${date} · ${length}`}</Text>
      <Text style={styles.muted}>{`${threadLabel(recording)} · ${state}`}</Text>
      {confirmingDiscard ? (
        <View style={styles.confirm}>
          <Text style={styles.body}>
            {t("message.dictation.unsent.discardConfirm", { date, length })}
          </Text>
          <View style={styles.actions}>
            <Button variant="secondary" onPress={handleSave} disabled={saveState === "preparing"}>
              {saveLabel}
            </Button>
            <Button variant="destructive" onPress={handleDiscard}>
              {t("message.dictation.unsent.discard")}
            </Button>
            <Button variant="ghost" onPress={keep}>
              {t("message.dictation.unsent.keep")}
            </Button>
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Button variant="default" onPress={handleRetry} disabled={retryBlockedReason !== null}>
            {t("message.dictation.unsent.retryHere")}
          </Button>
          <Button variant="secondary" onPress={handleSave} disabled={saveState === "preparing"}>
            {saveLabel}
          </Button>
          <Button variant="ghost" onPress={askDiscard}>
            {t("message.dictation.unsent.discard")}
          </Button>
        </View>
      )}
      {retryBlockedReason && !confirmingDiscard ? (
        <Text style={styles.muted}>{retryBlockedReason}</Text>
      ) : null}
    </View>
  );
}

function describeSave(state: UnsentSaveState, t: (key: string) => string): string {
  if (state === "ready") return t("message.dictation.audioReady");
  if (state === "preparing") return t("message.dictation.preparingAudio");
  return t("message.dictation.saveAudio");
}

function describeState(recording: UnsentDictationRecording, t: (key: string) => string): string {
  const parts: string[] = [];
  if (recording.completeness === "complete") parts.push(t("message.dictation.unsent.complete"));
  else if (recording.completeness === "partial") parts.push(t("message.dictation.unsent.partial"));
  else parts.push(t("message.dictation.unsent.mayBeTruncated"));
  if (recording.memoryOnly) parts.push(t("message.dictation.unsent.memoryOnly"));
  return parts.join(" · ");
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  row: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  confirm: {
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
