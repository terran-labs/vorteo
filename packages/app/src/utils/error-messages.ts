import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";

// Client transport failures carry these messages. They describe the connection, not the
// action, and mean nothing to the owner, so they are never shown verbatim.
const CONNECTION_ERROR_PATTERNS = [
  /^Transport (?:closed|not connected|error)\b/,
  /^Liveness check timed out\b/,
  /^Connection (?:lost|verification failed|changed|timed out)\b/,
  /^Timed? ?out waiting for connection\b/,
  /^Ping timed out\b/,
  /^Daemon client (?:closed|is disconnected|is disposed)\b/,
  /^Reconnect to an active thread\b/,
];

// A request that got no answer in time. The Host may be slow, or the socket may have died
// silently: liveness checks take about 40 to 50 seconds to notice, longer than a 30 second wait.
// So the message names both, and callers still treat it as a connection problem.
const REQUEST_TIMEOUT_PATTERNS = [
  /^Timed? ?out waiting for message\b/,
  /^Timeout waiting for message\b/,
];

// The daemon closes sockets with this reason when it stops for a restart or an update.
const HOST_RESTARTING_PATTERN = /^Server shutting down\b/;

// Daemon RPC errors append wire diagnostics after the host's message.
const RPC_DIAGNOSTIC_SUFFIX = /\s+requestType=\S+(?:\s+code=\S+)?$|\s+code=\S+$/;

function rawMessage(error: unknown): string {
  if (error instanceof Error) {
    const userMessage = (error as { userMessage?: unknown }).userMessage;
    return typeof userMessage === "string" && userMessage.trim() ? userMessage : error.message;
  }
  return String(error);
}

function normalizedMessage(error: unknown): string {
  return rawMessage(error)
    .replace(/^Error:\s*/, "")
    .trim();
}

/**
 * Why a request to the Host failed, as far as the client can tell.
 * - `connection_lost`: the connection dropped or the Host cannot be reached.
 * - `host_restarting`: the Host closed the connection announcing a restart or update.
 * - `request_timeout`: the Host did not answer in time; the connection may or may not be alive.
 * - `other`: the Host answered with an error of its own.
 */
export type HostErrorKind = "connection_lost" | "host_restarting" | "request_timeout" | "other";

export function classifyHostError(error: unknown): HostErrorKind {
  const message = normalizedMessage(error);
  if (HOST_RESTARTING_PATTERN.test(message)) return "host_restarting";
  if (REQUEST_TIMEOUT_PATTERNS.some((pattern) => pattern.test(message))) return "request_timeout";
  if (error instanceof DaemonConnectionError) {
    // Waiting for a connection that never came is a connection problem, not a slow answer.
    if (error.code === "DAEMON_REQUEST_TIMEOUT" && !/waiting for connection/i.test(message)) {
      return "request_timeout";
    }
    return "connection_lost";
  }
  if (CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return "connection_lost";
  return "other";
}

/**
 * True for transport failures callers should treat as transient: a dropped or unreachable
 * connection, a Host restart, or a request timeout, which can be a silently dead socket.
 * Only the message distinguishes them; use `classifyHostError` when the kind matters.
 */
export function isConnectionError(error: unknown): boolean {
  return classifyHostError(error) !== "other";
}

/** The message to show the owner: transport failures read plainly and wire diagnostics are dropped. */
export function toErrorMessage(error: unknown): string {
  switch (classifyHostError(error)) {
    case "connection_lost":
      return i18n.t("common.errors.hostConnectionLost");
    case "host_restarting":
      return i18n.t("common.errors.hostRestarting");
    case "request_timeout":
      return i18n.t("common.errors.hostRequestTimeout");
    case "other":
      return rawMessage(error).replace(RPC_DIAGNOSTIC_SUFFIX, "").trim();
  }
}

/**
 * Why dictation failed, chosen from the daemon's `reasonCode` when it sent one and otherwise
 * from the transport error. Unknown codes from newer daemons fall back to the error text.
 */
export type DictationFailureKind =
  | "speech_service"
  | "speech_decode_failed"
  | "speech_not_configured"
  | "stream_lost"
  | "transcription_timeout"
  | HostErrorKind;

const DICTATION_REASON_KINDS: Record<string, DictationFailureKind> = {
  speech_worker_timeout: "speech_service",
  speech_worker_exited: "speech_service",
  speech_unavailable: "speech_service",
  speech_start_timeout: "speech_service",
  speech_decode_failed: "speech_decode_failed",
  stt_not_configured: "speech_not_configured",
  stream_not_started: "stream_lost",
  transcription_timeout: "transcription_timeout",
  host_restarting: "host_restarting",
};

function readReasonCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
  return typeof reasonCode === "string" ? reasonCode : undefined;
}

export function classifyDictationError(error: unknown): DictationFailureKind {
  const reasonCode = readReasonCode(error);
  const byReason = reasonCode ? DICTATION_REASON_KINDS[reasonCode] : undefined;
  if (byReason) return byReason;
  if (/^Timeout waiting for dictation finalization\b/.test(normalizedMessage(error))) {
    return "transcription_timeout";
  }
  return classifyHostError(error);
}

const DICTATION_MESSAGE_KEYS: Record<Exclude<DictationFailureKind, "other">, string> = {
  speech_service: "message.dictation.errors.speechService",
  speech_decode_failed: "message.dictation.errors.speechDecodeFailed",
  speech_not_configured: "message.dictation.errors.speechNotConfigured",
  stream_lost: "message.dictation.errors.streamLost",
  transcription_timeout: "message.dictation.errors.transcriptionTimeout",
  host_restarting: "message.dictation.errors.hostRestarting",
  request_timeout: "common.errors.hostRequestTimeout",
  connection_lost: "common.errors.hostConnectionLost",
};

/** The owner-facing reason a dictation failed, without internal error text when a reason is known. */
export function toDictationErrorMessage(error: unknown): string {
  const kind = classifyDictationError(error);
  if (kind === "other") return toErrorMessage(error);
  return i18n.t(DICTATION_MESSAGE_KEYS[kind]);
}
