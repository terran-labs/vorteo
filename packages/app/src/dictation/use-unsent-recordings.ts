import { useCallback, useEffect, useState } from "react";
import type { DictationRecordingStore, UnsentDictationRecording } from "./recording-store";

/**
 * Unsent recordings no composer is showing, refreshed whenever the store reports a change.
 * Another tab's active recording is never included (see DictationRecordingStore.listUnsent).
 */
export function useUnsentRecordings(store: DictationRecordingStore | null): {
  recordings: UnsentDictationRecording[];
  refresh: () => void;
} {
  const [recordings, setRecordings] = useState<UnsentDictationRecording[]>([]);
  const refresh = useCallback(() => {
    if (!store) {
      setRecordings([]);
      return;
    }
    void store.listUnsent().then(setRecordings, () => setRecordings([]));
  }, [store]);

  useEffect(() => {
    refresh();
    return store?.subscribe((event) => {
      // Progress on a recording a composer is showing does not change the list.
      if (event.kind !== "written") {
        refresh();
      }
    });
  }, [refresh, store]);

  // Store events are per tab, so another tab's changes show up when this tab is shown again.
  useEffect(() => {
    if (!store || typeof document === "undefined") {
      return;
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh, store]);

  return { recordings, refresh };
}

/** Seconds of audio held, from the encoded size (16 kHz, 16-bit mono PCM in base64). */
export function unsentRecordingSeconds(recording: UnsentDictationRecording): number {
  return Math.round((recording.bytes * 3) / 4 / 32_000);
}

export function formatRecordingLength(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
