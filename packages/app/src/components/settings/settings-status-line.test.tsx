import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("react-native", () => ({
  Text: "text",
  View: "view",
  useWindowDimensions: () => ({ fontScale: 2 }),
}));
vi.mock("@/styles/settings", () => ({ settingsStyles: { rowHint: {} } }));
import { SettingsStatusLine } from "./settings-status-line";

describe("SettingsStatusLine", () => {
  it("reserves two scaled lines and announces only non-empty messages", () => {
    const empty = renderToStaticMarkup(<SettingsStatusLine />);
    const full = renderToStaticMarkup(
      <SettingsStatusLine message="An error with the full explanation" testID="status" />,
    );
    expect(empty).toContain("min-height:80px");
    expect(full).toContain("min-height:80px");
    expect(empty).not.toContain("polite");
    expect(empty).not.toContain("accessibilityLabel");
    // The full message stays in the text node; a copied label would collide with field labels.
    expect(full).not.toContain("accessibilityLabel");
    expect(full).toContain("An error with the full explanation");
    expect(full).toContain('numberOfLines="2"');
    expect(full).toContain('accessibilityLiveRegion="polite"');
  });
});
