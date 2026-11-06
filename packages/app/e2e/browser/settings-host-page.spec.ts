import { selectSettingsHost } from "../support/helpers/settings";
import {
  openGlobalNewWorkspaceComposer,
  fillNewWorkspaceDraft,
  expectNewWorkspaceDraft,
} from "../support/helpers/new-workspace";
import { readFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { holdDaemonUpdateRequest } from "../support/helpers/daemon-update";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { TEST_HOST_LABEL } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { getServerId } from "../support/helpers/server-id";
import {
  expectSettingsHeader,
  openSettingsHost,
  openHostSection,
  revealSettingsLocation,
  expectHostLabelDisplayed,
  clickEditHostLabel,
  expectHostLabelEditMode,
  expectHostConnectionsCard,
  expectHostInjectMcpCard,
  expectHostProvidersCard,
  expectHostNoDaemonLifecycleRow,
  expectRetiredSidebarSectionsAbsent,
  expectHostPageVisible,
  seedSavedSettingsHosts,
  expectHostRejectedWithReAddGuidance,
  expectNoHostPasswordControls,
  removeHostFromHostPage,
  addDirectHostFromSettings,
  expectHostOnlineWithoutError,
  expectIdleAgentRelease,
  openHostRestartBehavior,
  editRestartRecoveryPrompt,
  expectRestartRecoveryEnabled,
  expectRestartRecoveryPrompt,
  setRestartRecoveryEnabled,
  setIdleAgentRelease,
} from "../support/helpers/settings";

test.describe("Settings host page", () => {
  test("visits host settings and opens the label editor", async ({ page }) => {
    const serverId = getServerId();
    const port = getE2EDaemonPort();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await test.step("connections section shows the seeded connection endpoint", async () => {
      await expectSettingsHeader(page, "Connections");
      await expectHostConnectionsCard(page, port);
    });
    await test.step("agents section shows the inject MCP toggle", async () => {
      await openHostSection(page, serverId, "agents");
      await expectSettingsHeader(page, "Agents");
      await expectHostInjectMcpCard(page);
    });
    await test.step("providers section shows the providers card", async () => {
      await expectHostProvidersCard(page, serverId);
      await expectSettingsHeader(page, "Providers");
    });
    await test.step("host section shows the host label and removal controls", async () => {
      await openHostSection(page, serverId, "host");
      // The host's details live in the Environments pane of the single settings page.
      await expectSettingsHeader(page, "Environments");
      await expectHostLabelDisplayed(page);
      await expect(page.getByTestId("host-page-remove-host-card")).toBeVisible();
      await expect(page.getByTestId("host-page-remove-host-button")).toBeVisible();
      await expect(page.getByTestId("host-page-restart-card")).toHaveCount(0);
    });
    await test.step("System exposes restart controls in the Host overflow menu", async () => {
      await selectSettingsHost(page, serverId);
      await revealSettingsLocation(page, "system.overview");
      const pane = page.getByTestId("system-pane").filter({ visible: true });
      await pane.getByRole("button", { name: "Host actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Restart…", exact: true }).click();
      const restart = page.getByTestId("system-restart-host");
      await expect(restart.getByTestId("host-page-restart-card")).toBeVisible();
      await expect(restart.getByTestId("host-page-restart-button")).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(restart).toHaveCount(0);
    });
    await test.step("clicking the label pencil reveals the inline editor", async () => {
      await openHostSection(page, serverId, "host");

      await expectHostLabelDisplayed(page);
      await clickEditHostLabel(page);
      await expectHostLabelEditMode(page, TEST_HOST_LABEL);
      await page.keyboard.press("Escape");
    });
    await test.step("host section does not render daemon lifecycle controls for a remote daemon", async () => {
      await openHostSection(page, serverId, "host");

      await expectHostNoDaemonLifecycleRow(page);
    });
    await test.step("settings sidebar exposes the flat App and Host section rows", async () => {
      await expectRetiredSidebarSectionsAbsent(page);
    });
  });

  test("a failed remote update in System reports its error and allows retry", async ({
    page,
    outdatedDaemon,
  }) => {
    const update = await holdDaemonUpdateRequest(page, outdatedDaemon.endpoint);
    await seedSavedSettingsHosts(page, [outdatedDaemon]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, outdatedDaemon.serverId);
    await openHostSection(page, outdatedDaemon.serverId, "host");
    // Host details keep removal and appearance, while System owns lifecycle actions.
    const hostDetails = page.getByTestId(`settings-environment-${outdatedDaemon.serverId}`).first();
    await expect(hostDetails.getByTestId("host-page-update-button")).toHaveCount(0);
    await expect(hostDetails.getByTestId("host-page-update-error")).toHaveCount(0);
    await expect(hostDetails.getByTestId("host-page-restart-card")).toHaveCount(0);
    await selectSettingsHost(page, outdatedDaemon.serverId);
    await revealSettingsLocation(page, "system.overview");
    const pane = page.getByTestId("system-pane").filter({ visible: true });
    const updateButton = pane.getByTestId("host-page-update-button");
    page.once("dialog", (dialog) => dialog.accept());
    await updateButton.click();
    await update.waitUntilHeld();
    await expect(updateButton).toBeDisabled();
    await expect(pane.getByText("Updating", { exact: true })).toBeVisible();
    update.release();
    const error = page
      .getByTestId("app-toast-message")
      .filter({ hasText: "Could not update Host:" });
    await expect(error).toBeVisible();
    await expect(updateButton).toBeEnabled();
  });

  test("a host rejected for its password reconnects after being removed and added again with it", async ({
    page,
  }) => {
    const password = "e2e host password";
    const daemon = await startIsolatedHostDaemon("srv_e2e_password_host", {
      environment: { ...process.env, PASEO_PASSWORD: password },
    });
    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: TEST_HOST_LABEL,
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: daemon.serverId,
          label: "Password host",
          endpoint: `127.0.0.1:${daemon.port}`,
        },
      ]);
      await page.reload();
      await openSettings(page);
      await openHostSection(page, daemon.serverId, "host");

      await test.step("the host page shows the reason and the re-add guidance, with no password UI", async () => {
        await expectHostRejectedWithReAddGuidance(page, "Password required");
        await expectNoHostPasswordControls(page);
      });

      await test.step("removing the host and adding it again with the password brings it online", async () => {
        await removeHostFromHostPage(page, daemon.serverId);
        await addDirectHostFromSettings(page, { host: "127.0.0.1", port: daemon.port, password });
        await openHostSection(page, daemon.serverId, "host");
        await expectHostOnlineWithoutError(page);
      });
    } finally {
      await daemon.close();
    }
  });

  test("idle agent release changes live on one host and stays saved without restarting", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const primaryServerId = getServerId();
    const daemon = await startIsolatedHostDaemon("srv_e2e_idle_agent_release");
    const client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "idle-release-settings",
      port: daemon.port,
    });
    const otherClient = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "idle-release-other-host",
      port: Number(getE2EDaemonPort()),
    });
    const originalPid = (await client.getDaemonStatus()).pid;
    const expectLiveSavedSetting = async (enabled: boolean) => {
      const saved = JSON.parse(await readFile(path.join(daemon.paseoHome, "config.json"), "utf8"));
      expect(saved.agents.idleRuntimeCleanup).toBe(enabled);
      expect((await client.getDaemonConfig()).config.idleRuntimeCleanup).toBe(enabled);
      expect((await client.reloadDaemonConfig()).restartRequiredPaths).toEqual([]);
      expect((await client.getDaemonStatus()).pid).toBe(originalPid);
    };
    // System follows the selected standalone Host. Each Host retains its own restart settings.
    const hosts = [
      {
        serverId: daemon.serverId,
        label: "Idle release host",
        endpoint: `127.0.0.1:${daemon.port}`,
      },
      {
        serverId: primaryServerId,
        label: TEST_HOST_LABEL,
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      },
    ];
    const openHostAgentsInFreshApp = async (serverId: string) => {
      await seedSavedSettingsHosts(page, hosts);
      await page.reload();
      await openSettings(page);
      await selectSettingsHost(page, serverId);
      await openHostRestartBehavior(page, serverId);
    };
    try {
      await test.step("idle agent release starts on and turns off", async () => {
        await openHostAgentsInFreshApp(daemon.serverId);
        await expectIdleAgentRelease(page, true);
        await setIdleAgentRelease(page, false);
        await expectLiveSavedSetting(false);
      });

      await test.step("a fresh app reads the saved setting from the same running host", async () => {
        await openHostAgentsInFreshApp(daemon.serverId);
        await expectIdleAgentRelease(page, false);
        await expectLiveSavedSetting(false);
        await setIdleAgentRelease(page, true);
        await expectLiveSavedSetting(true);
        await setIdleAgentRelease(page, false);
      });

      await test.step("other hosts keep their own setting", async () => {
        await selectSettingsHost(page, primaryServerId);
        await openHostRestartBehavior(page, primaryServerId);
        await expectIdleAgentRelease(page, true);
        expect((await otherClient.getDaemonConfig()).config.idleRuntimeCleanup).toBe(true);
        await expectLiveSavedSetting(false);
      });
    } finally {
      await otherClient.close();
      await client.close();
      await daemon.close();
    }
  });

  test("a failed idle release save stays visible and retry applies it live", async ({ page }) => {
    const daemon = await startIsolatedHostDaemon("srv_e2e_idle_release_failure");
    const configPath = path.join(daemon.paseoHome, "config.json");
    try {
      await seedSavedSettingsHosts(page, [
        { serverId: daemon.serverId, label: "Failure host", endpoint: `127.0.0.1:${daemon.port}` },
      ]);
      await page.reload();
      await openSettings(page);
      await openHostRestartBehavior(page, daemon.serverId);
      await expectIdleAgentRelease(page, true);
      // A real filesystem failure, with the daemon and RPC path intact.
      await rename(configPath, `${configPath}.saved`);
      await mkdir(configPath);
      await page.getByRole("switch", { name: "Release idle agents" }).click();
      // The transactional writer preserves the filesystem error rather than upstream's prefix.
      const saveError = page.getByTestId("host-page-idle-runtime-cleanup-error");
      await expect(saveError).toBeVisible();
      await expect(saveError).toHaveText(/\S/);
      await expectIdleAgentRelease(page, true);
      await rm(configPath, { recursive: true });
      await rename(`${configPath}.saved`, configPath);
      await setIdleAgentRelease(page, false);
      await expect(page.getByTestId("host-page-idle-runtime-cleanup-error")).toHaveCount(0);
    } finally {
      await daemon.close();
    }
  });

  test("navigating to /settings/hosts/[serverId] redirects to the connections section", async ({
    page,
  }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await page.goto(`/settings/hosts/${encodeURIComponent(serverId)}`);

    await expectHostPageVisible(page, serverId);
    await expectSettingsHeader(page, "Connections");
    await openHostSection(page, serverId, "host");
    await expectHostLabelDisplayed(page);
    await expect(page.getByTestId("host-page-remove-host-card")).toBeVisible();
    await expect(page.getByTestId("host-page-restart-card")).toHaveCount(0);
  });
});

test("restart recovery defaults off and persists opt-in and custom prompt", async ({ page }) => {
  // Exercise the owning card directly; environment navigation has separate coverage.
  await page.goto("/settings/system");
  await expect(page.getByTestId("system-restart-behavior")).toBeVisible();
  await expectRestartRecoveryEnabled(page, false);
  await setRestartRecoveryEnabled(page, true);
  await page.reload();
  await expectRestartRecoveryEnabled(page, true);
  await expectRestartRecoveryPrompt(page, "Resume working.");
  await editRestartRecoveryPrompt(page, "Continue the interrupted work.");
  await setRestartRecoveryEnabled(page, false);
  await page.reload();
  await expectRestartRecoveryEnabled(page, false);
  await setRestartRecoveryEnabled(page, true);
  await expectRestartRecoveryPrompt(page, "Continue the interrupted work.");
  await editRestartRecoveryPrompt(page, "Resume working.");
});

test("sidebar Add host preserves its caller and stays closed after theme changes", async ({
  page,
}) => {
  await gotoAppShell(page);
  await expect(page).toHaveURL(/\/open-project$/);
  const originalUrl = page.url();
  await openSidebarAddHost(page);
  await expect(page).toHaveURL(originalUrl);
  await closeAddHostAndChangeTheme(page);
  await expect(page.getByRole("button", { name: "Direct connection", exact: true })).toBeHidden();
  await expect(page).toHaveURL(originalUrl);
});

async function openSidebarAddHost(page: import("@playwright/test").Page) {
  await page.getByTestId("sidebar-footer-overflow").click();
  await page.getByTestId("sidebar-add-host").click();
  await expect(page.getByRole("button", { name: "Direct connection", exact: true })).toBeVisible();
}

async function closeAddHostAndChangeTheme(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Direct connection", exact: true })).toBeHidden();
  await page.keyboard.press("Control+Alt+t");
}

test("sidebar Add host completes without navigating", async ({ page }) => {
  await gotoAppShell(page);
  await expect(page).toHaveURL(/\/open-project$/);
  const originalUrl = page.url();
  await openSidebarAddHost(page);
  await connectToTestHost(page);
  await expect(page).toHaveURL(originalUrl);
  await expect(page.getByTestId("sidebar-footer-overflow")).toBeVisible();
});

test("Settings Add host opens the saved environment details", async ({ page }) => {
  await gotoAppShell(page);
  await openSettings(page);
  await addDirectHostFromSettings(page, { host: "127.0.0.1", port: Number(getE2EDaemonPort()) });
  await expectSettingsHeader(page, "Environments");
  await expect(page).toHaveURL(new RegExp(`/settings/hosts/${getServerId()}/host$`));
});

test("sidebar Add host preserves the New workspace prompt after connecting", async ({ page }) => {
  await gotoAppShell(page);
  await openGlobalNewWorkspaceComposer(page);
  await fillNewWorkspaceDraft(page, "Keep this unfinished prompt while I add a host.");
  const originalUrl = page.url();
  await openSidebarAddHost(page);
  await expect(page).toHaveURL(originalUrl);
  await connectToTestHost(page);
  await expect(page).toHaveURL(originalUrl);
  await expectNewWorkspaceDraft(page, "Keep this unfinished prompt while I add a host.");
});

async function connectToTestHost(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Direct connection", exact: true }).click();
  await page.getByRole("textbox", { name: "Host", exact: true }).fill("127.0.0.1");
  await page.getByRole("textbox", { name: "Port", exact: true }).fill(String(getE2EDaemonPort()));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("add-host-modal")).toBeHidden({ timeout: 30_000 });
}
