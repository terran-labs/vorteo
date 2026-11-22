import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { buildDictationWav, dictationRecordingFileName } from "./recording-wav";

export type DictationExportResult = "shared" | "downloaded" | "cancelled";

/** Saves a recording as a WAV file through the system share sheet. */
export async function exportDictationRecording(
  segments: readonly string[],
  createdAt: number,
): Promise<DictationExportResult> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("File sharing is unavailable.");
  }
  const fileName = dictationRecordingFileName(createdAt);
  // The cache copy is only the shared file; the stored recording is untouched.
  const file = new File(Paths.cache, fileName);
  if (file.exists) {
    file.delete();
  }
  file.write(buildDictationWav(segments));
  await Sharing.shareAsync(file.uri, {
    mimeType: "audio/wav",
    dialogTitle: fileName,
    UTI: "com.microsoft.waveform-audio",
  });
  return "shared";
}
