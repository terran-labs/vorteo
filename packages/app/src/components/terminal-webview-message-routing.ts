interface TerminalBridgeMessageIdentity {
  type: string;
  streamKey?: string;
}

export function shouldHandleTerminalBridgeMessage(
  message: TerminalBridgeMessageIdentity,
  stream: {
    desiredStreamKey: string;
    mountedStreamKey: string | null;
  },
): boolean {
  return (
    message.streamKey === undefined ||
    (message.streamKey === stream.desiredStreamKey && message.streamKey === stream.mountedStreamKey)
  );
}

/** Only the local WebView boundary serializes bytes. Host transport stays in TerminalStreamRouter. */
export type TerminalWebViewReplayEvent =
  | { type: "begin"; rows?: number; cols?: number; retainedHistoryLines?: number }
  | { type: "data"; data: number[] }
  | { type: "end" };

export function serializeTerminalReplay(
  event: import("@getpaseo/client").TerminalReplayEvent,
): TerminalWebViewReplayEvent {
  return event.type === "data" ? { type: "data", data: Array.from(event.data) } : event;
}

export function deserializeTerminalReplay(
  event: TerminalWebViewReplayEvent,
): import("@getpaseo/client").TerminalReplayEvent {
  return event.type === "data" ? { type: "data", data: Uint8Array.from(event.data) } : event;
}
