import { describe, expect, it } from "vitest";
import {
  serializeTerminalReplay,
  deserializeTerminalReplay,
  shouldHandleTerminalBridgeMessage,
} from "./terminal-webview-message-routing";

describe("terminal WebView message routing", () => {
  it("rejects terminal messages from a stale stream", () => {
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "input", streamKey: "terminal-a" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-b" },
      ),
    ).toBe(false);
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "resize", streamKey: "terminal-a" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-b" },
      ),
    ).toBe(false);
  });

  it("rejects the old WebView stream while React is switching callbacks", () => {
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "input", streamKey: "terminal-a" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-a" },
      ),
    ).toBe(false);
  });

  it("accepts messages from the mounted stream and unscoped diagnostics", () => {
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "input", streamKey: "terminal-b" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-b" },
      ),
    ).toBe(true);
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "debug" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-b" },
      ),
    ).toBe(true);
  });
});

describe("terminal WebView replay serialization", () => {
  it("retains replay size/history metadata and end boundaries across JSON", () => {
    const begin = { type: "begin" as const, rows: 42, cols: 120, retainedHistoryLines: 3000 };
    expect(
      deserializeTerminalReplay(JSON.parse(JSON.stringify(serializeTerminalReplay(begin)))),
    ).toEqual(begin);
    expect(deserializeTerminalReplay(serializeTerminalReplay({ type: "end" }))).toEqual({
      type: "end",
    });
  });

  it("preserves raw bytes and split UTF-8 replay chunks instead of interpreting snapshots", () => {
    const chunks = [
      new Uint8Array([0xf0, 0x9f]),
      new Uint8Array([0x98, 0x80, 0x1b, 0x5b, 0x32, 0x4a]),
    ];
    const decoder = new TextDecoder();
    let result = "";
    for (const data of chunks) {
      const event = deserializeTerminalReplay(
        JSON.parse(JSON.stringify(serializeTerminalReplay({ type: "data", data }))),
      );
      expect(event.type).toBe("data");
      if (event.type === "data") {
        expect(event.data).toEqual(data);
        result += decoder.decode(event.data, { stream: true });
      }
    }
    result += decoder.decode();
    expect(result).toBe("😀\u001b[2J");
  });
});
