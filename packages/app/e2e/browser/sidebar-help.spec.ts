import { readFileSync } from "node:fs";
import path from "node:path";
import { parseChangelog } from "../../src/changelog/internal/parse-changelog";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openSettingsSection, revealSettingsLocation } from "../support/helpers/settings";
import { release, serveChangelog } from "../support/helpers/changelog";

const customReleases = parseChangelog(
  readFileSync(path.resolve(__dirname, "../../../../VORTEO_CHANGELOG.md"), "utf8"),
);
const latestCustomRelease = customReleases[0]!;

const DISCORD_DESTINATION =
  /^https:\/\/(?:discord\.gg\/jz8T2uahpH|discord\.com\/invite\/jz8T2uahpH)(?:[/?#]|$)/;
const GITHUB_ISSUE_DESTINATION =
  /^https:\/\/github\.com\/(?:getpaseo\/paseo\/issues\/new(?:\/choose)?(?:[/?#]|$)|login\?return_to=https%3A%2F%2Fgithub\.com%2Fgetpaseo%2Fpaseo%2Fissues%2Fnew$)/;
const CHANGELOG_DESTINATION =
  /^https:\/\/github\.com\/terran-labs\/vorteo\/blob\/main\/VORTEO_CHANGELOG\.md(?:[?#]|$)/;

async function expectDiagnosticReport(page: Page): Promise<void> {
  const sheet = page.getByTestId("app-diagnostic-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Copy diagnostic" })).toBeEnabled();
  await expect(page.getByText(/App version:/).first()).toBeVisible();
}

async function closeSheet(page: Page, testID: string): Promise<void> {
  const sheet = page.getByTestId(testID);
  await sheet.getByLabel("Close").click();
  await expect(sheet).not.toBeVisible();
}

async function expectExternalPage(
  page: Page,
  actionTestID: string,
  expectedUrl: RegExp,
): Promise<void> {
  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId(actionTestID).click();
  const popup = await popupPromise;
  expect(popup.url()).toMatch(expectedUrl);
  await popup.close();
}

// Help and support left the sidebar menu; its actions live in Settings, under About.
test("opens troubleshooting and support destinations from Settings", async ({ page }) => {
  await gotoAppShell(page);
  await openSettings(page);

  await test.step("opens diagnostics and keyboard shortcuts", async () => {
    await page.getByTestId("settings-help-diagnostics").click();
    await expectDiagnosticReport(page);
    await closeSheet(page, "app-diagnostic-sheet");

    await page.getByTestId("settings-help-shortcuts").click();
    await expect(page.getByTestId("keyboard-shortcuts-dialog")).toBeVisible();
    await closeSheet(page, "keyboard-shortcuts-dialog");
  });

  await test.step("opens support pages", async () => {
    await expectExternalPage(page, "settings-help-discord", DISCORD_DESTINATION);
    await expectExternalPage(page, "settings-help-github", GITHUB_ISSUE_DESTINATION);
  });
});

test("renders the changelog from Settings and links the Vorteo repository", async ({ page }) => {
  // Future dates keep these rendering fixtures above bundled historical notes.
  // A callout, a section name the app has never seen, and a fenced sample whose
  // contents look like a release heading.
  await serveChangelog(page, [
    "# Changelog",
    "",
    "## 9.1.0 - 2099-03-04",
    "",
    "Headline release note.",
    "",
    "> [!WARNING]",
    "> Read this before upgrading.",
    "",
    "### Sparkles",
    "",
    "- Added a brand new thing",
    "",
    "```md",
    "## 0.0.0 - 1999-01-01",
    "```",
    "",
    "## 9.0.0 - 2099-02-01",
    "",
    "### Fixed",
    "",
    "- Fixed an older thing",
    "",
  ]);
  await gotoAppShell(page);

  await openSettings(page);
  await page.getByTestId("settings-whats-new").click();
  const sheet = page.getByTestId("changelog-sheet");
  await expect(sheet).toBeVisible();
  const latest = release(sheet, "9.1.0");

  await expect(latest.getByText("March 4, 2099", { exact: true })).toBeVisible();
  await expect(latest.getByText("Headline release note.")).toBeVisible();
  await expect(latest.getByText("Read this before upgrading.")).toBeVisible();
  await expect(latest.getByText("Sparkles", { exact: true })).toBeVisible();
  await expect(latest.getByText("Added a brand new thing")).toBeVisible();
  await expect(release(sheet, "9.0.0")).toBeVisible();
  await expect(release(sheet, "0.0.0")).toHaveCount(0);

  await expectExternalPage(page, "changelog-open-website", CHANGELOG_DESTINATION);
  await closeSheet(page, "changelog-sheet");
});

test("searches keyboard shortcuts from Settings help", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await gotoAppShell(page);
  await openSettings(page);
  await page.getByTestId("settings-help-shortcuts").click();

  const dialog = page.getByTestId("keyboard-shortcuts-dialog");
  const search = page.getByPlaceholder("Search shortcuts");

  await search.fill("command+n");
  await expect(dialog.getByText("New workspace", { exact: true })).toBeVisible();

  await search.fill("interrupt");

  await expect(dialog.getByText("Interrupt agent", { exact: true })).toBeVisible();
  await expect(dialog.getByText("New workspace", { exact: true })).toHaveCount(0);

  await search.fill("no matching shortcut");
  await expect(dialog.getByText("No results found", { exact: true })).toBeVisible();

  await search.fill("");
  await expect(dialog.getByText("New workspace", { exact: true })).toBeVisible();
});

test("keeps diagnostics available from Settings after globalizing the sheet", async ({ page }) => {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "diagnostics");

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expectDiagnosticReport(page);
});

test.describe("compact sidebar help", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("toolbar buttons provide finger-sized targets and accept taps beyond the glyph", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openCompactSidebar(page);
    await expectFingerSizedToolbarTargets(page);
    await tapMoreNearTargetEdge(page);
    await expect(
      page.locator('[data-testid="sidebar-display-grouping"]:visible').first(),
    ).toBeVisible();
  });

  test("offers diagnostics without advertising disabled keyboard shortcuts", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    // Help lives in System > About since 2eda5255a; phones open Settings on its section list.
    await revealSettingsLocation(page, "about");
    await expect(page.getByTestId("settings-help-shortcuts")).toHaveCount(0);
    await page.getByTestId("settings-help-diagnostics").click();
    await expectDiagnosticReport(page);
  });
});

function compactToolbar(page: Page) {
  return page.locator('[data-testid="sidebar-toolbar"]:visible').first();
}

async function openCompactSidebar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await expect(compactToolbar(page)).toBeVisible();
}

// Collapse, Search, History, Schedules, Settings and More share the toolbar line.
const TOOLBAR_BUTTON_TEST_IDS =
  /^sidebar-(collapse|search|sessions|schedules|settings|footer-overflow)$/;

async function expectFingerSizedToolbarTargets(page: Page): Promise<void> {
  const buttons = compactToolbar(page).getByTestId(TOOLBAR_BUTTON_TEST_IDS);
  await expect(buttons).toHaveCount(6);
  for (const button of await buttons.all()) {
    const bounds = (await button.boundingBox())!;
    // Flex layout can report a 44px box as 43.99999px; round to a hundredth before comparing.
    expect(Math.round(bounds.width * 100) / 100).toBeGreaterThanOrEqual(44);
    expect(Math.round(bounds.height * 100) / 100).toBeGreaterThanOrEqual(44);
    // The phone menu toggle draws its glyph from lines rather than an svg icon.
    const glyph = button.locator("svg").first();
    if (await glyph.count())
      expect(Number(await glyph.getAttribute("width"))).toBeLessThanOrEqual(20);
  }
}

/** Help and support opens from More; a tap near the target's corner still lands. */
async function tapMoreNearTargetEdge(page: Page): Promise<void> {
  const more = compactToolbar(page).getByTestId("sidebar-footer-overflow");
  const bounds = await more.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await more.tap({ position: { x: 4, y: 4 } });
}

test("automatically reveals older interleaved release notes while scrolling", async ({ page }) => {
  await serveChangelog(page, [
    "## 9.2.0 - 2030-01-01",
    "",
    "- Newest upstream feature",
    "",
    "## 9.1.0 - 2026-10-05",
    "",
    "- Same day upstream feature",
    "",
    "## 9.0.0 - 2026-10-04",
    "",
    "- Older upstream feature",
  ]);
  await gotoAppShell(page);
  await openSettings(page);
  await page.getByTestId("settings-whats-new").click();
  const sheet = page.getByTestId("changelog-sheet");
  const entries = sheet.locator('[data-testid^="changelog-release-"]');
  await expect(entries).toHaveCount(5);
  await expect(entries.first()).toHaveAttribute("data-testid", "changelog-release-9.2.0");
  await expect(entries.first().getByText("Paseo", { exact: true })).toBeVisible();
  await expect(entries.nth(1).getByText("Vorteo", { exact: true })).toBeVisible();
  await expect(release(sheet, latestCustomRelease.version).first()).toBeVisible();
  await expect(sheet.getByTestId("changelog-show-more")).toHaveCount(0);
  await expect
    .poll(async () => {
      await entries.last().scrollIntoViewIfNeeded();
      await entries.last().hover();
      await page.mouse.wheel(0, 1800);
      return entries.count();
    })
    .toBeGreaterThan(5);
  await expect(sheet.getByTestId("changelog-show-more")).toHaveCount(0);
  const dates = await entries.evaluateAll((elements) =>
    elements.map((element) => {
      const date = element.textContent?.match(/[A-Z][a-z]+ \d{1,2}, \d{4}/)?.[0];
      return date ? Date.parse(date) : 0;
    }),
  );
  expect(dates).toEqual([...dates].sort((left, right) => right - left));
  await closeSheet(page, "changelog-sheet");
  await page.getByTestId("settings-whats-new").click();
  await expect(entries).toHaveCount(5);
  await closeSheet(page, "changelog-sheet");
  await expect(page.getByTestId("settings-vorton-mode")).toHaveCount(0);
});

test("keeps Vorteo notes readable when Paseo fails and retries upstream", async ({ page }) => {
  const url = "https://raw.githubusercontent.com/getpaseo/paseo/main/CHANGELOG.md";
  await page.route(url, (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await gotoAppShell(page);
  await openSettings(page);
  await page.getByTestId("settings-whats-new").click();
  const sheet = page.getByTestId("changelog-sheet");
  await expect(sheet).toBeVisible();
  await expect(release(sheet, latestCustomRelease.version).first()).toBeVisible();
  await expect(sheet.getByTestId("changelog-error")).toBeVisible();
  await page.unroute(url);
  // Date the fixture ahead of every real release so it sorts first and is rendered.
  await serveChangelog(page, ["## 9.1.0 - 2030-01-01", "", "- Upstream recovered"]);
  await sheet.getByTestId("changelog-retry").click();
  await expect(sheet.getByText("Upstream recovered")).toBeVisible();
  await expect(release(sheet, latestCustomRelease.version).first()).toBeVisible();
});
