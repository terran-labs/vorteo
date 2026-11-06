import { test, expect } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { revealSettingsLocation } from "../support/helpers/settings";

test("Settings language selector switches Interface labels", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoAppShell(page);
  await openSettings(page);
  await revealSettingsLocation(page, "appearance.language");
  const language = page
    .getByTestId("settings-pane-appearance.language")
    .filter({ visible: true })
    .first();

  await expect(language.getByText("Language", { exact: true }).first()).toBeVisible();

  await language.getByRole("button", { name: /^System(?:\s|$)/ }).click();
  await page.getByRole("menuitem", { name: "简体中文 - Simplified Chinese", exact: true }).click();

  await expect(language.getByText("语言", { exact: true }).first()).toBeVisible();

  await language.getByRole("button", { name: "简体中文", exact: true }).click();
  await page.getByRole("menuitem", { name: "English - 英语", exact: true }).click();

  await expect(language.getByText("Language", { exact: true }).first()).toBeVisible();
});

test("Settings language selector switches to Korean", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoAppShell(page);
  await openSettings(page);
  await revealSettingsLocation(page, "appearance.language");
  const language = page
    .getByTestId("settings-pane-appearance.language")
    .filter({ visible: true })
    .first();

  await language.getByRole("button", { name: /^System(?:\s|$)/ }).click();
  await page.getByRole("menuitem", { name: "한국어 - Korean", exact: true }).click();

  await expect(language.getByText("언어", { exact: true }).first()).toBeVisible();

  await language.getByRole("button", { name: "한국어", exact: true }).click();
  await page.getByRole("menuitem", { name: "English - 영어", exact: true }).click();

  await expect(language.getByText("Language", { exact: true }).first()).toBeVisible();
});
