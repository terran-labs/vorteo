/**
 * Stable failure categories raised by speech providers. Callers map `code` to a
 * wire reason and user-facing copy; the message keeps the provider's own text.
 *
 * - `speech_worker_timeout`: the speech worker did not answer within its bound.
 * - `speech_worker_exited`: the speech worker process exited while work was pending.
 * - `speech_unavailable`: the speech backend could not be reached or was shut down.
 */
export type SpeechProviderErrorCode =
  | "speech_worker_timeout"
  | "speech_worker_exited"
  | "speech_unavailable";

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
