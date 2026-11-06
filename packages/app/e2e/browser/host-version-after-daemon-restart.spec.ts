import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openSettings } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { selectSettingsHost, revealSettingsLocation } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import {
  startRestartableHostDaemon,
  type RestartableHostDaemon,
} from "../support/helpers/versioned-host-daemon";

const PREVIOUS_VERSION = "0.8.0";
const UPDATED_VERSION = "0.9.1";
const HOST_LABEL = "Version restart QA";
const NO_RELOAD_MARKER = "before-restart";

interface ReloadMarkerWindow {
  __paseoE2eHostVersionMarker?: string;
}

test.describe.configure({ timeout: 120_000 });

let hostDaemon: RestartableHostDaemon | null = null;

test.afterEach(async () => {
  await hostDaemon?.dispose();
  hostDaemon = null;
});

test("System details show the restarted Host version without reloading", async ({ page }) => {
  const host = await startRestartableHostDaemon(PREVIOUS_VERSION);
  hostDaemon = host;
  const otherHostVersion =
    await test.step("the connected host reports its current daemon version", async () => {
      // Seed this origin before loading the app once with both Hosts.
      await page.goto("/", { waitUntil: "commit" });
      await addConnectedHostAndReload(page, {
        serverId: host.serverId,
        label: HOST_LABEL,
        port: host.port,
      });
      await openSettings(page);
      const versions = await readConnectedHostVersions(page, [getServerId(), host.serverId]);
      expect(versions[host.serverId]).toContain(`v${PREVIOUS_VERSION}`);
      await showSystemHostDetails(page, host);
      await expect(page.getByTestId("system-pane").filter({ visible: true })).toBeVisible();
      await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toBeVisible();
      await markPageForNoReloadCheck(page, NO_RELOAD_MARKER);
      return versions[getServerId()];
    });

  await test.step("the last known version remains in System details when the Host stops", async () => {
    await host.stop();
    await expect(
      page
        .getByTestId("system-pane")
        .filter({ visible: true })
        .getByRole("button", { name: "Reconnect", exact: true }),
    ).toBeVisible();
    await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toBeVisible();
  });

  await test.step("the host daemon restarts on the new version", async () => {
    await host.restartWithVersion(UPDATED_VERSION);
  });

  await test.step("System details follow the new version", async () => {
    await expect(hostVersionBadge(page, UPDATED_VERSION)).toBeVisible({ timeout: 30_000 });
    await expect(hostVersionBadge(page, PREVIOUS_VERSION)).toHaveCount(0);
    const versions = await readConnectedHostVersions(page, [host.serverId, getServerId()]);
    expect(versions[host.serverId]).toContain(`v${UPDATED_VERSION}`);
    expect(versions[getServerId()]).toBe(otherHostVersion);
    await expectNoReloadSinceMarker(page);
  });
});

/** Read both rows in the open Settings page; closing a former Help menu is no longer needed. */
async function readConnectedHostVersions(
  page: Page,
  serverIds: readonly string[],
): Promise<Record<string, string>> {
  await revealSettingsLocation(page, "general.hosts");
  const versions: Record<string, string> = {};
  for (const serverId of serverIds) {
    const row = page.getByTestId(`settings-host-version-${serverId}`);
    await expect(row).toBeVisible();
    versions[serverId] = await row.innerText();
  }
  return versions;
}

async function showSystemHostDetails(page: Page, host: RestartableHostDaemon): Promise<void> {
  await selectSettingsHost(page, host.serverId);
  await revealSettingsLocation(page, "system.overview");
  await page.getByRole("button", { name: "Host Details", exact: true }).click();
}

function hostIdentity(page: Page) {
  return page.getByTestId("system-pane").filter({ visible: true });
}

function hostVersionBadge(page: Page, version: string) {
  return hostIdentity(page).getByText(`Version: ${version}`, { exact: true });
}

async function markPageForNoReloadCheck(page: Page, marker: string): Promise<void> {
  // The marker has to cross into the page as an argument: the callback runs in the browser, so a
  // captured Node-side constant is not defined there.
  await page.evaluate((value) => {
    (window as typeof window & ReloadMarkerWindow).__paseoE2eHostVersionMarker = value;
  }, marker);
}

async function expectNoReloadSinceMarker(page: Page): Promise<void> {
  const marker = await page.evaluate(
    () => (window as typeof window & ReloadMarkerWindow).__paseoE2eHostVersionMarker ?? null,
  );
  expect(marker).toBe(NO_RELOAD_MARKER);
}
