import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useOverlayRegistration } from "./internal/overlay-registration.web";
import { overlays } from "./internal/overlays";
import { describe, expect, it } from "vitest";
import { buildEffectiveBindings } from "./keyboard-shortcuts";
import { createKeyboardPipeline } from "./internal/pipeline";
import { createOverlayRegistry } from "./internal/overlays";
describe("DOM source adapter", () => {
  it("runs DOM input through the same resolver, preserving cancellation and cleanup", async () => {
    const { attachDomKeyboardSource } = await import("./internal/sources/dom.web");
    const actions: string[] = [];
    const input = document.createElement("textarea");
    input.dataset.testid = "message-input";
    document.body.append(input);
    input.focus();
    const pipeline = createKeyboardPipeline({
      getContext: () => ({ isMac: true, usesDesktopBindings: false, commandCenterOpen: false }),
      getBindings: () => buildEffectiveBindings({ "command-center-toggle-cmd-k-mac": "Cmd+J" }),
      isCapturing: () => false,
      dispatch: (match) => {
        actions.push(match.action);
        return true;
      },
      overlays: createOverlayRegistry(),
    });
    const detach = attachDomKeyboardSource({
      keyDown: pipeline.keyDown,
      keyUp() {},
      blur() {},
      commandCenterOpen: () => false,
    });
    const event = new KeyboardEvent("keydown", {
      key: "j",
      code: "KeyJ",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(actions).toEqual(["command-center.toggle"]);
    expect(event.defaultPrevented).toBe(true);
    detach();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", code: "KeyJ", metaKey: true, bubbles: true }),
    );
    expect(actions).toHaveLength(1);
    input.remove();
    pipeline.dispose();
  });
});

it("tooltip Escape leaves dialog focus and other keys with the dialog", async () => {
  const host = document.createElement("div");
  const tooltipHost = document.createElement("div");
  const opener = document.createElement("button");
  document.body.append(opener, host, tooltipHost);
  opener.focus();
  const dialogRoot = createRoot(host);
  const tooltipRoot = createRoot(tooltipHost);
  const calls: string[] = [];
  let tooltipUnmounted = false;
  function Dialog() {
    const ref = useOverlayRegistration({
      active: true,
      layer: 20,
      keys: ["Enter", "Escape", "Tab"],
      onKeyDown(event) {
        calls.push(`dialog:${event.key}`);
        return event.key !== "Tab";
      },
    });
    return React.createElement("div", { ref }, React.createElement("input"));
  }
  function Tooltip() {
    const ref = useOverlayRegistration({
      active: true,
      layer: 20_000,
      keys: ["Escape"],
      focusBehavior: "none",
      onKeyDown(event) {
        calls.push(`tooltip:${event.key}`);
        return event.key === "Escape";
      },
    });
    return React.createElement("div", { ref, tabIndex: -1 }, "Tooltip");
  }
  const event = (key: string) => new KeyboardEvent("keydown", { key, code: key, cancelable: true });
  try {
    act(() => dialogRoot.render(React.createElement(Dialog)));
    const input = host.querySelector("input")!;
    input.focus();
    act(() => tooltipRoot.render(React.createElement(Tooltip)));
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    expect(document.activeElement).toBe(input);
    overlays.dispatch(event("Escape"));
    overlays.dispatch(event("Enter"));
    expect(calls).toEqual(["tooltip:Escape", "tooltip:Enter", "dialog:Enter"]);
    act(() => tooltipRoot.unmount());
    tooltipUnmounted = true;
    expect(document.activeElement).toBe(input);
  } finally {
    act(() => dialogRoot.unmount());
    if (!tooltipUnmounted) act(() => tooltipRoot.unmount());
    tooltipHost.remove();
    host.remove();
    opener.remove();
  }
});

it("leaves sortable activation and cancellation to the focused grip", async () => {
  const grip = document.createElement("button");
  grip.dataset.keyboardReorder = "row";
  document.body.append(grip);
  const actions: string[] = [];
  const pipeline = createKeyboardPipeline({
    getContext: () => ({ isMac: true, usesDesktopBindings: false, commandCenterOpen: false }),
    getBindings: () => buildEffectiveBindings({}),
    isCapturing: () => false,
    dispatch(match) {
      actions.push(match.action);
      return true;
    },
    overlays: createOverlayRegistry(),
  });
  const { attachDomKeyboardSource } = await import("./internal/sources/dom.web");
  const detach = attachDomKeyboardSource({
    keyDown: pipeline.keyDown,
    keyUp() {},
    blur() {},
    commandCenterOpen: () => false,
  });
  try {
    grip.focus();
    for (const [key, code] of [
      [" ", "Space"],
      ["Escape", "Escape"],
    ]) {
      const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
      grip.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(actions).toEqual([]);
  } finally {
    detach();
    pipeline.dispose();
    grip.remove();
  }
});
