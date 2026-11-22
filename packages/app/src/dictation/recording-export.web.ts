import { buildDictationWav, dictationRecordingFileName } from "./recording-wav";

export type DictationExportResult = "shared" | "downloaded" | "cancelled";

/**
 * Saves a recording as a WAV file. Uses the Web Share API with a file where the browser offers
 * it (iOS Safari and the installed PWA, where a download link does nothing useful), otherwise a
 * download. Must be called directly from the button press: share() needs the user's gesture, so
 * nothing here awaits before it.
 */
export function exportDictationRecording(
  segments: readonly string[],
  createdAt: number,
): Promise<DictationExportResult> {
  const fileName = dictationRecordingFileName(createdAt);
  const wav = buildDictationWav(segments);
  const blob = new Blob([wav], { type: "audio/wav" });
  const file =
    typeof File === "function" ? new File([blob], fileName, { type: "audio/wav" }) : null;
  const canShareFile =
    file !== null &&
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });

  if (canShareFile) {
    return navigator.share({ files: [file], title: fileName }).then(
      () => "shared" as const,
      (error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") {
          return "cancelled" as const;
        }
        // A share that is refused (for example after the gesture expired) still saves the file.
        download(blob, fileName);
        return "downloaded" as const;
      },
    );
  }
  download(blob, fileName);
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
