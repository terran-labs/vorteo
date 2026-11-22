import { assertDictationPcmFormat, dictationRecordingFileName, wavParts } from "./recording-wav";

export type DictationExportResult = "shared" | "downloaded" | "cancelled";

/** A WAV file built ahead of the Save audio press. */
export interface PreparedDictationExport {
  readonly fileName: string;
  /** Segments the file holds; a press for a different count must prepare again. */
  readonly segmentCount: number;
  readonly file: Blob;
  release(): void;
}

/**
 * Builds the WAV file in the background, a batch of segments at a time, from a header and one
 * part per segment. The browser assembles the Blob from those parts, so no large contiguous copy
 * is made in JavaScript.
 */
export async function prepareDictationExport(
  segments: readonly string[],
  createdAt: number,
  format: string,
): Promise<PreparedDictationExport> {
  assertDictationPcmFormat(format);
  const fileName = dictationRecordingFileName(createdAt);
  const parts: BlobPart[] = [];
  for await (const part of wavParts(segments)) {
    parts.push(part);
  }
  const blob =
    typeof File === "function"
      ? new File(parts, fileName, { type: "audio/wav" })
      : new Blob(parts, { type: "audio/wav" });
  // The browser now owns the bytes; drop the decoded parts so only one copy stays alive.
  parts.length = 0;
  return {
    fileName,
    segmentCount: segments.length,
    file: blob,
    // Dropping the reference to the prepared export lets the browser free the file.
    release: () => undefined,
  };
}

/**
 * Shares or downloads a prepared file. Must run directly in the press handler: share() needs
 * the user's gesture on iOS, so nothing here awaits before it. A refused share is reported as a
 * failure, never retried as a download outside the gesture where it would silently do nothing.
 */
export function shareDictationExport(
  prepared: PreparedDictationExport,
): Promise<DictationExportResult> {
  const file = prepared.file;
  const canShareFile =
    typeof File === "function" &&
    file instanceof File &&
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });

  if (canShareFile) {
    return navigator.share({ files: [file as File], title: prepared.fileName }).then(
      () => "shared" as const,
      (error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") {
          return "cancelled" as const;
        }
        throw error instanceof Error ? error : new Error(String(error));
      },
    );
  }
  download(file, prepared.fileName);
  return Promise.resolve("downloaded");
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start reading the download before releasing its URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
