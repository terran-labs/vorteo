import { describe, expect, it } from "vitest";
import { getSidebarRowBackdrop } from "./sidebar-row-backdrop";

describe("getSidebarRowBackdrop", () => {
  it("keeps selected rows on the selected surface", () => {
    expect(getSidebarRowBackdrop({ selected: true })).toBe("surfaceSidebarSelected");
  });

  it("lets the pressed surface win over selection", () => {
    expect(getSidebarRowBackdrop({ selected: true, isPressed: true })).toBe("surface2");
  });
});
