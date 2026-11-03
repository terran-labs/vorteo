import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { openSidebarHelpMenu } from "../support/helpers/sidebar";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { gotoWorkspace, waitForTabBar } from "../support/helpers/launcher";
import {
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHostSection } from "../support/helpers/settings";
import { seedSidebarFooterPreferences } from "../support/helpers/sidebar-nav-settings";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import { openUsage } from "../support/helpers/usage-login";
import {
  claudeAndCodexReports,
  closeUsage,
  closeUsageOptions,
  expectNoUsageItem,
  expectUnpinnableRows,
  scrollUsageToWindow,
  openUsageOptions,
  showUsageAs,
  usageModal,
  installTallUsageSource,
} from "../support/helpers/usage-sidebar-item";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { createTempGitRepo } from "../support/helpers/workspace";

const WIDE = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

type ScreenshotArea = { kind: "page" } | { kind: "footer" } | { kind: "element"; locator: Locator };

/** Set PASEO_QA_SCREENSHOT_DIR to keep QA screenshots of each state. */
async function qaScreenshot(page: Page, name: string, area: ScreenshotArea = { kind: "page" }) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  // Let sheet and drawer animations settle so the image shows the final state.
  await page.waitForTimeout(600);
  // Expo's fast-refresh indicator sits over the footer's Hosts icon.
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  const file = path.join(directory, `${name}.png`);
  if (area.kind === "element") {
    await area.locator.screenshot({ path: file });
    return;
  }
  const clip = area.kind === "footer" ? await footerClip(page) : undefined;
  await page.screenshot({ path: file, clip });
}

/** Includes summary rows above the fixed icon row. */
async function footerClip(page: Page) {
  return (await page.locator('[data-testid="sidebar-footer"]:visible').boundingBox())!;
}

async function expectSettledHome(page: Page) {
  await expect(page).toHaveURL(/\/open-project$/);
  await expect(page.getByTestId("open-project-submit").filter({ visible: true })).toBeVisible();
}

async function expectConnectedFixtureHome(page: Page) {
  await expectSettledHome(page);
  // Read the running fixture's handshake, not a source manifest or cached browser version.
  const client = await connectDaemonClient<
    Pick<DaemonClient, "connect" | "close" | "getLastServerInfoMessage">
  >({ clientIdPrefix: "usage-home-readiness" });
  let expectedVersion: string;
  try {
    const info = client.getLastServerInfoMessage();
    expect(info?.serverId).toBe(getServerId());
    const version = info?.version?.trim();
    if (!version) throw new Error("The fixture host did not report its daemon version.");
    expectedVersion = version.startsWith("v") ? version : `v${version}`;
  } finally {
    await client.close();
  }
  // Settings mounts its Usage pane. Help reads connection state without opening reports.
  await openSidebarHelpMenu(page);
  const host = page.getByTestId(`sidebar-help-host-version-${getServerId()}`);
  await expect(host).toBeVisible();
  await expect(host.getByText(expectedVersion, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar-help-menu")).not.toBeVisible();
  await expectSettledHome(page);
}

async function expectSavedVisiblePreference(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}").sidebarFooterItems,
      ),
    )
    .toEqual([{ key: "usage", visible: true }]);
}

async function expectReportPercentages(scope: Locator, display: "used" | "remaining") {
  for (const [source, window, used] of [
    ["claude", "Session", 31],
    ["claude", "Weekly", 54],
    ["codex", "Session", 7],
    ["codex", "Weekly", 12],
  ] as const) {
    const card = scope.getByTestId(`usage-report-${source}:default`);
    const row = card.getByText(window, { exact: true }).locator("..");
    const value = display === "used" ? `${used}% used` : `${100 - used}% left`;
    await expect(row.getByText(value, { exact: true })).toBeVisible();
  }
}

async function expectNonpinnableReports(page: Page) {
  const screen = usageModal(page);
  await expect(screen.getByText("Claude", { exact: true })).toBeVisible();
  await expectUnpinnableRows(screen.getByTestId("usage-report-claude:default"));
  await expectUnpinnableRows(screen.getByTestId("usage-report-codex:default"));
  await expectNoUsageItem(page);
}

test.describe("Usage screen with the sidebar summary hidden", () => {
  test("compact direct Usage navigation and browser Back preserve the starting route", async ({
    page,
  }) => {
    await page.setViewportSize(COMPACT);
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    await seedSidebarFooterPreferences(page, [{ key: "usage", visible: false }]);
    await gotoAppShell(page);
    await expectSettledHome(page);
    const startUrl = page.url();
    await expectNoUsageItem(page);
    await openUsage(page);
    await expect(usageModal(page).getByText("Claude", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/usage$/);
    await qaScreenshot(page, "compact-direct-usage");
    await closeUsage(page);
    await expect(page).toHaveURL(startUrl);
    await openUsage(page);
    await expect(usageModal(page).getByText("Codex", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/usage$/);
    await closeUsage(page);
    await expect(page).toHaveURL(startUrl);
  });

  test("on desktop direct Usage opens its screen and Back returns to the workspace", async ({
    page,
  }) => {
    const repo = await createTempGitRepo("usage-modal-");
    const client = await connectNewWorkspaceDaemonClient();
    try {
      const project = await openProjectViaDaemon(client, repo.path);
      await page.setViewportSize(WIDE);
      await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
      await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
      await gotoWorkspace(page, project.workspaceId);
      const workspaceUrl = page.url();
      await openUsage(page);
      const screen = usageModal(page);
      await expect(screen.getByText("Claude", { exact: true })).toBeVisible();
      await expect(screen.getByRole("button", { name: "Refresh all", exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/usage$/);
      await qaScreenshot(page, "desktop-usage-screen");
      await closeUsage(page);
      await expect(page).toHaveURL(workspaceUrl);
      await waitForTabBar(page);
      await openUsage(page);
      await closeUsage(page);
      await expect(usageModal(page)).toHaveCount(0);
      await expect(page).toHaveURL(workspaceUrl);
    } finally {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  for (const [size, viewport] of Object.entries({ desktop: WIDE, compact: COMPACT })) {
    test(`long usage reports scroll between their first and last windows on ${size}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const source = await installTallUsageSource();
      try {
        await page.setViewportSize(viewport);
        await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
        await gotoAppShell(page);
        await expectNoUsageItem(page);
        await openUsage(page);
        const content = usageModal(page);
        await expect(content.getByText("Window 20", { exact: true })).toHaveCount(1);
        await waitForSettledPosition(content);
        await expect(content.getByText("Window 20", { exact: true })).not.toBeInViewport();
        await qaScreenshot(page, `${size}-usage-scroll-top`);
        await scrollUsageToWindow(page, "Window 20");
        await expect(content.getByText("Window 20", { exact: true })).toBeInViewport();
        await qaScreenshot(page, `${size}-usage-scroll-bottom`);
        await scrollUsageToWindow(page, "Window 1");
        await expect(content.getByText("Window 1", { exact: true })).toBeInViewport();
        await expect(content.getByText("Window 20", { exact: true })).not.toBeInViewport();
      } finally {
        await source.cleanup();
      }
    });
  }

  test("full-screen percentages follow Used/Remaining and persist without sidebar pins", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const serverId = getServerId();
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    await page.setViewportSize(WIDE);
    await gotoAppShell(page);
    await expectNoUsageItem(page);
    await openUsage(page);
    const screen = usageModal(page);
    await expectReportPercentages(screen, "used");
    await expectNonpinnableReports(page);
    await expect(page.locator('[data-testid="usage-host-filter-trigger"]:visible')).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "Refresh all", exact: true })).toBeVisible();
    await qaScreenshot(page, "usage-card-refresh", {
      kind: "element",
      locator: screen.getByTestId("usage-report-claude:default"),
    });
    await showUsageAs(page, "remaining");
    await expectReportPercentages(screen, "remaining");
    await closeUsage(page);
    await page.setViewportSize(COMPACT);
    await openUsage(page);
    await expect(screen.getByText("Codex", { exact: true })).toBeInViewport();
    await expectReportPercentages(screen, "remaining");
    await expectNonpinnableReports(page);
    await expect(page.locator('[data-testid="usage-options-toggle"]:visible')).toBeVisible();
    await expect(page.locator('[data-testid="usage-refresh-all"]:visible')).toBeVisible();
    await openUsageOptions(page);
    await expect(page.getByTestId("usage-display-remaining")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await qaScreenshot(page, "compact-settings-expanded");
    await closeUsageOptions(page);
    await expect(screen.getByTestId("usage-display-used")).toHaveCount(0);
    await expect(screen).toBeVisible();
    await waitForSettledPosition(screen);
    const screenBox = (await screen.boundingBox())!;
    expect(screenBox.y).toBeGreaterThanOrEqual(0);
    expect(screenBox.y).toBeLessThan(COMPACT.height);
    expect(screenBox.width).toBeGreaterThan(COMPACT.width * 0.8);
    await qaScreenshot(page, "compact-usage-screen");
    await closeUsage(page);
    await page.setViewportSize(WIDE);
    await page.reload();
    await openUsage(page);
    await expectReportPercentages(screen, "remaining");
    await openUsageOptions(page);
    await expect(page.getByTestId("usage-display-remaining")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await closeUsageOptions(page);
    const usageUrl = page.url();
    await closeUsage(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");
    await expectReportPercentages(page.getByTestId("usage-card"), "remaining");
    await page.goto(usageUrl);
    await expectReportPercentages(screen, "remaining");
    await expectNonpinnableReports(page);
    await closeUsage(page);
  });
});

test("an unavailable report remains reachable directly without a sidebar summary", async ({
  page,
}) => {
  await installUsageReportsFixture(page, {
    lists: [
      [
        {
          id: "alpha:a",
          account: {},
          fetchedAt: new Date().toISOString(),
          sourceId: "alpha",
          sourceLabel: "Alpha plan",
          report: {
            status: "unavailable",
            problem: { kind: "no_quota", detail: "No active coding plan" },
          },
        },
      ],
    ],
  });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expectNoUsageItem(page);
  await openUsage(page);
  const card = usageModal(page).getByTestId("usage-report-alpha:a");
  await expect(card.getByText("Alpha plan", { exact: true })).toBeVisible();
  await expect(card.getByText("No active coding plan", { exact: true })).toBeVisible();
  await expectUnpinnableRows(card);
  await expectNoUsageItem(page);
  await qaScreenshot(page, "usage-unavailable-report");
});

test("a saved visible preference stays stored while usage remains hidden and nonpinnable after reload", async ({
  page,
}) => {
  await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expectSettledHome(page);
  await expectSavedVisiblePreference(page);
  await expectNoUsageItem(page);
  await openUsage(page);
  await expectNonpinnableReports(page);
  await openUsageOptions(page);
  await expect(page.getByRole("switch", { name: "Summary in sidebar", exact: true })).toHaveCount(
    0,
  );
  await closeUsageOptions(page);
  await closeUsage(page);
  await expectSavedVisiblePreference(page);
  await expectNoUsageItem(page);
  await page.reload();
  await expectSettledHome(page);
  await expectSavedVisiblePreference(page);
  await expectNoUsageItem(page);
  await openUsage(page);
  await expectNonpinnableReports(page);
  await expectReportPercentages(usageModal(page), "used");
  await openUsageOptions(page);
  await expect(page.getByRole("switch", { name: "Summary in sidebar", exact: true })).toHaveCount(
    0,
  );
  await closeUsageOptions(page);
});

test("released hosts supply source logos through the client conversion", async ({ page }) => {
  await installUsageReportsFixture(page, {
    lists: [() => claudeAndCodexReports()],
    providerUsageListOnly: true,
  });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expectNoUsageItem(page);
  await openUsage(page);
  const claudePath = /<path[^>]* d="([^"]+)"/.exec(claudeAndCodexReports()[0]!.icon!)![1]!;
  const codexPath = /<path[^>]* d="([^"]+)"/.exec(claudeAndCodexReports()[1]!.icon!)![1]!;
  const screen = page.getByTestId(`usage-host-${getServerId()}`);
  await expect(
    screen.getByTestId("usage-report-claude").locator("svg path").first(),
  ).toHaveAttribute("d", claudePath);
  await expect(
    screen.getByTestId("usage-report-codex").locator("svg path").first(),
  ).toHaveAttribute("d", codexPath);
  await expect(screen.getByText("Claude", { exact: true })).toBeVisible();
  await expect(screen.getByText("Codex", { exact: true })).toBeVisible();
  await qaScreenshot(page, "released-host-usage-screen");
});

test("hidden usage sends no requests until opened directly", async ({ page }) => {
  test.setTimeout(180_000);
  const usage = await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expectConnectedFixtureHome(page);
  await expectNoUsageItem(page);
  expect(usage.listRequests()).toHaveLength(0);
  await openUsage(page);
  await usage.waitForListRequests(1);
  expect(usage.listRequests()).toHaveLength(1);
});

test("a saved visible sidebar preference cannot load usage before direct entry", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const usage = await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expectConnectedFixtureHome(page);
  await expectSavedVisiblePreference(page);
  await expectNoUsageItem(page);
  expect(usage.listRequests()).toHaveLength(0);
  await page.reload();
  await expectConnectedFixtureHome(page);
  await expectSavedVisiblePreference(page);
  await expectNoUsageItem(page);
  expect(usage.listRequests()).toHaveLength(0);
  await openUsage(page);
  await usage.waitForListRequests(1);
  expect(usage.listRequests()).toHaveLength(1);
  await expectReportPercentages(usageModal(page), "used");
});
