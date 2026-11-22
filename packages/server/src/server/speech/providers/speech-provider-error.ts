/**
 * Stable failure categories raised by speech providers. Callers map `code` to a
 * wire reason and user-facing copy; the message keeps the provider's own text.
 *
 * - `speech_worker_timeout`: the speech worker did not answer within its bound.
 * - `speech_worker_exited`: the speech worker process exited while work was pending.
 * - `speech_unavailable`: the speech backend could not be reached or was shut down.
 * - `speech_decode_failed`: the recognizer reported an error for a streaming session.
 */
export type SpeechProviderErrorCode =
  | "speech_worker_timeout"
  | "speech_worker_exited"
  | "speech_unavailable"
  | "speech_decode_failed";

const SPEECH_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set<SpeechProviderErrorCode>([
  "speech_worker_timeout",
  "speech_worker_exited",
  "speech_unavailable",
  "speech_decode_failed",
]);

export function isSpeechProviderErrorCode(value: unknown): value is SpeechProviderErrorCode {
  return typeof value === "string" && SPEECH_PROVIDER_ERROR_CODES.has(value);
}

export class SpeechProviderError extends Error {
  readonly code: SpeechProviderErrorCode;

  constructor(code: SpeechProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SpeechProviderError";
    this.code = code;
  }
}

export function isSpeechProviderError(error: unknown): error is SpeechProviderError {
  return error instanceof SpeechProviderError;
}
