import { i18n } from "@/i18n/i18next";

export type DictationStatus = "idle" | "recording" | "paused" | "uploading" | "failed";

export interface UseDictationOptions {
  client: import("@getpaseo/client/internal/daemon-client").DaemonClient | null;
  onTranscript: (text: string, meta: { requestId: string }) => void;
  onPartialTranscript?: (text: string, meta: { requestId: string }) => void;
  onError?: (error: Error) => void;
  onPermanentFailure?: (error: Error, context: { requestId: string }) => void;
  canStart?: () => boolean;
  canConfirm?: () => boolean;
  enableDuration?: boolean;
  /**
   * Thread and draft this composer belongs to. When set, captured audio is kept on the device
   * until a transcript is confirmed or discarded, and offered back when the composer mounts.
   */
  recordingScope?: string;
  /** Host the recordings are made against; removing that host deletes them. */
  recordingServerId?: string;
  /** Overrides the device store; tests pass a store over a fake backend. */
  recordingStore?: import("@/dictation/recording-store").DictationRecordingStore | null;
}

export interface UseDictationResult {
  isRecording: boolean;
  isRecordingActive: () => boolean;
  isProcessing: boolean;
  partialTranscript: string;
  volume: number;
  duration: number;
  error: string | null;
  status: DictationStatus;
  startDictation: () => Promise<void>;
  cancelDictation: (options?: DictationCancelOptions) => Promise<void>;
  confirmDictation: () => Promise<void>;
  retryFailedDictation: () => Promise<void>;
  discardFailedDictation: () => void;
  reset: () => void;
}

export interface DictationCancelOptions {
  /** "button" for an explicit press of Cancel dictation; other paths keep the audio. */
  source?: "button";
}

/** A Cancel button press on a capture shorter than this discards it instead of keeping it. */
export const SHORT_CAPTURE_DISCARD_MS = 5_000;

export const DURATION_TICK_MS = 1000;
export const PCM_DICTATION_FORMAT = "audio/pcm;rate=16000;bits=16";

export const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return new Error(error);
  }
  return new Error(i18n.t("common.errors.unexpectedDictationError"));
};
