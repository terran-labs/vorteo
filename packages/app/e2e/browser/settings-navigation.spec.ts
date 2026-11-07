import {
  selectSettingsHost,
  expectSettingsHostPickerLabel,
  revealSettingsLocation,
} from "../support/helpers/settings";
import { test, expect } from "../support/fixtures";
import {
  buildHostWorkspaceRoute,
  buildOpenProjectRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  closeCompactSettings,
  scrollSettingsSidebarToEnd,
  revealSettingsSidebarSection,
  expectSettingsSidebarScrollSettled,
  scrollSettingsSidebarUp,
  changeSettingsInterfaceFontSize,
  selectSettingsHostSectionsRapidly,
  expectSettingsSidebarScrollOffset,
  scrollSettingsDetailDown,
  expectSettingsDetailScrollOffset,
  openSettingsSection,
  expectSettingsHeader,
  openAddHostFlow,
  selectHostConnectionType,
  toggleHostAdvanced,
  openCompactSettings,
  expectCompactSettingsList,
  expectSettingsSidebarVisible,
  expectSettingsSidebarHidden,
  expectSettingsSidebarSections,
  goBackInSettings,
  expectSettingsBackButton,
  clickSettingsBackToWorkspace,
  verifyLegacyHostSettingsRedirect,
  openCompactSettingsHost,
  expectAddHostMethodOptions,
  fillDirectHostUri,
  expectDirectHostFormValues,
  expectDirectHostSslEnabled,
  expectDirectHostSslDisabled,
  fillDirectHostAddress,
  toggleDirectHostSsl,
  expectDirectHostUriValue,
  expectDirectHostUriHidden,
  expectDiagnosticsContent,
  expectAboutContent,
  expectGeneralContent,
  expectAppearanceContent,
  seedSavedSettingsHosts,
  openSettingsHostSection,
  removeCurrentHostFromSettings,
} from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

for (const width of [1280, 390]) {
  test(`Help stays reachable in Settings at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoAppShell(page);
    await openSettings(page);
    await revealSettingsLocation(page, "general.about");
    const help = page.getByTestId("settings-help");
    await expect(help).toBeVisible();
    await expect(help.getByTestId("settings-help-discord")).toHaveAccessibleName(/Discord/);
    await expect(help.getByTestId("settings-help-github")).toHaveAccessibleName(
      /Create GitHub issue/,
    );
    await help.getByTestId("settings-help-diagnostics").click();
    await expect(page.getByTestId("app-diagnostic-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("app-diagnostic-sheet")).not.toBeVisible();
    await expect(help).toBeVisible();
  });
}

async function openWorkspace(
  page: import("@playwright/test").Page,
  workspace: { workspaceId: string },
) {
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
  await expect(page.getByTestId("menu-button")).toBeVisible();
}

test.describe("Settings sidebar scroll position", () => {
  test.use({ viewport: { width: 1000, height: 400 } });

  test("clamps after resizing and starts a fresh visit at the top", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await scrollSettingsSidebarToEnd(page);
    await page.setViewportSize({ width: 1000, height: 1100 });
    await expectSettingsSidebarScrollOffset(page, 0);
    await page.setViewportSize({ width: 1000, height: 400 });
    await openSettingsSection(page, "appearance");
    await expectSettingsSidebarScrollOffset(page, 0);
    await scrollSettingsSidebarToEnd(page);
    await clickSettingsBackToWorkspace(page);
    await openSettings(page);
    await expectSettingsSidebarScrollOffset(page, 0);
  });

  test("keeps the sidebar position through interface font changes", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsSection(page, "appearance");
    const offset = await scrollSettingsSidebarToEnd(page);
    await changeSettingsInterfaceFontSize(page, 20);
    await expectSettingsSidebarScrollOffset(page, offset);
    await openSettingsHostSection(page, getServerId(), "providers");
    await expectSettingsSidebarScrollOffset(page, offset);
  });

  test("scrolls the sidebar and detail pane independently", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    const sidebarOffset = await scrollSettingsSidebarToEnd(page);
    await openSettingsHostSection(page, getServerId(), "providers");
    await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
    const detailOffset = await scrollSettingsDetailDown(page);
    await expectSettingsSidebarScrollOffset(page, sidebarOffset);

    await scrollSettingsSidebarUp(page, 60);
    await expectSettingsSidebarScrollOffset(page, sidebarOffset - 60);
    await expectSettingsDetailScrollOffset(page, detailOffset);
  });

  test("keeps the sidebar position after rapid consecutive selections", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    const scrollTop = await scrollSettingsSidebarToEnd(page);

    await selectSettingsHostSectionsRapidly(page);
    await expectSettingsSidebarScrollOffset(page, scrollTop);

    await expectSettingsSidebarScrollSettled(page, scrollTop);
  });

  test("keeps the sidebar position when switching between app and host sections", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);

    const hostScrollTop = await scrollSettingsSidebarToEnd(page);
    await expect(page.getByTestId("settings-section-system")).toBeInViewport();

    for (const section of [
      "providers",
      "terminals",
      "providers",
      "terminals",
      "providers",
    ] as const) {
      await openSettingsHostSection(page, getServerId(), section);
      await expect(
        page.getByTestId(
          section === "providers"
            ? "settings-pane-accounts.providers"
            : "settings-pane-terminal.profiles",
        ),
      ).toBeVisible();
      await expectSettingsSidebarScrollOffset(page, hostScrollTop);
    }

    const sidebar = page.getByTestId("settings-sidebar");
    const appScrollTop = await revealSettingsSidebarSection(page, "diagnostics");
    await expect(sidebar.getByRole("button", { name: "System", exact: true })).toBeInViewport();

    await openSettingsSection(page, "about");
    await expectAboutContent(page);
    await expectSettingsSidebarScrollOffset(page, appScrollTop);

    await openSettingsSection(page, "diagnostics");
    await expectDiagnosticsContent(page);
    await expectSettingsSidebarScrollOffset(page, appScrollTop);
  });
});

test.describe("Settings sidebar navigation", () => {
  test("opening Settings closes the composer model selector until it is opened again", async ({
    page,
    withWorkspace,
  }, testInfo) => {
    const workspace = await withWorkspace({ prefix: "settings-model-selector-" });
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);

    const selector = page.getByTestId("combined-model-selector").filter({ visible: true });
    const popover = page.getByTestId("combobox-desktop-container");
    await selector.click();
    await expect(popover).toBeVisible();

    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+,`);
    await expect(page).toHaveURL(/\/settings\/general$/);
    await page.screenshot({ path: testInfo.outputPath("settings-after-model-selector.png") });
    await expect(popover).toHaveCount(0);

    await clickSettingsBackToWorkspace(page);
    await expect(selector).toBeVisible();
    await expect(popover).toHaveCount(0);

    await selector.click();
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
  });

  test("opening Settings closes an existing chat's model selector until it is opened again", async ({
    page,
  }, testInfo) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "settings-existing-model-",
      title: "Settings model selector",
    });
    try {
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      const selector = page.getByTestId("combined-model-selector").filter({ visible: true });
      const popover = page.getByTestId("combobox-desktop-container");
      await selector.click();
      await expect(popover).toBeVisible();

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+,`);
      await expect(page).toHaveURL(/\/settings\/general$/);
      await page.screenshot({
        path: testInfo.outputPath("settings-after-existing-model-selector.png"),
      });
      await expect(popover).toHaveCount(0);

      await clickSettingsBackToWorkspace(page);
      await expect(selector).toBeVisible();
      await expect(popover).toHaveCount(0);

      await selector.click();
      await expect(popover).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("clicking a sidebar section updates the URL and renders the section", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    const sidebar = page.getByTestId("settings-sidebar");
    const sections = sidebar.locator('[data-testid^="settings-section-"]');
    const ids = await sections.evaluateAll((nodes) => {
      const sectionIds: Array<string | null> = [];
      for (const node of nodes) sectionIds.push(node.getAttribute("data-testid"));
      return sectionIds;
    });
    expect(ids).toEqual([
      "settings-section-interface",
      "settings-section-privacy",
      "settings-section-general",
      "settings-section-providers",
      "settings-section-agents",
      "settings-section-voice",
      "settings-section-environments",
      "settings-section-projects",
      "settings-section-system",
    ]);
    await expect(sidebar.getByTestId("settings-section-pair-device")).toHaveCount(0);
    const generalBox = await sidebar.getByTestId("settings-section-general").boundingBox();
    const accountsBox = await sidebar.getByTestId("settings-section-providers").boundingBox();
    expect(accountsBox!.y - generalBox!.y - generalBox!.height).toBeLessThanOrEqual(8);
    await openSettingsSection(page, "editor");
    await expect(page.getByText(/Press i to enter Insert mode/)).toBeVisible();

    await openSettingsSection(page, "diagnostics");
    await expectSettingsHeader(page, "Connected hosts");
    await expectDiagnosticsContent(page);

    await openSettingsSection(page, "general");
    await expectSettingsHeader(page, "General");
    await expectGeneralContent(page);
    await openSettingsSection(page, "about");
    await expectAboutContent(page);

    await openSettingsSection(page, "appearance");
    await expectSettingsHeader(page, "Appearance");
    await expectAppearanceContent(page);

    const back = page.getByTestId("settings-back-to-workspace");
    await page.mouse.move(0, 0);
    await expect(back).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(back).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await back.hover();
    await expect(back).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.screenshot({
      path: test.info().outputPath("settings-back-hover.png"),
    });
    await clickSettingsBackToWorkspace(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("host choice survives app sections and host screen replacements", async ({ page }) => {
    const primaryServerId = getServerId();
    const secondaryServerId = "srv_e2e_settings_secondary";
    const endpoint = `127.0.0.1:${getE2EDaemonPort()}`;
    await seedSavedSettingsHosts(page, [
      { serverId: primaryServerId, label: "First horse", endpoint },
      { serverId: secondaryServerId, label: "Stable horse", endpoint },
    ]);
    await gotoAppShell(page);
    await openSettings(page);
    await selectSettingsHost(page, secondaryServerId);
    await openSettingsHostSection(page, secondaryServerId, "connections");
    await openSettingsSection(page, "appearance");
    await expectSettingsHostPickerLabel(page, "Stable horse");
    await openSettingsSection(page, "general");
    await expectSettingsHostPickerLabel(page, "Stable horse");
    await openSettingsHostSection(page, secondaryServerId, "connections");
    await selectSettingsHost(page, primaryServerId);
    await openSettingsSection(page, "about");
    await expectSettingsHostPickerLabel(page, "First horse");
  });

  test("/h/[serverId]/settings redirects to the host connections section", async ({ page }) => {
    await gotoAppShell(page);
    await verifyLegacyHostSettingsRedirect(page);
  });

  test("direct connection advanced URI round-trips SSL and password into the form", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openAddHostFlow(page);
    await expectAddHostMethodOptions(page);
    await selectHostConnectionType(page, "direct");

    await fillDirectHostAddress(page, "example.paseo.test", "7443");
    await expectDirectHostSslDisabled(page);
    await toggleDirectHostSsl(page);
    await expectDirectHostSslEnabled(page);
    await toggleHostAdvanced(page);
    await expectDirectHostUriValue(page, "tcp://example.paseo.test:7443?ssl=true");
    await toggleHostAdvanced(page);
    await toggleDirectHostSsl(page);
    await expectDirectHostSslDisabled(page);

    await toggleHostAdvanced(page);
    await fillDirectHostUri(page, "tcp://example.paseo.test:7443?ssl=true&password=shared-secret");
    await toggleHostAdvanced(page);

    await expectDirectHostFormValues(page, {
      host: "example.paseo.test",
      port: "7443",
      password: "shared-secret",
    });
    await expectDirectHostSslEnabled(page);
    await expectDirectHostUriHidden(page);

    await toggleHostAdvanced(page);
    await expectDirectHostUriValue(
      page,
      "tcp://example.paseo.test:7443?ssl=true&password=shared-secret",
    );
    await toggleHostAdvanced(page);
    await expectDirectHostUriHidden(page);
  });

  test("Escape lets settings dropdowns and modals close before leaving settings", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await test.step("a dropdown owns Escape", async () => {
      await openSettingsSection(page, "appearance");
      await page.getByLabel(/Highlight theme:/).click();
      await expect(page.getByRole("menuitem", { name: "GitHub", exact: true })).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(page.getByRole("menuitem", { name: "GitHub", exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings(\/|$)/);
    });

    await test.step("a modal owns Escape", async () => {
      await openAddHostFlow(page);
      await expect(page.getByRole("dialog").filter({ hasText: "Add connection" })).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(page.getByRole("dialog").filter({ hasText: "Add connection" })).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings(\/|$)/);
    });

    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });
});

test.describe("Settings — compact master-detail", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the compact tab switcher reopens after Settings hides its workspace", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "settings-tab-switcher-",
      title: "Compact tab switcher",
    });
    try {
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      const switcher = page.getByTestId("workspace-tab-switcher-trigger").filter({ visible: true });
      const newAgent = page.getByTestId("workspace-tab-switcher-new-agent");
      await switcher.click();
      await expect(newAgent).toBeInViewport();

      // Navigate without dismissing the sheet through its backdrop first.
      await page
        .getByTestId("menu-button")
        .filter({ visible: true })
        .first()
        .dispatchEvent("click");
      await page.getByTestId("sidebar-settings").first().dispatchEvent("click");
      await expectAppRoute(page, buildSettingsRoute());
      await expect(newAgent).toHaveCount(0);

      await closeCompactSettings(page);
      await expect(switcher).toBeVisible();
      await expect(newAgent).toHaveCount(0);
      await switcher.click();
      await expect(newAgent).toBeInViewport();
    } finally {
      await workspace.cleanup();
    }
  });

  test("opens compact app and host details and returns through the settings list", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await expectSettingsSidebarSections(page, ["general", "diagnostics"]);
    await expectCompactSettingsList(page);

    await test.step("open app details and return to the list", async () => {
      // Diagnostics lives in System's Connected hosts pane.
      await openSettingsSection(page, "diagnostics");
      await expectAppRoute(page, buildSettingsSectionRoute("system"));
      await expectDiagnosticsContent(page);
      await expectSettingsSidebarHidden(page);
      await expectSettingsBackButton(page);
      await goBackInSettings(page);
      await expectCompactSettingsList(page);
    });

    await test.step("open host details and return through the list", async () => {
      await openCompactSettingsHost(page);
      await expectSettingsBackButton(page);
      await expectSettingsSidebarHidden(page);
      await goBackInSettings(page);
      await expectAppRoute(page, buildSettingsRoute());
      await expectSettingsSidebarVisible(page);
      await expectSettingsBackButton(page);
      await goBackInSettings(page);
      await expect(page).not.toHaveURL(/\/settings(\/|$)/);
    });
  });

  test("environment settings returns through the settings list to the original workspace", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({
      prefix: "host-picker-settings-back-",
    });
    const workspaceRoute = buildHostWorkspaceRoute(getServerId(), workspace.workspaceId);

    await openWorkspace(page, workspace);
    await openCompactSettings(page, workspaceRoute);
    await openSettingsHostSection(page, getServerId(), "host");
    await expectAppRoute(page, buildSettingsSectionRoute("environments"));
    await expect(
      page
        .getByTestId("settings-environment-scroll")
        .getByTestId(`settings-environment-${getServerId()}`),
    ).toBeVisible();

    await goBackInSettings(page);
    await expectCompactSettingsList(page);

    await goBackInSettings(page);
    await expectAppRoute(page, workspaceRoute);
  });

  test("one Connections section displays both environments without a host picker", async ({
    page,
  }) => {
    const primaryServerId = getServerId();
    const secondaryServerId = "srv_e2e_settings_secondary";
    const secondaryHostLabel = "Stable horse";
    const endpoint = `127.0.0.1:${getE2EDaemonPort()}`;

    await seedSavedSettingsHosts(page, [
      { serverId: primaryServerId, label: "First horse", endpoint },
      { serverId: secondaryServerId, label: secondaryHostLabel, endpoint },
    ]);
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await expect(page.getByTestId("settings-host-picker")).toHaveCount(0);

    await expectAppRoute(page, buildSettingsRoute());
    await expectSettingsSidebarVisible(page);

    await openSettingsHostSection(page, secondaryServerId, "connections");
    const connections = page.getByTestId("settings-pane-environments.connections");
    await expect(connections.getByTestId(`settings-environment-${primaryServerId}`)).toContainText(
      "First horse",
    );
    await expect(
      connections.getByTestId(`settings-environment-${secondaryServerId}`),
    ).toContainText(secondaryHostLabel);
  });

  test("removing the last active host returns to welcome after settings closes", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "remove-host-compact-" });

    await openWorkspace(page, workspace);
    await openCompactSettings(page, buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
    await openSettingsHostSection(page, getServerId(), "host");
    await removeCurrentHostFromSettings(page);
    await closeCompactSettings(page);

    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByTestId("welcome-direct-connection")).toBeVisible();
  });
});

async function measureDockedNavigation(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: 951 });
  const history = page.getByRole("button", { name: /^History/ }).filter({ visible: true });
  const settings = page
    .getByRole("button", { name: "Settings", exact: true })
    .filter({ visible: true });
  await expect(history).toBeVisible();
  await expect(settings).toBeVisible();
  return {
    width,
    history: await history.evaluate((el) => el.getBoundingClientRect().height),
    settings: await settings.evaluate((el) => el.getBoundingClientRect().height),
  };
}

async function measureSettingsSplit(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: 951 });
  const sidebar = page.getByTestId("settings-sidebar");
  const detail = page.getByTestId("settings-detail-pane");
  await expect(sidebar).toBeVisible();
  await expect(detail).toBeVisible();
  return {
    width,
    sidebar: await sidebar.evaluate((el) => el.getBoundingClientRect().width),
    detail: await detail.evaluate((el) => el.getBoundingClientRect().width),
  };
}

async function expectConsistentDockedNavigation(page: import("@playwright/test").Page) {
  const wide = await measureDockedNavigation(page, 951);
  for (const width of [600, 669, 719, 720]) {
    const narrow = await measureDockedNavigation(page, width);
    expect
      .soft(narrow.history, `History keeps its wide-layout density at ${width}`)
      .toBeCloseTo(wide.history, 0);
    expect
      .soft(narrow.settings, `Settings keeps its wide-layout density at ${width}`)
      .toBeCloseTo(wide.settings, 0);
  }
}

async function expectSettingsDetailKeepsReadingWidth(page: import("@playwright/test").Page) {
  const reference = await measureSettingsSplit(page, 720);
  for (const width of [600, 669, 719]) {
    const narrow = await measureSettingsSplit(page, width);
    expect
      .soft(narrow.detail, `Settings preserves its detail budget at ${width}`)
      .toBeGreaterThanOrEqual(reference.detail);
    expect
      .soft(narrow.sidebar, `Settings navigation yields width at ${width}`)
      .toBeLessThan(reference.sidebar);
  }
  const wide = await measureSettingsSplit(page, 951);
  expect(wide.sidebar).toBeCloseTo(reference.sidebar, 0);
  expect(wide.detail).toBeGreaterThan(reference.detail);
}

test("docked navigation keeps its density and Settings preserves reading width", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "narrow-wide-layout-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await expectConsistentDockedNavigation(page);
  await openSettings(page);
  await openSettingsSection(page, "appearance");
  await expectAppearanceContent(page);
  await expectSettingsDetailKeepsReadingWidth(page);
  await page.setViewportSize({ width: 599, height: 951 });
  await expectSettingsSidebarHidden(page);
  await expectAppearanceContent(page);
});

test("environment tabs stay visible while details scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  const primary = getServerId();
  const secondary = "srv_e2e_environment_tabs";
  const endpoint = `127.0.0.1:${getE2EDaemonPort()}`;
  await seedSavedSettingsHosts(page, [
    { serverId: primary, label: "Host", endpoint },
    { serverId: secondary, label: "Dev container", endpoint },
  ]);
  await page.goto(buildSettingsSectionRoute("environments"));
  // Environment cards also appear in other sections' panes; scope to this one.
  const pane = page.getByTestId("settings-environment-scroll");
  const tabs = page.getByTestId("settings-environment-tabs");
  // The deep link pins Environments for 3s (PIN_MS in settings-scroll-page.tsx), but panes
  // above it can finish loading later and push it about 2,800px down: CI showed Terminal. Bring
  // the tabs back into view when that happens and wait until they rest before measuring. A cold
  // local run kept moving for more than the default 10s, hence 30s.
  let previousTabTop: number | undefined;
  await expect
    .poll(
      async () => {
        const top = (await tabs.boundingBox())?.y;
        if (top === undefined || top < 0 || top >= 500) {
          await tabs.evaluate((node) => node.scrollIntoView({ block: "start" }));
          previousTabTop = undefined;
          return false;
        }
        const settled = top === previousTabTop;
        previousTabTop = top;
        return settled;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const hostTab = page.getByRole("tab", { name: "Host", exact: true });
  const devTab = page.getByRole("tab", {
    name: "Dev container",
    exact: true,
  });
  await expect(hostTab).toHaveAttribute("aria-selected", "true");
  await expect(pane.getByTestId(`settings-environment-${primary}`)).toBeVisible();
  await expect(pane.getByTestId(`settings-environment-${secondary}`)).toHaveCount(0);
  // The settings page scrolls; the tabs stick while this environment's details pass under them.
  const scroll = page.getByTestId("settings-scroll-page");
  await scroll.hover();
  // Scroll past the section heading so the tabs have reached their sticky
  // position at every width before measuring it.
  await page.mouse.wheel(0, 400);
  // Wheel scrolling can animate; measure once the position has settled.
  let previousTop = -1;
  await expect
    .poll(async () => {
      const top = await scroll.evaluate((element) => element.scrollTop);
      const settled = top > 0 && top === previousTop;
      previousTop = top;
      return settled;
    })
    .toBe(true);
  const stuck = await tabs.boundingBox();
  await page.mouse.wheel(0, 120);
  await expect(tabs).toBeVisible();
  await expect.poll(async () => (await tabs.boundingBox())!.y).toBe(stuck!.y);
  await devTab.click();
  await expect(devTab).toHaveAttribute("aria-selected", "true");
  await expect(pane.getByTestId(`settings-environment-${secondary}`)).toBeAttached();
  await expect(pane.getByTestId(`settings-environment-${primary}`)).toHaveCount(0);
  await hostTab.click();
  await expect(hostTab).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: test.info().outputPath("environment-tabs.png"),
  });
});

for (const width of [1280, 390]) {
  test(`Settings search stays in the top bar and closes Command Center at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await gotoAppShell(page);
    if (width === 390)
      await page.getByTestId("menu-button").filter({ visible: true }).first().click();
    await page.getByTestId("sidebar-search").filter({ visible: true }).first().click();
    await expect(page.getByTestId("command-center-panel")).toBeVisible();
    // Exercise navigation while the overlay still owns input, as a sidebar action can do.
    if (width === 390)
      await page
        .getByTestId("menu-button")
        .filter({ visible: true })
        .first()
        .dispatchEvent("click");
    await page.getByTestId("sidebar-settings").first().dispatchEvent("click");
    await expect(page.getByTestId("command-center-panel")).not.toBeVisible();
    const input = page.getByTestId("settings-search-input").filter({ visible: true });
    await expect(input).toHaveCount(1);
    const top = await input.boundingBox();
    expect(top!.y).toBeLessThan(80);
    if (width === 390) {
      const sidebar = page.getByTestId("settings-sidebar");
      await expect(sidebar).toBeVisible();
      await expect(sidebar).toHaveCSS("border-top-width", "0px");
      await expect(sidebar).toHaveCSS("box-shadow", "none");
      await page.getByTestId("settings-section-interface").click();
      await expect(input).toBeVisible();
      await page.getByTestId("settings-scroll-page").hover();
      await page.mouse.wheel(0, 700);
      await expect.poll(async () => (await input.boundingBox())!.y).toBe(top!.y);
    } else {
      const back = await page.getByTestId("settings-back-to-workspace").boundingBox();
      expect(Math.abs(back!.y + back!.height / 2 - top!.y - top!.height / 2)).toBeLessThan(8);
    }
    await page.screenshot({ path: test.info().outputPath(`settings-header-${width}.png`) });
    await page.keyboard.press("/");
    await expect(input).toBeFocused();
    await input.fill("data saver");
    await expect(page.getByTestId("settings-search-results")).toBeVisible();
    await expect(input).toBeFocused();
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("settings-data-saver")).toBeVisible();
  });
}
