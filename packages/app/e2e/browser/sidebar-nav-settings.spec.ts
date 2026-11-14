import { expect, test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  expectNoUsageItem,
  openCompactSidebar,
  expectCompactSidebarOpen,
} from "../support/helpers/usage-sidebar-item";
import { gotoAppShell } from "../support/helpers/app";
import {
  SHOWCASE_PLUGIN_ID,
  LEGACY_PLUGIN_ID,
  installSidebarPlugins,
} from "../support/helpers/plugin-sidebar-items";
import {
  expectSidebarToolbar,
  expectFooterSeparator,
  footerScreenshot,
  expectFooterItemHidden,
  expectFooterOrder,
  expectFooterSettingsKeys,
  expectSidebarItemHidden,
  expectSidebarNavSettingsRow,
  expectSidebarOrder,
  leaveSettings,
  moveFooterItemUp,
  moveSidebarNavItemUp,
  openSidebarNavSettings,
  seedSidebarFooterPreferences,
  setFooterItemVisible,
  setSidebarNavItemVisible,
} from "../support/helpers/sidebar-nav-settings";

async function showDeveloperToast(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("error-toast")?.remove();
    const toast = document.createElement("div");
    toast.id = "error-toast";
    toast.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:white";
    const button = document.createElement("button");
    button.style.cssText = "width:24px;height:24px";
    button.addEventListener("click", () => toast.remove());
    toast.attachShadow({ mode: "open" }).appendChild(button);
    document.body.appendChild(toast);
  });
}

test("developer toasts leave concurrent sidebar layout checks uninterrupted", async ({ page }) => {
  await gotoAppShell(page);
  await showDeveloperToast(page);
  await expectSidebarToolbar(page);
  await expect(page.locator("#error-toast")).toBeHidden();
});

// The retained Usage visibility policy forces the footer Usage row hidden (docs/glossary.md,
// "Usage (sidebar item)"): a saved visible preference cannot show it, so the footer has no rows
// and no separator here.
test("responsive toolbar remains available while a saved preference cannot show the Usage row", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAppShell(page);
  await expectNoUsageItem(page);
  await expectSidebarToolbar(page);
  await expectFooterSeparator(page, false);
  await footerScreenshot(page, "toolbar-desktop-without-rows");
  await page.setViewportSize({ width: 390, height: 844 });
  await openCompactSidebar(page);
  await expectCompactSidebarOpen(page);
  await expectNoUsageItem(page);
  await expectFooterSeparator(page, false);
  await expectSidebarToolbar(page);
  await footerScreenshot(page, "toolbar-compact-without-rows");
});

test.describe("Sidebar contribution visibility and order", () => {
  const deploysKey = `plugin:${SHOWCASE_PLUGIN_ID}:deploys` as const;
  const legacyKey = `plugin:${LEGACY_PLUGIN_ID}:entry` as const;
  let cleanup: () => Promise<void>;

  test.beforeEach(async () => {
    ({ cleanup } = await installSidebarPlugins());
  });
  test.afterEach(async () => {
    await cleanup();
  });

  test("reorders and hides header contributions without removing toolbar actions", async ({
    page,
  }) => {
    await gotoAppShell(page);
    // Unplaced plugin rows follow the registry's serverId/pluginId sort, so legacy-sidebar leads.
    await expectSidebarOrder(page, [legacyKey, deploysKey]);
    await openSidebarNavSettings(page);
    await expectSidebarNavSettingsRow(page, { key: deploysKey, label: "Deploys", visible: true });
    await expectSidebarNavSettingsRow(page, {
      key: legacyKey,
      label: "Legacy entry",
      visible: true,
    });
    // Move until Deploys precedes this contribution, independent of unrelated registered rows.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const before = await page.getByTestId(`sidebar-nav-item-${deploysKey}`).boundingBox();
      const target = await page.getByTestId(`sidebar-nav-item-${legacyKey}`).boundingBox();
      if (before && target && before.y < target.y) break;
      await moveSidebarNavItemUp(page, deploysKey);
    }
    await leaveSettings(page);
    await expectSidebarOrder(page, [deploysKey, legacyKey]);
    await openSidebarNavSettings(page);
    await setSidebarNavItemVisible(page, deploysKey, false);
    await leaveSettings(page);
    await expectSidebarItemHidden(page, deploysKey);
    await expectSidebarToolbar(page);
    await page.reload();
    await expectSidebarItemHidden(page, deploysKey);
    await expectSidebarOrder(page, [legacyKey]);
    await openSidebarNavSettings(page);
    await expectSidebarNavSettingsRow(page, { key: deploysKey, label: "Deploys", visible: false });
  });

  test("hiding header contributions leaves the sidebar toolbar available", async ({ page }) => {
    await gotoAppShell(page);
    await openSidebarNavSettings(page);
    const switches = page
      .getByTestId("sidebar-nav-section-header")
      .getByTestId(/^sidebar-nav-toggle-plugin:/);
    for (const toggle of await switches.all()) {
      if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    }
    await leaveSettings(page);
    await expectSidebarItemHidden(page, deploysKey);
    await expectSidebarItemHidden(page, legacyKey);
    await expectSidebarToolbar(page);
    await page.reload();
    await expectSidebarToolbar(page);
    await expectSidebarItemHidden(page, deploysKey);
  });

  test("reorders and hides footer rows while keeping responsive toolbar access", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const syncKey = `plugin:${SHOWCASE_PLUGIN_ID}:sync`;
    const brokenKey = `plugin:${SHOWCASE_PLUGIN_ID}:broken`;
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    await seedSidebarFooterPreferences(page, [
      { key: "usage", visible: true },
      { key: "help", visible: false },
      { key: "hosts", visible: false },
      { key: "import", visible: false },
    ]);
    await gotoAppShell(page);
    await openSidebarNavSettings(page);
    // Settings lists only plugin footer rows; the built-in Usage meter is fixed and not listed.
    await expectFooterSettingsKeys(page, [syncKey, brokenKey]);
    await leaveSettings(page);
    // A saved visible preference cannot show the Usage row; plugin rows still render.
    await expectFooterItemHidden(page, "usage");
    await expectFooterOrder(page, [syncKey]);
    await expectSidebarToolbar(page);
    // No separator assertion here: since 469492c4e the footer's top rule shows only where the
    // project list reaches the footer, which this short list does not.
    await openSidebarNavSettings(page);
    await moveFooterItemUp(page, brokenKey);
    await expectFooterSettingsKeys(page, [brokenKey, syncKey]);
    await leaveSettings(page);
    await page.reload();
    await expectFooterOrder(page, [syncKey]);
    await expectFooterItemHidden(page, "usage");
    await expectSidebarToolbar(page);
    await openSidebarNavSettings(page);
    await expectFooterSettingsKeys(page, [brokenKey, syncKey]);
    await setFooterItemVisible(page, syncKey, false);
    await leaveSettings(page);
    await expectFooterItemHidden(page, syncKey);
    await expectFooterItemHidden(page, "usage");
    await expectFooterSeparator(page, false);
    await expectSidebarToolbar(page);
  });
});
