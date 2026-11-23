import { useCallback, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useSessionStore } from "@/stores/session-store";
import type { AdoptUnsentResult } from "@/hooks/use-dictation.shared";
import { getDeviceDictationRecordingStore } from "./device-recording-store";
import type { DictationRecordingStore, UnsentDictationRecording } from "./recording-store";
import { UnsentRecordingsSheet } from "./unsent-recordings-sheet";
import { useSaveUnsentAudio } from "./use-save-audio";
import { useUnsentRecordings } from "./use-unsent-recordings";

/**
 * Every place the Unsent recordings list opens from lives here, so moving it touches one file:
 * today a quiet line above the composer and a control on the failed dictation overlay.
 */

/** Dismissing the composer line hides it for the rest of this page session. */
let noticeDismissedForSession = false;

export interface UnsentRecordingsEntryOptions {
  /** The composer can take a recording: not recording, sending or holding unsent audio. */
  isComposerIdle: boolean;
  /** Fullscreen editing hides the composer line. */
  isFullscreen: boolean;
  adoptUnsentRecording: (key: string) => Promise<AdoptUnsentResult>;
  onError: (error: Error) => void;
  /** Tests pass their own store. */
  store?: DictationRecordingStore | null;
}

export interface UnsentRecordingsEntry {
  /** One quiet, dismissible line for above the composer, or null. */
  composerNotice: ReactNode;
  /** The failed overlay's control, or null when there is nothing else to list. */
  overlayAction: { label: string; onPress: () => void } | null;
  /** The sheet; render it once. */
  sheet: ReactNode;
}

export function useUnsentRecordingsEntry(
  options: UnsentRecordingsEntryOptions,
): UnsentRecordingsEntry {
  const { t } = useTranslation();
  const store = options.store === undefined ? getDeviceDictationRecordingStore() : options.store;
  const { recordings, refresh } = useUnsentRecordings(store);
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(noticeDismissedForSession);
  const { onError } = options;
  const { saveStates, save } = useSaveUnsentAudio(store, () =>
    onError(new Error(t("message.dictation.saveFailed"))),
  );

  const open = useCallback(() => {
    refresh();
    setVisible(true);
  }, [refresh]);
  const close = useCallback(() => setVisible(false), []);
  const dismiss = useCallback(() => {
    noticeDismissedForSession = true;
    setDismissed(true);
  }, []);

  const threadLabel = useCallback(
    (recording: UnsentDictationRecording) => resolveThreadLabel(recording, t),
    [t],
  );
  const retryBlockedReason = options.isComposerIdle ? null : t("message.dictation.unsent.busy");
  const { adoptUnsentRecording } = options;
  const onRetry = useCallback(
    (recording: UnsentDictationRecording) => {
      const retry = async () => {
        let result: AdoptUnsentResult;
        try {
          result = await adoptUnsentRecording(recording.key);
        } catch (error) {
          // The store let the recording go again, so it stays in every tab's list.
          console.warn("[UnsentRecordings] Retry could not take the recording", error);
          onError(new Error(t("message.dictation.unsent.retryFailed")));
          refresh();
          return;
        }
        if (result === "adopted") {
          setVisible(false);
          return;
        }
        const key =
          result === "busy" ? "message.dictation.unsent.busy" : "message.dictation.unsent.gone";
        onError(new Error(t(key)));
        refresh();
      };
      void retry();
    },
    [adoptUnsentRecording, onError, refresh, t],
  );
  const onDiscard = useCallback(
    (recording: UnsentDictationRecording) => {
      if (!store) {
        return;
      }
      const discard = async () => {
        try {
          // Refused when another composer or tab took it after this list was built.
          if ((await store.discardUnsent(recording.key)) === "unavailable") {
            onError(new Error(t("message.dictation.unsent.gone")));
          }
        } catch (error) {
          console.warn("[UnsentRecordings] Discard failed", error);
        }
        refresh();
      };
      void discard();
    },
    [onError, refresh, store, t],
  );

  const count = recordings.length;
  const composerNotice =
    count > 0 && options.isComposerIdle && !options.isFullscreen && !dismissed ? (
      <View style={styles.notice} testID="unsent-recordings-notice">
        <Button variant="ghost" size="sm" onPress={open}>
          {t("message.dictation.unsent.notice", { count })}
        </Button>
        <ToolbarButton label={t("message.dictation.unsent.dismiss")} compact onPress={dismiss}>
          <X size={14} />
        </ToolbarButton>
      </View>
    ) : null;

  const overlayAction = useMemo(
    () =>
      count > 0 ? { label: t("message.dictation.unsent.overlayAction"), onPress: open } : null,
    [count, open, t],
  );

  const sheet = (
    <UnsentRecordingsSheet
      visible={visible}
      onClose={close}
      recordings={recordings}
      threadLabel={threadLabel}
      retryBlockedReason={retryBlockedReason}
      onRetry={onRetry}
      saveStates={saveStates}
      onSave={save}
      onDiscard={onDiscard}
    />
  );

  return { composerNotice, overlayAction, sheet };
}

/**
 * The thread a recording belongs to. A thread the session store has not loaded (archived, paged
 * out or on another Host) is "not available", never "no longer exists".
 */
function resolveThreadLabel(
  recording: UnsentDictationRecording,
  t: (key: string) => string,
): string {
  const agentId = recording.scope.startsWith("dictation:")
    ? recording.scope.slice("dictation:".length)
    : recording.scope;
  if (agentId.startsWith("new-workspace") || agentId.startsWith("draft")) {
    return t("message.dictation.unsent.draft");
  }
  const sessions = useSessionStore.getState().sessions;
  const serverIds = recording.serverId ? [recording.serverId] : Object.keys(sessions);
  for (const serverId of serverIds) {
    const title = sessions[serverId]?.agents.get(agentId)?.title;
    if (title) {
      return title;
    }
  }
  return t("message.dictation.unsent.threadUnavailable");
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[1],
  },
}));
