import { useCallback, useEffect, useRef, useState } from "react";
import {
  prepareDictationExport,
  shareDictationExport,
  type PreparedDictationExport,
} from "./recording-export";
import type { DictationRecordingStore, UnsentDictationRecording } from "./recording-store";

export type UnsentSaveState = "idle" | "preparing" | "ready";

/**
 * Save audio for recordings in the Unsent recordings list. The first press builds the file;
 * since that press's gesture is gone once the file exists, a second press shares it (iOS only
 * opens the share sheet inside a press). Saving never changes the stored recording.
 */
export function useSaveUnsentAudio(
  store: DictationRecordingStore | null,
  onError: (error: unknown) => void,
): {
  saveStates: Record<string, UnsentSaveState>;
  save: (recording: UnsentDictationRecording) => void;
} {
  const [saveStates, setSaveStates] = useState<Record<string, UnsentSaveState>>({});
  const prepared = useRef(new Map<string, PreparedDictationExport>());
  const building = useRef(new Set<string>());
  const setState = useCallback((key: string, state: UnsentSaveState) => {
    setSaveStates((current) => ({ ...current, [key]: state }));
  }, []);

  useEffect(() => {
    const files = prepared.current;
    return () => {
      for (const file of files.values()) {
        file.release();
      }
      files.clear();
    };
  }, []);

  const save = useCallback(
    (recording: UnsentDictationRecording) => {
      const ready = prepared.current.get(recording.key);
      if (ready) {
        // Inside the press: the share sheet opens.
        shareDictationExport(ready).then(
          () => setState(recording.key, "idle"),
          (error: unknown) => {
            setState(recording.key, "idle");
            onError(error);
          },
        );
        return;
      }
      if (!store || building.current.has(recording.key)) {
        return;
      }
      building.current.add(recording.key);
      setState(recording.key, "preparing");
      const build = async () => {
        try {
          const segments = await store.readUnsent(recording.key);
          const file = await prepareDictationExport(
            segments,
            recording.createdAt,
            recording.format,
          );
          prepared.current.set(recording.key, file);
          setState(recording.key, "ready");
        } catch (error) {
          setState(recording.key, "idle");
          onError(error);
        } finally {
          building.current.delete(recording.key);
        }
      };
      void build();
    },
    [onError, setState, store],
  );

  return { saveStates, save };
}
