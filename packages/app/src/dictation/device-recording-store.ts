import { createDeviceDictationRecordingBackend } from "./recording-backend";
import { DictationRecordingStore } from "./recording-store";

let deviceStore: DictationRecordingStore | null = null;

/** The app-wide store for dictation audio awaiting a confirmed transcript. */
export function getDeviceDictationRecordingStore(): DictationRecordingStore {
  if (!deviceStore) {
    let backend = null;
    try {
      backend = createDeviceDictationRecordingBackend();
    } catch (error) {
      console.warn("[DictationRecordingStore] Device storage unavailable", error);
    }
    deviceStore = new DictationRecordingStore(backend);
  }
  return deviceStore;
}
