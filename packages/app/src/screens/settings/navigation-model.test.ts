import { expect, it } from "vitest";
import { sectionForPath, settingsLink, matchPanes } from "./navigation-model";
import { SETTINGS_SECTIONS, panesForSection } from "@/settings-catalog/catalog";
const context = {
  isDesktopApp: true,
  isWeb: true,
  isNative: false,
  hasHosts: true,
  hasInstallation: true,
  hardwareKeyboardPresent: true,
};
it("resolves old addresses and preserves precise row links", () => {
  expect(sectionForPath("/settings/hosts/example/host")).toBe("environments");
  expect(sectionForPath("/settings/accounts")).toBe("providers");
  expect(sectionForPath("/settings/appearance")).toBe("interface");
  expect(sectionForPath("/settings/maintenance")).toBe("system");
  expect(settingsLink("interface", "appearance.theme")).toBe(
    "/settings/interface?setting=appearance.theme",
  );
});
it("finds moved panes by their row or section terms", () => {
  const sections = SETTINGS_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    panes: panesForSection(section.id, context),
  }));
  expect(matchPanes(sections, "data saver")).toContain("privacy.dataSaver");
  expect(matchPanes(sections, "terminal")).toContain("terminal.terminal");
  expect(matchPanes(sections, "System")).toContain("general.about");
});
