import { interfaceRect } from "./interface-geometry";
import { describe, expect, it } from "vitest";
import { interfaceZoomForKey, stepInterfaceZoom } from "./interface-zoom.web";

const key = (init: Partial<KeyboardEvent>) => ({
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...init,
});

describe("interface zoom shortcuts", () => {
  it("steps to the next multiple of 10 within the range", () => {
    expect(stepInterfaceZoom(100, 1)).toBe(110);
    expect(stepInterfaceZoom(105, 1)).toBe(110);
    expect(stepInterfaceZoom(105, -1)).toBe(100);
    expect(stepInterfaceZoom(200, 1)).toBe(200);
    expect(stepInterfaceZoom(75, -1)).toBe(75);
  });

  it("maps the platform zoom keys to interface zoom", () => {
    expect(interfaceZoomForKey(key({ key: "=", metaKey: true }), 100, true)).toBe(110);
    expect(interfaceZoomForKey(key({ key: "+", metaKey: true }), 100, true)).toBe(110);
    expect(interfaceZoomForKey(key({ key: "-", metaKey: true }), 100, true)).toBe(90);
    expect(interfaceZoomForKey(key({ key: "0", metaKey: true }), 150, true)).toBe(100);
    expect(interfaceZoomForKey(key({ code: "NumpadAdd", ctrlKey: true }), 100, false)).toBe(110);
  });

  it("leaves other modifiers and keys to their own handlers", () => {
    expect(interfaceZoomForKey(key({ key: "=", ctrlKey: true }), 100, true)).toBeNull();
    expect(interfaceZoomForKey(key({ key: "=", metaKey: true }), 100, false)).toBeNull();
    expect(
      interfaceZoomForKey(key({ key: "-", metaKey: true, altKey: true }), 100, true),
    ).toBeNull();
    expect(interfaceZoomForKey(key({ key: "1", metaKey: true }), 100, true)).toBeNull();
  });
});

describe("autocomplete anchor coordinates", () => {
  it.each([0.75, 1, 1.5, 2])("matches a normalized portal host at scale %s", (scale) => {
    // measureAtRest's web path returns browser pixels. The portal host has
    // already divided its own measurement by interface zoom.
    const anchor = interfaceRect(
      { x: 180 * scale, y: 540 * scale, width: 320 * scale, height: 44 * scale },
      scale,
    );
    const host = interfaceRect(
      { x: 40 * scale, y: 60 * scale, width: 900 * scale, height: 760 * scale },
      scale,
    );
    expect({
      left: anchor.x - host.x,
      top: anchor.y - host.y,
      width: anchor.width,
      bottom: host.height - (anchor.y - host.y),
    }).toEqual({ left: 140, top: 480, width: 320, bottom: 280 });
  });
});
