import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { openFileFromExplorer } from "../support/helpers/file-explorer";
import { openSettingsSection, clickSettingsBackToWorkspace } from "../support/helpers/settings";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  ensureExplorerSidebar,
  explorerSidebar,
  openFilesPanel,
  openChangesTreePanel,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

const DESKTOP = { width: 1400, height: 900 };
const PHONE = { width: 390, height: 844 };

async function toggleSupportingCards(page: Page) {
  await page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).first().click();
}

async function setDisclosure(page: Page, testID: string, expanded: boolean) {
  const toggle = page.getByTestId(testID).filter({ visible: true }).first();
  if ((await toggle.getAttribute("aria-expanded")) !== String(expanded)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
}

async function cycleWorkspaceTheme(page: Page) {
  await page.keyboard.press("Control+Alt+t");
}

// The fork renders independent retained cards. Upstream tab close, drag and selection
// regressions are exercised through disclosure, main-pane isolation and retained content.
test("Files and Changes disclose independently without changing the main tabs", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const workspace = await seedWorkspace({ repoPrefix: "explorer-sidebar-defaults-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);
    const mainTabs = page
      .getByTestId("workspace-pane-main")
      .locator('[data-testid^="workspace-tab-"]');
    const before = await mainTabs.count();
    const explorer = await ensureExplorerSidebar(page);
    await expect(explorer.getByTestId("supporting-card-files")).toBeVisible();
    await expect(explorer.getByTestId("supporting-card-changes_tree")).toBeVisible();
    await openFilesPanel(page);
    await openChangesTreePanel(page);
    await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
    await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible();
    await setDisclosure(page, "supporting-card-changes_tree-toggle", false);
    await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
    await toggleSupportingCards(page);
    await ensureExplorerSidebar(page);
    await expect(mainTabs).toHaveCount(before);
  } finally {
    await workspace.cleanup();
  }
});

test("Files and Changes collapse and reopen without closing either supporting card", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const workspace = await seedWorkspace({ repoPrefix: "explorer-shared-cards-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFilesPanel(page);
    await openChangesTreePanel(page);
    const explorer = explorerSidebar(page);
    for (const kind of ["files", "changes_tree"]) {
      const card = explorer.getByTestId(`supporting-card-${kind}`);
      await expect(card.getByRole("button", { name: /^Close/ })).toHaveCount(0);
      const toggle = `supporting-card-${kind}-toggle`;
      await setDisclosure(page, toggle, false);
      await expect(card).toBeVisible();
      await setDisclosure(page, toggle, true);
    }
    await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
    await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible();
  } finally {
    await workspace.cleanup();
  }
});

test("agent tabs stay in the workspace while supporting views remain available", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "explorer-agent-isolation-",
    title: "Retained agent",
  });
  try {
    await openAgentRoute(page, workspace);
    await openFilesPanel(page);
    await openChangesTreePanel(page);
    const main = page.getByTestId("workspace-pane-main");
    await expect(main.getByTestId(`workspace-tab-agent_${workspace.agentId}`)).toBeVisible();
    const composer = main.getByRole("textbox", { name: "Message agent..." });
    await composer.fill("Keep the agent in its pane");
    await setDisclosure(page, "supporting-card-files-toggle", false);
    await expect(composer).toHaveValue("Keep the agent in its pane");
    await expect(
      explorerSidebar(page).getByTestId(`workspace-tab-agent_${workspace.agentId}`),
    ).toHaveCount(0);
    await main.getByTestId("workspace-new-tab-button").click();
    await expect(page.getByTestId("workspace-new-tab-menu-agent")).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    await workspace.cleanup();
  }
});

test("resizing from a tablet to a phone exposes compact Files and Changes cards", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "tablet-explorer-" });
  try {
    await page.setViewportSize({ width: 1024, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFilesPanel(page);
    await page.setViewportSize(PHONE);
    await openFilesPanel(page);
    await openChangesTreePanel(page);
    await expect(page.getByTestId("explorer-header")).toBeVisible();
    await expect(page.getByTestId("compact-supporting-card-files")).toBeVisible();
    await expect(page.getByTestId("compact-supporting-card-changes")).toBeVisible();
    await page.getByTestId("explorer-close").click();
    await expect(page.getByTestId("explorer-header")).not.toBeVisible();
    await ensureExplorerSidebar(page);
    await expect(page.getByTestId("explorer-tab-files")).toHaveAttribute("aria-expanded", "true");
  } finally {
    await workspace.cleanup();
  }
});

test("retains the desktop supporting host through appearance changes and folding", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const workspace = await seedWorkspace({ repoPrefix: "explorer-lifetime-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    const explorer = await ensureExplorerSidebar(page);
    await openFilesPanel(page);
    const host = await explorer.elementHandle();
    const tree = await explorer.getByTestId("file-explorer-tree-scroll").elementHandle();
    const filesCard = explorer.getByTestId("supporting-card-files");
    const before = await filesCard.evaluate((element) => getComputedStyle(element).backgroundColor);
    await cycleWorkspaceTheme(page);
    await expect
      .poll(() => filesCard.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(before);
    await toggleSupportingCards(page);
    await ensureExplorerSidebar(page);
    expect(await host!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await tree!.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    await workspace.cleanup();
  }
});

test("compact cards disclose independently and retain their order across reopen", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  const workspace = await seedWorkspace({ repoPrefix: "explorer-compact-disclosure-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFilesPanel(page);
    await openChangesTreePanel(page);
    const order = async () =>
      page
        .locator('[data-testid^="compact-supporting-card-"]:visible')
        .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-testid")));
    const before = await order();
    await setDisclosure(page, "explorer-tab-changes", false);
    await expect(page.getByTestId("explorer-tab-files")).toHaveAttribute("aria-expanded", "true");
    await expect(explorerSidebar(page).getByTestId("file-explorer-tree-scroll")).toBeVisible();
    await setDisclosure(page, "explorer-tab-changes", true);
    await page.getByTestId("explorer-close").click();
    await ensureExplorerSidebar(page);
    expect(await order()).toEqual(before);
    await expect(page.getByTestId("explorer-tab-files")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("explorer-tab-changes")).toHaveAttribute("aria-expanded", "true");
  } finally {
    await workspace.cleanup();
  }
});

test("updates populated code and diff appearance without losing the editor instance or draft", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const workspace = await seedWorkspace({ repoPrefix: "explorer-populated-appearance-" });
  const source = Array.from(
    { length: 120 },
    (_, index) => `export const line${index} = "retained ${index}";`,
  ).join("\n");
  try {
    await writeFile(`${workspace.repoPath}/appearance.ts`, source);
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ codeFontSize: 13, theme: "light" }),
      );
      localStorage.setItem(
        "@paseo:changes-preferences",
        JSON.stringify({ inlineDiff: true, layout: "unified" }),
      );
    });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFilesPanel(page);
    await openFileFromExplorer(page, "appearance.ts");
    const editor = page.getByTestId("file-source-editor").filter({ visible: true });
    const text = editor.locator(".cm-content");
    await expect(text).toBeVisible();
    await text.fill(`${source}\n// unsaved local edit`);
    const instance = await editor.elementHandle();
    const scroller = editor.locator(".cm-scroller");
    await scroller.evaluate((node) => {
      node.scrollTop = 400;
    });
    const scrollBefore = await scroller.evaluate((node) => node.scrollTop);
    await openChangesTreePanel(page);
    const diff = explorerSidebar(page).getByTestId("git-diff-canvas");
    await expect(diff).toBeVisible();
    await page.keyboard.press("Control+,");
    await openSettingsSection(page, "appearance");
    await page.getByLabel(/^Code font size\b/).fill("19");
    await page.getByLabel(/^Code font size\b/).press("Tab");
    await clickSettingsBackToWorkspace(page);
    await expect(text).toHaveCSS("font-size", "19px");
    expect(await instance!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(text).toContainText("unsaved local edit");
    expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollBefore);
    await expect(diff).toHaveCSS("font-size", "19px");
    await cycleWorkspaceTheme(page);
    await toggleSupportingCards(page);
    await ensureExplorerSidebar(page);
    expect(await instance!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(text).toContainText("unsaved local edit");
  } finally {
    await workspace.cleanup();
  }
});

test("retains populated workspace chat and terminal attachments through appearance, hide and fold", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "explorer-chat-appearance-",
    title: "Retained chat",
    initialPrompt: "Show the retention marker",
    featureValues: {
      mockAssistantResponse: "Explorer populated paragraph.\n\n```ts\nconst retained = 42;\n```",
    },
  });
  const attaches: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      try {
        const message = JSON.parse(frame.payload).message;
        if (message?.type === "subscribe_terminal_request") attaches.push(message.terminalId);
      } catch {
        /* Binary terminal traffic is not a JSON request. */
      }
    }),
  );
  try {
    await openAgentRoute(page, workspace);
    await openFilesPanel(page);
    const main = page.getByTestId("workspace-pane-main");
    const paragraph = main.getByText("Explorer populated paragraph.", { exact: true });
    const composer = main.getByRole("textbox", { name: "Message agent..." });
    await expect(paragraph).toBeVisible();
    await composer.fill("Unsubmitted workspace draft");
    const composerNode = await composer.elementHandle();
    await page.keyboard.press("Control+,");
    await openSettingsSection(page, "appearance");
    await page.getByLabel(/^Content font size\b/).fill("20");
    await page.getByLabel(/^Content font size\b/).press("Tab");
    await clickSettingsBackToWorkspace(page);
    await expect(paragraph).toHaveCSS("font-size", "20px");
    expect(await composerNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(composer).toHaveValue("Unsubmitted workspace draft");
    const previousColor = await paragraph.evaluate((node) => getComputedStyle(node).color);
    await cycleWorkspaceTheme(page);
    await expect
      .poll(() => paragraph.evaluate((node) => getComputedStyle(node).color))
      .not.toBe(previousColor);
    await main.getByTestId("workspace-new-tab-button").click();
    await page
      .getByRole("menuitem", { name: /^Terminal/ })
      .first()
      .click();
    const terminal = main.getByTestId("terminal-surface").filter({ visible: true });
    await expect(terminal).toBeVisible();
    await expect.poll(() => attaches.length).toBe(1);
    const terminalNode = await terminal.elementHandle();
    await toggleSupportingCards(page);
    await ensureExplorerSidebar(page);
    await page.setViewportSize(PHONE);
    await ensureExplorerSidebar(page);
    await page.getByTestId("explorer-close").click();
    await page.setViewportSize(DESKTOP);
    expect(await terminalNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(attaches).toHaveLength(1);
    await main.getByTestId(`workspace-tab-agent_${workspace.agentId}`).click();
    expect(await composerNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(composer).toHaveValue("Unsubmitted workspace draft");
    await expect(paragraph).toHaveCSS("font-size", "20px");
  } finally {
    await workspace.cleanup();
  }
});

test("compact file sheets cover Explorer and return to its retained file list", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  const workspace = await seedWorkspace({ repoPrefix: "explorer-sheet-layer-" });
  try {
    await writeFile(`${workspace.repoPath}/sheet-marker.txt`, "Explorer sheet marker\n");
    await gotoWorkspace(page, workspace.workspaceId);
    const explorer = await ensureExplorerSidebar(page);
    await openFilesPanel(page);
    const host = await explorer.elementHandle();
    await openFileFromExplorer(page, "sheet-marker.txt");
    const sheet = page.getByRole("dialog", { name: "sheet-marker.txt", exact: true });
    await expect(sheet.getByText("Explorer sheet marker", { exact: true })).toBeVisible();
    await page
      .getByTestId("sheet-tab-header")
      .filter({ hasText: "sheet-marker.txt" })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(sheet).toHaveCount(0);
    await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
    expect(await host!.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    await workspace.cleanup();
  }
});
