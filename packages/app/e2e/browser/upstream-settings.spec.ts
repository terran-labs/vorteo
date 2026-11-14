import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { revealSettingsLocation } from "../support/helpers/settings";
import record from "../../src/vorton-updates/upstream-sync.json";
import { UPSTREAM_UPDATE_PROMPT } from "../../src/vorton-updates/upstream";

const week = 7 * 24 * 60 * 60 * 1000;
const mergedAt = Date.parse(record.mergedAt);

async function openAdvanced(page: Page) {
  const pane = page.getByTestId("settings-pane-system.overview").filter({ visible: true }).first();
  await expect(pane).toBeVisible();
  // A real scroll gesture releases the section jump before opening a lower disclosure.
  await page.getByTestId("settings-scroll-page").filter({ visible: true }).first().hover();
  await page.mouse.wheel(0, 1);
  // System's own Advanced toggle merged into the section's shared Advanced group.
  const toggle = page.getByTestId("settings-system-advanced-toggle").filter({ visible: true });
  await toggle.scrollIntoViewIfNeeded();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

for (const width of [1280, 390]) {
  test(`System contains About and a copyable overdue upstream task at ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => {
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
      );
    });
    await page.goto("/settings/system");
    // Let startup finish on the real clock before mounting the dated Advanced section.
    await expect(page.locator("#boot-overlay")).toHaveCount(0);
    await page.clock.setFixedTime(new Date(mergedAt + week + 1));
    // Begin at the owning pane; General's version check follows the upstream controls.
    await expect(page).toHaveURL(/\/settings\/(system|about)$/);
    await openAdvanced(page);
    const section = page.getByTestId("upstream-updates-section");
    await section.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("upstream-merge-date")).toHaveText(
      `Last upstream merge: ${new Date(record.mergedAt).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" })}`,
    );
    await expect(page.getByTestId("upstream-update-overdue")).toBeVisible();
    await expect(page.getByText("This device", { exact: true }).first()).toBeAttached();
    await page.getByTestId("copy-upstream-prompt").click();
    await expect(page.getByTestId("app-toast-message")).toHaveText(
      "Prompt copied. Paste it into an agent session on your host.",
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(UPSTREAM_UPDATE_PROMPT);
    await page.getByTestId("toggle-upstream-prompt").click();
    await expect(page.getByTestId("upstream-host-prompt")).toHaveText(UPSTREAM_UPDATE_PROMPT);
    await page.getByTestId("toggle-upstream-prompt").click();
    await expect(page.getByTestId("upstream-host-prompt")).toHaveCount(0);
    await revealSettingsLocation(page, "about");
    await expect(page.getByText("App version", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("general-upstream.png") });
  });
}

test("the weekly highlight expires while System is open without an alternate product switch", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const key = "@paseo:create-agent-preferences";
    localStorage.setItem(
      key,
      JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
    );
  });
  // Open the owning section so virtual time does not gate its progressive mount.
  await page.goto("/settings/system");
  await expect(page.locator("#boot-overlay")).toHaveCount(0);
  // Virtual time belongs to the weekly boundary, after the real startup handoff.
  await page.clock.install({ time: new Date(mergedAt + week - 60_000) });
  await openAdvanced(page);
  await expect(page.getByTestId("upstream-updates-section")).toHaveCount(1);
  await expect(page.getByTestId("upstream-update-overdue")).toHaveCount(0);
  await page.clock.fastForward(120_000);
  await expect(page.getByTestId("upstream-update-overdue")).toHaveCount(1);
  // Updates Details is unrelated to the weekly timer and stays closed until its own checks.
  await page
    .getByTestId("system-updates-row")
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(page.getByTestId("settings-vorton-mode")).toHaveCount(0);
  await expect(page.getByTestId("upstream-updates-section")).toHaveCount(1);
  await expect(page.getByTestId("vorton-updates-section")).toHaveCount(1);
  await expect(page.getByText("This device", { exact: true }).first()).toBeAttached();
  await expect(
    page.getByTestId("settings-sidebar").getByRole("button", { name: "About", exact: true }),
  ).toHaveCount(0);
});
