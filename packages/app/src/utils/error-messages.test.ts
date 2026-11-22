import { expect, test } from "vitest";
import {
  DaemonConnectionError,
  DictationStreamError,
} from "@getpaseo/client/internal/daemon-client";
import {
  classifyDictationError,
  classifyHostError,
  isConnectionError,
  toErrorMessage,
} from "./error-messages";

test.each([
  [new Error("Transport closed (code 1006)"), "connection_lost"],
  [new Error("Transport not connected (status: disconnected)"), "connection_lost"],
  [new Error("Liveness check timed out (15000ms)"), "connection_lost"],
  ["Error: Transport closed", "connection_lost"],
  [new DaemonConnectionError("Anything at all"), "connection_lost"],
  [
    new DaemonConnectionError(
      "Timed out waiting for connection to send message",
      "DAEMON_REQUEST_TIMEOUT",
    ),
    "connection_lost",
  ],
  [new DaemonConnectionError("Server shutting down"), "host_restarting"],
  // A request timeout used to read as a lost connection while the connection was fine. It keeps
  // the transient connection-error path, since a silently dead socket also times out, but its
  // message no longer claims the connection dropped.
  [new Error("Timeout waiting for message (60000ms)"), "request_timeout"],
  [
    new DaemonConnectionError("Timeout waiting for message (30000ms)", "DAEMON_REQUEST_TIMEOUT"),
    "request_timeout",
  ],
  [new Error("Name taken"), "other"],
] as const)("classifies %s as %s", (error, kind) => {
  expect(classifyHostError(error)).toBe(kind);
  expect(isConnectionError(error)).toBe(kind !== "other");
});

test("keeps host messages and drops wire diagnostics", () => {
  const rpcError = Object.assign(
    new Error("Workspace is archived requestType=workspace.archive.request code=conflict"),
    { userMessage: "Workspace is archived" },
  );
  expect(toErrorMessage(rpcError)).toBe("Workspace is archived");
  expect(toErrorMessage(new Error("Name taken requestType=label.update code=conflict"))).toBe(
    "Name taken",
  );
  expect(toErrorMessage(new Error("Name taken"))).toBe("Name taken");
});

test.each([
  [new DictationStreamError("worker", { reasonCode: "speech_worker_timeout" }), "speech_service"],
  [new DictationStreamError("worker", { reasonCode: "speech_worker_exited" }), "speech_service"],
  [new DictationStreamError("start", { reasonCode: "speech_start_timeout" }), "speech_service"],
  [
    new DictationStreamError("decode", { reasonCode: "speech_decode_failed" }),
    "speech_decode_failed",
  ],
  [new DictationStreamError("off", { reasonCode: "stt_not_configured" }), "speech_not_configured"],
  [new DictationStreamError("gone", { reasonCode: "stream_not_started" }), "stream_lost"],
  [
    new DictationStreamError("slow", { reasonCode: "transcription_timeout" }),
    "transcription_timeout",
  ],
  [new DictationStreamError("bye", { reasonCode: "host_restarting" }), "host_restarting"],
  // An older daemon sends no code; a newer one may send a code this app does not know.
  [new DictationStreamError("Speech failed"), "other"],
  [new DictationStreamError("Speech failed", { reasonCode: "future_reason" }), "other"],
  [
    new DaemonConnectionError("Timeout waiting for message (30000ms)", "DAEMON_REQUEST_TIMEOUT"),
    "request_timeout",
  ],
  [new DaemonConnectionError("Transport closed (code 1006)"), "connection_lost"],
] as const)("dictation failure %s is %s", (error, kind) => {
  expect(classifyDictationError(error)).toBe(kind);
});
