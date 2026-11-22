import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { assertDictationPcmFormat, dictationRecordingFileName, wavParts } from "./recording-wav";

export type DictationExportResult = "shared" | "downloaded" | "cancelled";

/** A WAV file written to the cache ahead of the Save audio press. */
export interface PreparedDictationExport {
  readonly fileName: string;
  /** Segments the file holds; a press for a different count must prepare again. */
  readonly segmentCount: number;
  readonly uri: string;
  release(): void;
}

/**
 * Writes the WAV file to the cache directory a part at a time through a file handle, so a long
 * recording is never held as one contiguous buffer. The stored recording is untouched.
 */
export async function prepareDictationExport(
  segments: readonly string[],
  createdAt: number,
  format: string,
): Promise<PreparedDictationExport> {
  assertDictationPcmFormat(format);
  const fileName = dictationRecordingFileName(createdAt);
  const file = new File(Paths.cache, fileName);
  if (file.exists) {
    file.delete();
  }
  file.create();
  const handle = file.open();
  try {
    for await (const part of wavParts(segments)) {
      handle.writeBytes(part);
    }
  } finally {
    handle.close();
  }
  return {
    fileName,
    segmentCount: segments.length,
    uri: file.uri,
    release: () => {
      try {
        if (file.exists) {
          file.delete();
        }
      } catch {
        // The cache directory is cleared by the system eventually.
      }
    },
  };
}

/** Opens the system share sheet for a prepared file. */
export async function shareDictationExport(
  prepared: PreparedDictationExport,
): Promise<DictationExportResult> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("File sharing is unavailable.");
  }
  await Sharing.shareAsync(prepared.uri, {
    mimeType: "audio/wav",
    dialogTitle: prepared.fileName,
    UTI: "com.microsoft.waveform-audio",
  });
  return "shared";
}
