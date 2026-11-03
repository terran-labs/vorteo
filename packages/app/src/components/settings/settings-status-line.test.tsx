import { describe, expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ Text: "text", View: "view" }));
vi.mock("@/styles/settings", () => ({ settingsStyles: { rowHint: {} } }));
import { SettingsStatusLine } from "./settings-status-line";

describe("SettingsStatusLine", () => {
  it("reserves the same geometry for empty, pending and error states", () => {
    const rows = [null, "Saving...", "Account synchronization needs attention."].map((message) =>
      SettingsStatusLine({ message }),
    );
    for (const row of rows) {
      expect(row.type).toBe("view");
      expect(row.props.style.height).toBe(24);
      expect(row.props.children.props.numberOfLines).toBe(1);
    }
    expect(rows[0].props.children.props.children).toBe(" ");
  });
});
