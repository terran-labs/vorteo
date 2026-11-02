import {
  closeModelPicker,
  openScheduleModelPicker,
  seedAgentProfiles,
} from "../support/helpers/agent-profiles";
import { seedWorkspace } from "../support/helpers/seed-client";
import { writeFile } from "node:fs/promises";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import {
  expectProviderInstalledInSettings,
  findAcpCatalogProvider,
  goBackInSettings,
  installAcpCatalogProvider,
  openAddProviderArea,
  openCompactSettings,
  openSettingsHost,
  openSettingsHostSection,
  seedSavedSettingsHosts,
} from "../support/helpers/settings";

import { buildOpenProjectRoute } from "@/utils/host-routes";

const ACP_PROVIDER = {
  id: "minimax-code",
  name: "MiniMax Code",
};

interface ProviderCatalogDaemonClient {
  getLastServerInfoMessage(): {
    features?: { hopliteProvider?: boolean; plugins?: boolean };
  } | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  getDaemonConfig(): Promise<{ config: { providers?: Record<string, unknown> } }>;
  getProvidersSnapshot(): Promise<{ entries: Array<{ provider: string }> }>;
  patchDaemonConfig(config: { removeProviders?: string[] }): Promise<unknown>;
}

test.describe("ACP provider catalog", () => {
  test("adds MiniMax Code from settings", async ({ page }) => {
    const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
      clientIdPrefix: "provider-catalog-e2e",
    });
    try {
      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");
      await openAddProviderArea(page);

      await installAcpCatalogProvider(page, ACP_PROVIDER.name);
      await expectProviderInstalledInSettings(page, ACP_PROVIDER.name);
    } finally {
      await client.patchDaemonConfig({ removeProviders: [ACP_PROVIDER.id] }).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`adds Hoplite from the catalog in ${theme} theme`, async ({ page }, testInfo) => {
    const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
      clientIdPrefix: "hoplite-catalog-e2e",
    });
    try {
      expect(client.getLastServerInfoMessage()?.features?.hopliteProvider).toBe(true);
      await client.patchDaemonConfig({ removeProviders: ["hoplite"] });
      expect(
        (await client.getProvidersSnapshot()).entries.some((entry) => entry.provider === "hoplite"),
      ).toBe(false);
      await page.addInitScript((value) => {
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: value }));
      }, theme);
      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");
      await expect(
        page.getByRole("button", { name: "Hoplite provider details", exact: true }),
      ).toHaveCount(0);
      await openAddProviderArea(page);
      await findAcpCatalogProvider(page, "Hoplite");
      await page.screenshot({ path: testInfo.outputPath(`hoplite-catalog-${theme}.png`) });
      await installAcpCatalogProvider(page, "Hoplite");
      await expectProviderInstalledInSettings(page, "Hoplite");
      await page.screenshot({ path: testInfo.outputPath(`hoplite-installed-${theme}.png`) });
      expect((await client.getDaemonConfig()).config.providers?.hoplite).toEqual({
        enabled: true,
        removed: false,
      });
      await writeFile(
        testInfo.outputPath(`hoplite-added-${theme}.json`),
        JSON.stringify(await client.getProvidersSnapshot(), null, 2),
      );
      await removeHoplite(page);
      await expect(
        page.getByRole("button", { name: "Hoplite provider details", exact: true }),
      ).toHaveCount(0);
      await writeFile(
        testInfo.outputPath(`hoplite-removal-config-${theme}.json`),
        JSON.stringify(await client.getDaemonConfig(), null, 2),
      );
      expect((await client.getDaemonConfig()).config.providers?.hoplite).toEqual({
        enabled: false,
        removed: true,
      });
      expect(
        (await client.getProvidersSnapshot()).entries.some((entry) => entry.provider === "hoplite"),
      ).toBe(false);
      await writeFile(
        testInfo.outputPath(`hoplite-removed-${theme}.json`),
        JSON.stringify(await client.getProvidersSnapshot(), null, 2),
      );
      await openAddProviderArea(page);
      await findAcpCatalogProvider(page, "Hoplite");
      await page.screenshot({ path: testInfo.outputPath(`hoplite-removed-${theme}.png`) });
      await installAcpCatalogProvider(page, "Hoplite");
      await expectProviderInstalledInSettings(page, "Hoplite");
      expect((await client.getDaemonConfig()).config.providers?.hoplite).toEqual({
        enabled: true,
        removed: false,
      });
      expect(
        (await client.getProvidersSnapshot()).entries
          .filter((entry) => entry.provider === "hoplite")
          .map((entry) => entry.provider),
      ).toEqual(["hoplite"]);
      await writeFile(
        testInfo.outputPath(`hoplite-reinstalled-${theme}.json`),
        JSON.stringify(
          { config: await client.getDaemonConfig(), snapshot: await client.getProvidersSnapshot() },
          null,
          2,
        ),
      );
    } finally {
      await client.patchDaemonConfig({ removeProviders: ["hoplite"] }).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
}

async function removeHoplite(page: import("@playwright/test").Page): Promise<void> {
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByTestId("provider-remove-hoplite").click();
}

test("unsupported host asks for an update without writing Hoplite config", async ({
  page,
  outdatedDaemon,
}, testInfo) => {
  const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
    clientIdPrefix: "hoplite-unsupported",
    port: Number(new URL(`http://${outdatedDaemon.endpoint}`).port),
  });
  try {
    expect(client.getLastServerInfoMessage()?.features?.plugins).toBe(true);
    expect(client.getLastServerInfoMessage()?.features?.hopliteProvider).toBe(false);
    const before = await client.getDaemonConfig();
    await seedSavedSettingsHosts(page, [outdatedDaemon]);
    await page.reload();
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("Expected a fixed browser viewport");
    // Match the app compact form-factor boundary; exercise each layout through its real entry.
    if (viewport.width < 500) {
      await openCompactSettings(page, buildOpenProjectRoute());
    } else {
      await openSettings(page);
    }
    await openSettingsHost(page, outdatedDaemon.serverId);
    if (viewport.width < 500) {
      await goBackInSettings(page);
      await expect(page.getByTestId("settings-sidebar")).toBeVisible();
    }
    await openSettingsHostSection(page, outdatedDaemon.serverId, "providers");
    await openAddProviderArea(page);
    await page.getByRole("button", { name: "Add Hoplite", exact: true }).click();
    const errorAlert = page.getByTestId("provider-install-error");
    await expect(errorAlert).toHaveText("Update the host to add Hoplite.");
    await expect(errorAlert).toBeInViewport();
    expect((await client.getDaemonConfig()).config).toEqual(before.config);
    await expect(
      page.getByRole("button", { name: "Hoplite provider details", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("hoplite-update-host.png") });
  } finally {
    await client.close();
  }
});

test("model selector excludes Hoplite before opt-in", async ({ page }, testInfo) => {
  const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
    clientIdPrefix: "hoplite-picker",
  });
  const profiles = await seedAgentProfiles([
    { id: "hoplite-picker-anchor", name: "Picker anchor", provider: "mock" },
  ]);
  const workspace = await seedWorkspace({ repoPrefix: "hoplite-picker-" });
  try {
    await client.patchDaemonConfig({ removeProviders: ["hoplite"] });
    expect((await client.getDaemonConfig()).config.providers?.hoplite).toBeUndefined();
    expect(
      (await client.getProvidersSnapshot()).entries.filter((entry) => entry.provider === "hoplite"),
    ).toEqual([]);
    await openScheduleModelPicker(page, workspace.projectKey);
    await expect(page.getByTestId("model-provider-mock")).toBeVisible();
    await expect(page.getByTestId("model-provider-hoplite")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("hoplite-model-selector-absent.png") });
    await closeModelPicker(page);
  } finally {
    await workspace.cleanup();
    await profiles.restore();
    await client.close();
  }
});
