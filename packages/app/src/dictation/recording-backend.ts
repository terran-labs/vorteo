import * as FileSystem from "expo-file-system/legacy";
import type { DictationRecordingBackend, StoredDictationRecording } from "./recording-store";

// Native apps keep recordings in the document directory, which survives app kills and is not
// purged under storage pressure the way the cache directory is.
const ROOT_NAME = "dictation-recordings/";

function segmentName(seq: number): string {
  return `${seq.toString().padStart(8, "0")}.b64`;
}

export function createDeviceDictationRecordingBackend(): DictationRecordingBackend | null {
  const documentDirectory = FileSystem.documentDirectory;
  if (!documentDirectory) {
    return null;
  }
  const root = `${documentDirectory}${ROOT_NAME}`;
  const recordingDirectory = (id: string) => `${root}${encodeURIComponent(id)}/`;
  let rootReady: Promise<void> | null = null;
  const ensureRoot = () => {
    rootReady ??= FileSystem.makeDirectoryAsync(root, { intermediates: true }).catch(
      (error: unknown) => {
        rootReady = null;
        throw error;
      },
    );
    return rootReady;
  };

  return {
    async listRecordings() {
      await ensureRoot();
      const entries = await FileSystem.readDirectoryAsync(root);
      const recordings: StoredDictationRecording[] = [];
      for (const entry of entries) {
        try {
          const text = await FileSystem.readAsStringAsync(`${root}${entry}/meta.json`);
          recordings.push(JSON.parse(text) as StoredDictationRecording);
        } catch {
          // A recording without readable metadata cannot be offered back; skip it.
        }
      }
      return recordings;
    },
    async putRecording(recording) {
      await ensureRoot();
      const directory = recordingDirectory(recording.id);
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      await FileSystem.writeAsStringAsync(`${directory}meta.json`, JSON.stringify(recording));
    },
    async putSegment(id, seq, base64Pcm) {
      await FileSystem.writeAsStringAsync(
        `${recordingDirectory(id)}${segmentName(seq)}`,
        base64Pcm,
      );
    },
    async readSegments(id, segmentCount) {
      const segments: string[] = [];
      for (let seq = 0; seq < segmentCount; seq += 1) {
        try {
          segments.push(
            await FileSystem.readAsStringAsync(`${recordingDirectory(id)}${segmentName(seq)}`),
          );
        } catch {
          break;
        }
      }
      return segments;
    },
    async deleteRecording(id) {
      await FileSystem.deleteAsync(recordingDirectory(id), { idempotent: true });
    },
    // One app process owns the files; the store's own ownership set covers several composers.
    async claim() {
      return () => undefined;
    },
  };
}
