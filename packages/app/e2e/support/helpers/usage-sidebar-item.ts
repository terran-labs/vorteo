import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, type Locator, type Page } from "@playwright/test";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";

/** Real usage-source plugin; its long report makes the Usage modal scroll. */
export async function installTallUsageSource() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-tall-usage-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const cleanup = async () => {
    try {
      await client.removePlugin("tall-usage");
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id: "tall-usage",
        requirements: pluginRequirements,
      }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import { z } from "zod";
export default function contribute(server) {
  server.registerUsageSource({
    id: "tall-usage", label: "Scrolling account", input: z.object({}),
    discover: async () => [{key: "scrolling-account", input: {}}],
    fetch: async () => ({ status: "available", windows: Array.from({ length: 20 }, (_, i) => ({
      id: String(i), label: "Window " + (i + 1), usedPct: 25,
    })) }),
  });
  return () => {};
}
`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installPluginSource({ source: directory });
    return { cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const PLUGINS_DIR = path.resolve(__dirname, "../../../../../plugins");

function sourceIcon(plugin: string): string {
  return readFileSync(path.join(PLUGINS_DIR, plugin, "icon.svg"), "utf8");
}

function inOneDay(): string {
  return new Date(Date.now() + 24 * 60 * 60_000).toISOString();
}

/** Claude and Codex reports shaped like the built-in sources report them. */
export function claudeAndCodexReports(): UsageReportEntry[] {
  const fetchedAt = new Date().toISOString();
  return [
    {
      id: "claude:default",
      account: { label: "dev@example.com" },
      fetchedAt,
      sourceId: "claude",
      sourceLabel: "Claude",
      icon: sourceIcon("claude-usage-source"),
      report: {
        status: "available",
        planLabel: "Max",
        windows: [
          {
            id: "five_hour",
            label: "Session",
            shortLabel: "5h",
            summary: true,
            usedPct: 31,
            resetsAt: inOneDay(),
          },
          {
            id: "weekly",
            label: "Weekly",
            shortLabel: "wk",
            summary: true,
            usedPct: 54,
            resetsAt: inOneDay(),
          },
        ],
      },
    },
    {
      id: "codex:default",
      account: { label: "dev@example.com" },
      fetchedAt,
      sourceId: "codex",
      sourceLabel: "Codex",
      icon: sourceIcon("codex-usage-source"),
      report: {
        status: "available",
        planLabel: "Pro",
        windows: [
          {
            id: "session",
            label: "Session",
            shortLabel: "5h",
            summary: true,
            usedPct: 7,
            resetsAt: inOneDay(),
          },
          {
            id: "weekly",
            label: "Weekly",
            shortLabel: "wk",
            summary: true,
            usedPct: 12,
            resetsAt: inOneDay(),
          },
        ],
      },
    },
  ];
}

/** The first visible match: the shell keeps a compact copy of the sidebar mounted. */
function visible(page: Page, testID: string): Locator {
  return page.locator(`[data-testid="${testID}"]:visible`).first();
}

/** The retained full-screen Usage route. */
export function usageModal(page: Page): Locator {
  return visible(page, "usage-screen");
}

/** The retained fork policy renders neither a Usage summary nor the retired Usage icon. */
export async function expectNoUsageItem(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="sidebar-usage"]:visible')).toHaveCount(0);
  await expect(page.locator('[data-testid="sidebar-usage-icon"]:visible')).toHaveCount(0);
}

/**
 * A report card whose window rows do not pin: no pin toggle, no pin glyph, and nothing focusable
 * but buttons, so no row presses or highlights on hover.
 */
export async function expectUnpinnableRows(card: Locator): Promise<void> {
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(card.locator('[data-testid^="usage-pin-"]')).toHaveCount(0);
  const focusable = await card
    .locator("[tabindex]")
    .evaluateAll((nodes) => nodes.filter((node) => node.getAttribute("role") !== "button").length);
  expect(focusable).toBe(0);
}

/** The left sidebar's Quota card, which lists each account on the usage host. */
export function quotaCard(page: Page): Locator {
  return visible(page, "global-quota-card");
}

/**
 * The Quota card's Open Usage link: the supported sidebar entry to Usage, shown while the card
 * lists an account. On a phone the sidebar drawer has to be open.
 */
export async function openUsageFromQuotaCard(page: Page): Promise<void> {
  await quotaCard(page).getByTestId("global-quota-open-usage").click({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/usage$/);
  await expect(usageModal(page)).toBeVisible();
}

/** Scrolls the Usage modal's body with the mouse wheel, as a user does. */
export async function scrollUsage(page: Page, deltaY: number): Promise<void> {
  const body = await usageModal(page).boundingBox();
  const viewport = page.viewportSize();
  if (!body || !viewport) throw new Error("Usage must be open before scrolling it.");
  // The middle of the part of the body on screen; the body itself runs past the viewport.
  const top = Math.max(body.y, 0);
  const bottom = Math.min(body.y + body.height, viewport.height);
  await page.mouse.move(body.x + body.width / 2, (top + bottom) / 2);
  await page.mouse.wheel(0, deltaY);
}

/** Reach a window with the wheel even when other reports follow its card. */
export async function scrollUsageToWindow(page: Page, label: string): Promise<void> {
  const target = await usageModal(page).getByText(label, { exact: true }).boundingBox();
  const viewport = page.viewportSize();
  if (!target || !viewport) throw new Error("Usage window must exist before scrolling to it.");
  await scrollUsage(page, target.y + target.height / 2 - viewport.height / 2);
}

/** Leave the Usage route through browser history. */
export async function closeUsage(page: Page): Promise<void> {
  await page.goBack();
  await expect(page).not.toHaveURL(/\/usage$/);
}

/** Expand the inline Settings disclosure without replacing the usage reports. */
export async function openUsageOptions(page: Page): Promise<void> {
  const toggle = visible(page, "usage-options-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(visible(page, "usage-display-used")).toBeVisible();
}

export function usageOptionsSurface(page: Page): Locator {
  return visible(page, "usage-options");
}

export async function expectUsageOptionsFitContent(page: Page): Promise<void> {
  const surface = usageOptionsSurface(page);
  await expect(surface).toBeVisible();
  const controls = page.getByTestId("usage-display-as");
  await controls.scrollIntoViewIfNeeded();
  await expect(controls).toBeInViewport({ ratio: 1 });
}

export async function closeUsageOptions(page: Page): Promise<void> {
  const toggle = visible(page, "usage-options-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  await expect(visible(page, "usage-display-used")).toHaveCount(0);
}

export async function showUsageAs(page: Page, displayAs: "used" | "remaining") {
  await openUsageOptions(page);
  await visible(page, `usage-display-${displayAs}`).click();
  await expect(visible(page, `usage-display-${displayAs}`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await closeUsageOptions(page);
}

export async function refreshAllUsage(page: Page): Promise<void> {
  await visible(page, "usage-refresh-all").click();
}

/** Opens the compact sidebar drawer. */
export async function openCompactSidebar(page: Page): Promise<void> {
  const close = page
    .getByRole("button", { name: "Close menu", exact: true })
    .filter({ visible: true });
  if (!(await close.isVisible())) {
    await page
      .getByRole("button", { name: "Open menu", exact: true })
      .filter({ visible: true })
      .first()
      .click();
  }
  await expectCompactSidebarOpen(page);
}

export async function expectCompactSidebarOpen(page: Page): Promise<void> {
  // The menu button and the sidebar's collapse control share the "Close menu" name.
  await expect(
    page.getByRole("button", { name: "Close menu", exact: true }).filter({ visible: true }).first(),
  ).toHaveAttribute("aria-expanded", "true");
}
