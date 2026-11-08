import { expect, type Locator, type Page } from "@playwright/test";
import { getServerId } from "./server-id";

interface ContextMenuAnchor {
  x: number;
  y: number;
}

async function openContextMenuAtRowPoint(
  page: Page,
  rowTestID: string,
  menuTestID: string,
): Promise<ContextMenuAnchor> {
  const row = page.getByTestId(rowTestID);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const bounds = await row.boundingBox();
  if (!bounds) throw new Error(`Could not measure ${rowTestID}`);

  const anchor = {
    x: bounds.x + Math.min(60, bounds.width / 2),
    y: bounds.y + bounds.height / 2,
  };
  await page.mouse.click(anchor.x, anchor.y, { button: "right" });
  await expect(page.getByTestId(menuTestID)).toBeVisible({ timeout: 10_000 });
  return anchor;
}

async function expectContextMenuAtPointer(
  page: Page,
  menuTestID: string,
  anchor: ContextMenuAnchor,
): Promise<void> {
  const bounds = await page.getByTestId(menuTestID).boundingBox();
  if (!bounds) throw new Error(`Could not measure ${menuTestID}`);
  expect(Math.abs(bounds.x - anchor.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(bounds.y - (anchor.y + 4))).toBeLessThanOrEqual(2);
}

/**
 * An element by test id, outside the Pinned section. Since 8c1575df3 a pinned workspace keeps its
 * row in its project or status group and repeats it under Pinned, so its row and kebab test ids
 * match twice. This addresses the copy in its group.
 */
export function outsidePinnedSection(page: Page, testID: string): Locator {
  return page.locator(
    `xpath=//*[@data-testid="${testID}"][not(ancestor::*[@data-testid="sidebar-pinned-section"])]`,
  );
}

/** A workspace row in its project or status group, never its copy under Pinned. */
export function workspaceRowInGroup(page: Page, workspaceId: string): Locator {
  return outsidePinnedSection(page, `sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

/** A workspace row's copy under Pinned. */
export function pinnedWorkspaceRow(page: Page, workspaceId: string): Locator {
  return page
    .getByTestId("sidebar-pinned-section")
    .getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

/**
 * Whether the user can see `locator`. Row actions stay mounted at zero opacity until the row is
 * hovered or focused (bcd8dda7a), which Playwright's visibility check counts as visible.
 */
export async function isShownToUser(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) =>
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
  );
}

export async function openWorkspaceContextMenu(page: Page, workspaceId: string): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  const menuTestID = `sidebar-workspace-context-menu-${workspaceKey}`;
  const anchor = await openContextMenuAtRowPoint(
    page,
    `sidebar-workspace-row-${workspaceKey}`,
    menuTestID,
  );
  await expectContextMenuAtPointer(page, menuTestID, anchor);
}

export async function showWorkspaceHoverCard(page: Page, workspaceId: string): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey}`).hover();
  await expect(page.getByTestId("workspace-hover-card")).toBeVisible();
}

export async function movePointerAwayFromWorkspaceHoverCard(page: Page): Promise<void> {
  // Two moves, so the pointer always moves even when it is already parked here.
  await page.mouse.move(1200, 200, { steps: 5 });
  await page.mouse.move(1200, 400, { steps: 5 });
}

export async function focusWorkspaceRowWithKeyboard(
  page: Page,
  workspaceId: string,
): Promise<void> {
  const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
  await row.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(row).toBeFocused();
}

export async function expectWorkspaceHoverCardOpen(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-hover-card")).toBeVisible();
}

export async function expectWorkspaceHoverCardStaysOpen(page: Page): Promise<void> {
  // Longer than the hover card's close grace period.
  await page.waitForTimeout(300);
  await expectWorkspaceHoverCardOpen(page);
}

export async function expectWorkspaceHoverCardClosed(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-hover-card")).toHaveCount(0);
}

export async function closeWorkspaceContextMenu(page: Page, workspaceId: string): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  await page.getByTestId(`sidebar-workspace-context-menu-${workspaceKey}-backdrop`).click();
}

export async function expectWorkspaceContextMenuOwnsAttention(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-hover-card")).toHaveCount(0);
}

export async function expectWorkspaceRowHoverCleared(
  page: Page,
  workspaceId: string,
): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  await expect
    .poll(() => isShownToUser(page.getByTestId(`sidebar-workspace-kebab-${workspaceKey}`)))
    .toBe(false);
  await expect(page.getByTestId("workspace-hover-card")).toHaveCount(0);
}

export async function expectWorkspaceContextMenuActions(
  page: Page,
  workspaceId: string,
): Promise<void> {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  const menu = page.getByTestId(`sidebar-workspace-context-menu-${workspaceKey}`);
  await expect(menu.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Rename workspace" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Archive" })).toBeVisible();
}

export async function openProjectContextMenu(page: Page, projectViewKey: string): Promise<void> {
  const menuTestID = `sidebar-project-context-menu-${projectViewKey}`;
  const anchor = await openContextMenuAtRowPoint(
    page,
    `sidebar-project-row-${projectViewKey}`,
    menuTestID,
  );
  await expectContextMenuAtPointer(page, menuTestID, anchor);
}

export async function closeProjectContextMenu(page: Page, projectViewKey: string): Promise<void> {
  await page.getByTestId(`sidebar-project-context-menu-${projectViewKey}-backdrop`).click();
}

export async function expectProjectContextMenuActions(
  page: Page,
  projectViewKey: string,
): Promise<void> {
  const menu = page.getByTestId(`sidebar-project-context-menu-${projectViewKey}`);
  await expect(menu.getByRole("menuitem", { name: "Open project settings" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Remove project" })).toBeVisible();
}

export async function selectWorkspaceInSidebar(page: Page, workspaceId: string): Promise<void> {
  const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
}

/**
 * Opens a workspace row's menu from its kebab, or from its context menu on layouts without one.
 * Pinned rows are addressed in their group.
 */
export async function openWorkspaceSidebarKebab(page: Page, workspaceId: string) {
  const serverId = getServerId();
  const row = workspaceRowInGroup(page, workspaceId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  // Compact and touch rows have no overflow button (2415534c8); their context menu carries the
  // same items, so open that when no kebab appears on hover.
  const kebab = outsidePinnedSection(page, `sidebar-workspace-kebab-${serverId}:${workspaceId}`);
  const shown = await kebab
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (shown) await kebab.click();
  else await row.click({ button: "right" });

  return serverId;
}

export async function expectWorkspaceListed(page: Page, name: string): Promise<void> {
  await expect(
    page.locator('[data-testid^="sidebar-workspace-row-"]').filter({ hasText: name }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

// The workspace row kebab and its menu items carry no web ARIA role, so the sidebar
// suite addresses them by the stable test ids the app assigns per workspace — the same
// convention the rename flow uses. The kebab only reveals on hover.
export async function clickArchiveWorkspaceMenuItem(
  page: Page,
  workspaceId: string,
): Promise<void> {
  const serverId = await openWorkspaceSidebarKebab(page, workspaceId);
  const archiveItem = page.getByTestId(`sidebar-workspace-menu-archive-${serverId}:${workspaceId}`);
  await expect(archiveItem).toBeVisible({ timeout: 10_000 });
  await archiveItem.click();
}

export async function pinWorkspaceFromSidebar(page: Page, workspaceId: string): Promise<void> {
  const serverId = await openWorkspaceSidebarKebab(page, workspaceId);
  const pinItem = page.getByTestId(`sidebar-workspace-menu-pin-${serverId}:${workspaceId}`);
  await expect(pinItem).toBeVisible({ timeout: 10_000 });
  await pinItem.click();
}

export async function archiveWorkspaceFromSidebar(page: Page, workspaceId: string): Promise<void> {
  // A clean workspace archives with no prompt. Managed worktree backing may raise
  // a browser confirm for unsynced work, so accept it when present.
  page.once("dialog", (dialog) => void dialog.accept());
  await clickArchiveWorkspaceMenuItem(page, workspaceId);
}

export async function expectWorkspaceAbsentFromSidebar(
  page: Page,
  workspaceId: string,
): Promise<void> {
  await expect(
    page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`),
  ).toHaveCount(0, { timeout: 30_000 });
}

// The display-preferences menu is one row per decision, and the options sit a page below that
// row. Every caller has to walk the same path, so it lives here: when the menu's shape moves
// again, this is the only place that has to follow.
/**
 * Open the display preferences: the View group in the sidebar's main menu, under Appearance.
 * Choosing an option keeps that menu open, so callers close it when they are done.
 */
export async function openSidebarDisplayPreferences(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-footer-overflow"]:visible').first().click();
  await expect(
    page.locator('[data-testid="sidebar-display-grouping"]:visible').first(),
  ).toBeVisible({ timeout: 10_000 });
}

export async function openSidebarDisplayPage(page: Page, branchTestID: string): Promise<void> {
  await openSidebarDisplayPreferences(page);
  await page.getByTestId(branchTestID).click();
}

// Project filters live a page below the display-preferences root, like the host filters.
export async function openSidebarProjectFilter(page: Page): Promise<void> {
  await openSidebarDisplayPage(page, "sidebar-display-project-filter");
}

// The filter rows are keyed by the project's sidebar view key. A project seeded from its own temp
// repo has a `projectKey` unique on the host, so the view key IS that key — see
// `buildWorkspaceStructureProjects`.
export async function toggleProjectFilter(page: Page, projectViewKey: string): Promise<void> {
  await page.getByTestId(`sidebar-project-filter-${projectViewKey}`).click();
}

export async function selectAllProjectsFilter(page: Page): Promise<void> {
  await page.getByTestId("sidebar-project-filter-all").click();
}

export async function closeSidebarDisplayPreferences(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="sidebar-display-grouping"]:visible')).toHaveCount(0);
}

export async function selectSidebarStatusGrouping(page: Page): Promise<void> {
  await openSidebarDisplayPage(page, "sidebar-display-grouping");
  await page.getByTestId("sidebar-grouping-status").click();
  await closeSidebarDisplayPreferences(page);
}

export async function selectSidebarProjectGrouping(page: Page): Promise<void> {
  await openSidebarDisplayPage(page, "sidebar-display-grouping");
  await page.getByTestId("sidebar-grouping-project").click();
  await closeSidebarDisplayPreferences(page);
}

export async function openMobileAgentSidebar(page: Page): Promise<void> {
  // The sidebar's own collapse toggle shares the "Open menu" name; the header button comes first.
  await page.getByRole("button", { name: "Open menu" }).filter({ visible: true }).first().click();
}

/** The phone sidebar closes from the collapse toggle at the start of its own toolbar. */
export async function closeMobileAgentSidebar(page: Page): Promise<void> {
  const closeButton = page.locator('[data-testid="sidebar-collapse"]:visible').first();
  await expect(closeButton).toBeInViewport({ ratio: 1, timeout: 5_000 });
  await closeButton.click();
}

// The mobile sidebar panel animates via translateX. Waiting for its header to be fully visible
// prevents a close click from targeting a button while the panel is still moving.
export async function expectMobileAgentSidebarVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("sidebar-sessions")).toBeInViewport({ ratio: 1, timeout: 5_000 });
}

export async function expectMobileAgentSidebarHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("sidebar-sessions")).not.toBeInViewport({ timeout: 5_000 });
}

/** Help and support opens from the sidebar's More menu; its own trigger stays hidden. */
/** Drag from the left edge: the only way to open the list while fullscreen hides the header. */
export async function swipeOpenMobileAgentSidebar(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport size is required");
  const y = Math.round(viewport.height / 2);
  await page.mouse.move(8, y);
  await page.mouse.down();
  await page.mouse.move(40, y, { steps: 4 });
  await page.mouse.move(Math.round(viewport.width * 0.7), y, { steps: 12 });
  await page.mouse.up();
}

/** Drag from the right edge to open the compact Explorer over the agent. */
export async function swipeOpenMobileExplorer(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport size is required");
  const y = Math.round(viewport.height / 2);
  await page.mouse.move(viewport.width - 8, y);
  await page.mouse.down();
  await page.mouse.move(viewport.width - 40, y, { steps: 4 });
  await page.mouse.move(Math.round(viewport.width * 0.3), y, { steps: 12 });
  await page.mouse.up();
}

export async function closeMobileExplorer(page: Page): Promise<void> {
  const closeButton = page.getByTestId("explorer-close");
  await expect(closeButton).toBeInViewport({ ratio: 1, timeout: 5_000 });
  await closeButton.click();
}

export async function expectMobileExplorerVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("explorer-content-area")).toBeInViewport({
    ratio: 1,
    timeout: 5_000,
  });
}

export async function expectMobileExplorerHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("explorer-content-area")).not.toBeInViewport({
    timeout: 5_000,
  });
}
