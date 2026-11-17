import { expect, type Locator, type Page } from "@playwright/test";
import { openSettings } from "./app";
import { openSettingsSection } from "./settings";
import { waitForPaint } from "./viewport";

const APP_SETTINGS_KEY = "@paseo:app-settings";

// The label ends with the accepted range, such as ", 320 to 1200 px".
function contentWidthInput(page: Page): Locator {
  return page.getByRole("textbox", { name: /^Content width in pixels\b/ });
}

export async function openAppearanceSettings(page: Page): Promise<void> {
  await openSettings(page);
  await openSettingsSection(page, "appearance");
}

export async function setContentWidth(page: Page, width: number): Promise<void> {
  const input = contentWidthInput(page);
  await input.fill(String(width));
  await input.press("Tab");
  await waitForPaint(page);
}

/** An empty field follows the default; it replaced the per-field Reset button. */
export async function resetContentWidth(page: Page): Promise<void> {
  const input = contentWidthInput(page);
  await input.fill("");
  await input.press("Tab");
  await waitForPaint(page);
}

/** The default shows as the placeholder of an empty field and is not stored. */
export async function expectDefaultContentWidthSetting(page: Page, width: number): Promise<void> {
  await expect(contentWidthInput(page)).toHaveValue("");
  await expect(contentWidthInput(page)).toHaveAttribute("placeholder", String(width));
  await expect.poll(() => readStoredContentWidth(page)).toBeNull();
}

export async function expectCustomContentWidthSetting(page: Page, width: number): Promise<void> {
  await expect(contentWidthInput(page)).toHaveValue(String(width));
  await expect.poll(() => readStoredContentWidth(page)).toBe(width);
}

/** Asserts the rendered width of a content-column element stays within `max` and above `min`. */
export async function expectContentColumnWidth(
  element: Locator,
  bounds: { min?: number; max: number },
): Promise<void> {
  await expect(element).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await element.boundingBox())?.width ?? 0)
    .toBeLessThanOrEqual(bounds.max);
  await expect
    .poll(async () => (await element.boundingBox())?.width ?? 0)
    .toBeGreaterThan(bounds.min ?? 0);
}

async function readStoredContentWidth(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null
      ? undefined
      : (JSON.parse(raw) as { contentMaxWidth?: unknown }).contentMaxWidth;
  }, APP_SETTINGS_KEY);
}
