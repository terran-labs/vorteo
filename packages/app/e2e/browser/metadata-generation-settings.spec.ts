import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import {
  openHostSection,
  openSettingsHost,
  revealSettingsLocation,
} from "../support/helpers/settings";

function metadataSection(page: Page) {
  return page.getByTestId("metadata-generation-settings").filter({ visible: true }).first();
}

/** Automatic and Manual are a segmented control, which is a radio group. */
function modeChoice(page: Page, name: "Automatic" | "Manual") {
  return metadataSection(page).getByRole("radio", { name, exact: true });
}

/**
 * Metadata generation sits in Agents' collapsed Advanced group, which a reload closes again, so
 * reopen it the way a reader would.
 */
async function reloadMetadataGenerationSettings(page: Page) {
  await page.reload();
  await revealSettingsLocation(page, "metadata");
  await expect(metadataSection(page)).toBeVisible();
}

async function openMetadataGenerationSettings(page: Page) {
  const serverId = getServerId();
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await openHostSection(page, serverId, "metadata");
  // 537b619e2 folded the Metadata page into the single Settings page as the
  // "Metadata generation" pane.
  await expect(metadataSection(page)).toBeVisible();
}

async function openManualMetadataModelPicker(page: Page) {
  await modeChoice(page, "Manual").click();
  await page.getByRole("button", { name: /Select model/ }).click();
  const picker = page.getByTestId("combobox-desktop-container");
  await expect(picker).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await picker.boundingBox();
      const viewport = page.viewportSize();
      if (!bounds || !viewport) return false;
      return bounds.y >= 16 && bounds.y + bounds.height <= viewport.height - 16;
    })
    .toBe(true);
}

test("chooses a metadata model and can return to automatic selection", async ({
  page,
}, testInfo) => {
  await openMetadataGenerationSettings(page);

  // The section explains itself through the header's info tooltip, not a paragraph.
  await expect(page.getByTestId("metadata-generation-settings-info")).toHaveAccessibleName(
    "About Metadata generation",
  );
  await expect(modeChoice(page, "Automatic")).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    path: testInfo.outputPath("metadata-automatic.png"),
    fullPage: true,
  });

  await openManualMetadataModelPicker(page);
  await page.getByTestId("model-provider-mock").click();
  await expect(page.getByText("Ten second stream", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("metadata-model-picker.png"),
    fullPage: true,
  });
  await page.getByText("Ten second stream", { exact: true }).click();

  await expect(page.getByRole("button", { name: /Ten second stream/ })).toBeVisible();
  await reloadMetadataGenerationSettings(page);
  await expect(modeChoice(page, "Manual")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: /Ten second stream/ })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("metadata-manual-persisted.png"),
    fullPage: true,
  });

  await modeChoice(page, "Automatic").click();
  await reloadMetadataGenerationSettings(page);

  await expect(modeChoice(page, "Automatic")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: /Ten second stream/ })).toHaveCount(0);
});

test("replaces only the first configured metadata model", async ({ page }) => {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();

  try {
    await client.patchDaemonConfig({
      metadataGeneration: {
        providers: [
          { provider: "mock", model: "five-minute-stream" },
          { provider: "mock", model: "thirty-minute-stream" },
        ],
      },
    });
    await openMetadataGenerationSettings(page);

    await expect(modeChoice(page, "Manual")).toHaveAttribute("aria-checked", "true");
    await openManualMetadataModelPicker(page);
    await page.getByText("Ten second stream", { exact: true }).click();

    await expect
      .poll(async () => (await client.getDaemonConfig()).config.metadataGeneration.providers)
      .toEqual([
        { provider: "mock", model: "ten-second-stream" },
        { provider: "mock", model: "thirty-minute-stream" },
      ]);
  } finally {
    try {
      await client.patchDaemonConfig({
        metadataGeneration: {
          providers: previousConfig.config.metadataGeneration.providers,
        },
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1024, height: 600 },
]) {
  test(`keeps the metadata picker inside the ${viewport.width}x${viewport.height} viewport`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await openMetadataGenerationSettings(page);
    await modeChoice(page, "Manual").click();
    const trigger = page.getByRole("button", { name: /Select model/ });
    // Exercise the same lower-edge anchor as Settings after scrolling to this field.
    await trigger.evaluate((element) => element.scrollIntoView({ block: "end" }));
    await trigger.click();
    const picker = page.getByTestId("combobox-desktop-container");
    await expect(picker).toBeVisible();
    await expect(picker).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        picker.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const borderHeight =
            parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
          return {
            left: rect.left >= 0,
            top: rect.top >= 0,
            right: rect.right <= window.innerWidth,
            bottom: rect.bottom <= window.innerHeight,
            contentHeightFits: rect.height === Math.min(400, element.scrollHeight + borderHeight),
            width: rect.width,
          };
        }),
      )
      .toEqual({
        left: true,
        top: true,
        right: true,
        bottom: true,
        contentHeightFits: true,
        width: 360,
      });
    await page.screenshot({ path: testInfo.outputPath("metadata-picker-viewport.png") });
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(picker).toBeInViewport({ ratio: 1 });
    await page.getByTestId("model-provider-mock").click();
    await page.getByText("Ten second stream", { exact: true }).click();
    await expect(page.getByRole("button", { name: /Ten second stream/ })).toBeVisible();
    await modeChoice(page, "Automatic").click();
  });
}
