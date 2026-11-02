import { describe, expect, it } from "vitest";

import { resolveTerminalRendererSelection } from "./terminal-renderer-capability";

describe("terminal renderer capability", () => {
  it("requires input mode replay before attaching the native renderer", () => {
    expect(resolveTerminalRendererSelection({ supportsTerminalInputModeReplay: false })).toBe(
      "update-host",
    );
  });

  it("allows the native renderer when the daemon advertises input mode replay", () => {
    expect(resolveTerminalRendererSelection({ supportsTerminalInputModeReplay: true })).toBe(
      "native-grid",
    );
  });
  it.each([false, true])(
    "keeps the explicit WebView fallback for replay capability %s",
    (supportsTerminalInputModeReplay) => {
      expect(
        resolveTerminalRendererSelection({
          useLegacyTerminalRenderer: true,
          supportsTerminalInputModeReplay,
        }),
      ).toBe("webview");
    },
  );

  it("keeps native capability gating when the legacy setting is disabled", () => {
    expect(
      resolveTerminalRendererSelection({
        useLegacyTerminalRenderer: false,
        supportsTerminalInputModeReplay: false,
      }),
    ).toBe("update-host");
    expect(
      resolveTerminalRendererSelection({
        useLegacyTerminalRenderer: false,
        supportsTerminalInputModeReplay: true,
      }),
    ).toBe("native-grid");
  });
});
