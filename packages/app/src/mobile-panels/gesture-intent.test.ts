/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { View } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { useEdgePanReservation } from "./edge-pan-reservation.web";

import { resolveMobilePanelGestureIntent } from "./gesture-intent";

describe("mobile panel gesture intent", () => {
  it("blocks both panel-opening directions while the active surface owns horizontal dragging", () => {
    expect([
      resolveMobilePanelGestureIntent({
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: true,
      }),
      resolveMobilePanelGestureIntent({
        deltaX: -40,
        deltaY: 2,
        direction: -1,
        openGesturesBlocked: true,
      }),
    ]).toEqual(["fail", "fail"]);
  });

  it("keeps ordinary horizontal panel gestures available when unblocked", () => {
    expect([
      resolveMobilePanelGestureIntent({
        deltaX: 40,
        deltaY: 2,
        direction: 1,
        openGesturesBlocked: false,
      }),
      resolveMobilePanelGestureIntent({
        deltaX: -40,
        deltaY: 2,
        direction: -1,
        openGesturesBlocked: false,
      }),
    ]).toEqual(["activate", "activate"]);
  });
});

it("releases edge touch ownership on cancellation and route changes without trapping other scrolling", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let route = "settings";
  let enabled = true;
  function Harness() {
    const { ref } = useEdgePanReservation(
      "left",
      () => enabled,
      () => route,
    );
    return createElement("div", {
      ref: (node: HTMLDivElement | null) => {
        ref.current = node as unknown as View;
      },
    });
  }
  const touch = (type: string, x: number, y = 100, count = 1) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", {
      value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })),
    });
    container.firstElementChild!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    act(() => root.render(createElement(Harness)));
    touch("touchstart", 1);
    expect(touch("touchmove", 5)).toBe(false);
    expect(touch("touchmove", 25)).toBe(true);
    container.firstElementChild!.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    expect(touch("touchmove", 50)).toBe(false);
    touch("touchstart", 1);
    route = "workspace";
    expect(touch("touchmove", 25)).toBe(false);
    touch("touchstart", 150);
    expect(touch("touchmove", 190)).toBe(false);
    touch("touchstart", 1);
    expect(touch("touchmove", 3, 140)).toBe(false);
    expect(touch("touchmove", 50, 140)).toBe(false);
    touch("touchstart", 1);
    expect(touch("touchmove", 25, 100, 2)).toBe(false);
    enabled = false;
    touch("touchstart", 1);
    expect(touch("touchmove", 25)).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
