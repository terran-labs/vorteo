import { describe, expect, it } from "vitest";
import { createOverlayRegistry } from "./overlays";

function keyEvent(key: string) {
  return {
    key,
    code: key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    preventDefault() {},
    stopPropagation() {},
  };
}

describe("overlay keyboard ownership", () => {
  it("offers a key only to the highest layer and consumes it once without DOM focus", () => {
    const registry = createOverlayRegistry();
    const calls: string[] = [];
    const remove = registry.register({
      getLayer: () => 20,
      getKeys: () => ["Escape"],
      onKeyDown: (event) => {
        calls.push(`modal:${event.key}`);
        return true;
      },
    });
    const removeMenu = registry.register({
      getLayer: () => 30,
      getKeys: () => ["Enter"],
      onKeyDown: (event) => {
        calls.push(`menu:${event.key}`);
        return event.key === "Enter";
      },
    });
    expect(registry.dispatch(keyEvent("Escape"))).toBe(false);
    expect(calls).toEqual(["menu:Escape"]);
    expect(registry.getKeys()).toEqual(["Enter"]);
    removeMenu();
    expect(registry.dispatch(keyEvent("Escape"))).toBe(true);
    expect(calls).toEqual(["menu:Escape", "modal:Escape"]);
    remove();
    expect(registry.dispatch(keyEvent("Escape"))).toBe(false);
  });
});

describe("overlay registration lifecycle", () => {
  it("uses the newest registration at equal layers and ignores composition", () => {
    const registry = createOverlayRegistry();
    const calls: string[] = [];
    const first = registry.register({
      getLayer: () => 20,
      getKeys: () => ["Escape"],
      onKeyDown: () => {
        calls.push("first");
        return true;
      },
    });
    const second = registry.register({
      getLayer: () => 20,
      getKeys: () => ["Enter"],
      onKeyDown: () => {
        calls.push("second");
        return true;
      },
    });
    expect(registry.dispatch({ ...keyEvent("Enter"), isComposing: true })).toBe(false);
    expect(calls).toEqual([]);
    expect(registry.dispatch(keyEvent("Enter"))).toBe(true);
    expect(calls).toEqual(["second"]);
    second();
    expect(registry.dispatch(keyEvent("Escape"))).toBe(true);
    expect(calls).toEqual(["second", "first"]);
    first();
  });

  it("notifies subscribers when top key ownership changes", () => {
    const registry = createOverlayRegistry();
    const observed: string[][] = [];
    const unsubscribe = registry.subscribe(() => observed.push([...registry.getKeys()]));
    const release = registry.register({
      getLayer: () => 20,
      getKeys: () => ["Enter"],
      onKeyDown: () => false,
    });
    release();
    release();
    unsubscribe();
    expect(observed).toEqual([["Enter"], []]);
  });
});

describe("non-interactive overlay custody", () => {
  it("offers painted previews every key and preserves tooltip dismissal and dialog ownership", () => {
    const registry = createOverlayRegistry();
    const calls: string[] = [];
    const dialog = registry.register({
      getLayer: () => 20,
      getKeys: () => ["Enter", "Tab", "Escape"],
      onKeyDown: (event) => {
        calls.push(`dialog:${event.key}`);
        return true;
      },
    });
    const preview = registry.register({
      getLayer: () => 10_000,
      getFocusBehavior: () => "none",
      getKeys: () => ["ArrowRight", "Escape"],
      onKeyDown: (event) => {
        calls.push(`preview:${event.key}`);
        return event.key === "ArrowRight";
      },
    });
    expect(registry.dispatch(keyEvent("ArrowRight"))).toBe(true);
    expect(calls).toEqual(["preview:ArrowRight"]);
    expect(registry.getTop(true)?.getLayer()).toBe(20);
    calls.length = 0;
    const tooltip = registry.register({
      getLayer: () => 20_000,
      getFocusBehavior: () => "none",
      getKeys: () => ["Escape"],
      onKeyDown: (event) => {
        calls.push(`tooltip:${event.key}`);
        return event.key === "Escape";
      },
    });
    expect(registry.hasActive()).toBe(true);
    expect(registry.dispatch(keyEvent("Escape"))).toBe(true);
    expect(calls).toEqual(["tooltip:Escape"]);
    calls.length = 0;
    expect(registry.dispatch(keyEvent("Enter"))).toBe(true);
    expect(calls).toEqual(["tooltip:Enter", "dialog:Enter"]);
    calls.length = 0;
    expect(registry.dispatch(keyEvent("Tab"))).toBe(true);
    expect(calls).toEqual(["tooltip:Tab", "dialog:Tab"]);
    expect(registry.getTop(true)?.getLayer()).toBe(20);
    dialog();
    expect(registry.hasActive()).toBe(false);
    expect(registry.dispatch(keyEvent("Tab"))).toBe(false);
    tooltip();
    preview();
  });
});
