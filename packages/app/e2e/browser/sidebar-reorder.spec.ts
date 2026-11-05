import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { type Locator, type WebSocketRoute, type Page } from "@playwright/test";

import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  sidebarProjectForWorkspace,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";
import {
  openSidebarDisplayPreferences,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";

async function rowTestIds(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

async function visibleBoundingBox(row: Locator) {
  const box = await row.boundingBox();
  if (!box) throw new Error("Expected a visible draggable row");
  return box;
}

async function pressProjectRow(rows: Locator) {
  await rows.page().mouse.down();
}

async function pressWorkspaceRow(rows: Locator) {
  await rows.page().mouse.down();
}

async function quickDragFirstRowAfterSecond(
  rows: Locator,
  pressRow: (rows: Locator) => Promise<void>,
) {
  await expect(rows).toHaveCount(2);
  const before = await rowTestIds(rows);
  const sourceBox = await visibleBoundingBox(rows.nth(0));
  const targetBox = await visibleBoundingBox(rows.nth(1));

  const page = rows.page();
  // Start on the row inset, away from branch popovers and trailing actions.
  const source = { x: sourceBox.x + 12, y: sourceBox.y + sourceBox.height / 2 };
  // The new position resolver splits rows into before/after zones. Land inside
  // the lower zone rather than exactly on its fractional-pixel midpoint.
  const target = { x: targetBox.x + 12, y: targetBox.y + targetBox.height * 0.85 };

  await page.mouse.move(source.x, source.y);
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await finishSidebarDrag(page);

  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
}

async function finishSidebarDrag(page: Page): Promise<void> {
  await page.mouse.up();
  // dnd-kit's pointer sensor keeps its document click blocker for 50 ms after drop.
  // Row order updates before that blocker is removed; wait before the next user action.
  await page.waitForTimeout(60);
}

async function dragWithoutReordering(rows: Locator): Promise<void> {
  const before = await rowTestIds(rows);
  const source = await visibleBoundingBox(rows.nth(0));
  const target = await visibleBoundingBox(rows.nth(1));
  const page = rows.page();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  await finishSidebarDrag(page);
  await expect.poll(() => rowTestIds(rows)).toEqual(before);
}

test("keyboard reorders projects and workspaces, cancels and survives reload", async ({ page }) => {
  test.setTimeout(120_000);
  const first = await seedWorkspace({ repoPrefix: "keyboard-first-" });
  const second = await seedWorkspace({ repoPrefix: "keyboard-second-" });
  try {
    const extra = await first.client.createWorkspace({
      source: { kind: "directory", path: first.repoPath, projectId: first.projectId },
      title: "Keyboard second workspace",
    });
    if (!extra.workspace) throw new Error(extra.error ?? "Missing workspace");
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectWorkspaceSort(page, "Manual");
    const projects = page.locator(
      `[data-testid="sidebar-project-row-${projectEquivalenceViewKey(first.projectKey)}"], ` +
        `[data-testid="sidebar-project-row-${projectEquivalenceViewKey(second.projectKey)}"]`,
    );
    const originalProjects = await rowTestIds(projects);
    const projectHandle = page
      .getByTestId(originalProjects[0]!)
      .locator("xpath=ancestor::*[@aria-roledescription='draggable'][1]");
    await projectHandle.focus();
    await page.keyboard.press("Space");
    await expect(projectHandle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("draggable-tree-line")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => rowTestIds(projects)).toEqual(originalProjects.toReversed());
    await expect(projectHandle).toBeFocused();

    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("draggable-tree-line")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("draggable-tree-line")).toHaveCount(0);
    await expect.poll(() => rowTestIds(projects)).toEqual(originalProjects.toReversed());
    await expect(projectHandle).toBeFocused();

    const workspaces = page.locator(
      `[data-testid="sidebar-workspace-row-${getServerId()}:${first.workspaceId}"], ` +
        `[data-testid="sidebar-workspace-row-${getServerId()}:${extra.workspace.id}"]`,
    );
    const originalWorkspaces = await rowTestIds(workspaces);
    await expect(workspaces).toHaveCount(2);
    const workspaceHandle = page
      .getByTestId(originalWorkspaces[0]!)
      .locator("xpath=ancestor::*[@aria-roledescription='draggable'][1]");
    await workspaceHandle.focus();
    await page.keyboard.press("Space");
    // Like the project drag above, wait for the pickup before moving.
    await expect(workspaceHandle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("draggable-tree-line")).toBeVisible();
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("draggable-tree-line")).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("draggable-tree-line")).toBeVisible();
    await page.keyboard.press("Space");
    await expect.poll(() => rowTestIds(workspaces)).toEqual(originalWorkspaces.toReversed());
    await expect(workspaceHandle).toBeFocused();
    await page.reload();
    await waitForSidebarHydration(page);
    await expect.poll(() => rowTestIds(projects)).toEqual(originalProjects.toReversed());
    await expect.poll(() => rowTestIds(workspaces)).toEqual(originalWorkspaces.toReversed());
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("projects, workspaces, pinned chats and expansion synchronize between devices", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const firstProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-first-" });
  const secondProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-second-" });
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  let offline = false;
  let peerSocket: WebSocketRoute | undefined;
  let serverSocket: WebSocketRoute | undefined;
  await peer.routeWebSocket(
    (url) => url.port === String(getE2EDaemonPort()),
    async (socket) => {
      if (offline) {
        await socket.close({ code: 1013, reason: "Test connection outage" });
        return;
      }
      peerSocket = socket;
      serverSocket = socket.connectToServer();
    },
  );

  try {
    const secondWorkspace = await firstProject.client.createWorkspace({
      source: {
        kind: "directory",
        path: firstProject.repoPath,
        projectId: firstProject.projectId,
      },
      title: "Second workspace",
    });
    if (!secondWorkspace.workspace) {
      throw new Error(secondWorkspace.error ?? "Failed to seed a second workspace");
    }

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectWorkspaceSort(page, "Created");
    await expect
      .poll(async () => (await firstProject.client.readSidebarState()).snapshot.state !== null)
      .toBe(true);
    const storage = await page.context().storageState();
    await peerContext.addInitScript((origins) => {
      for (const origin of origins) {
        if (origin.origin !== window.location.origin) continue;
        for (const entry of origin.localStorage) {
          if (entry.name !== "@paseo:client-id-v1") localStorage.setItem(entry.name, entry.value);
        }
      }
    }, storage.origins);
    await peer.goto(page.url());
    await waitForSidebarHydration(peer);

    const firstProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(firstProject.projectKey)}`;
    const secondProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(secondProject.projectKey)}`;
    await quickDragFirstRowAfterSecond(
      page.locator(`[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`),
      pressProjectRow,
    );
    await expect
      .poll(() =>
        rowTestIds(
          peer.locator(
            `[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`,
          ),
        ),
      )
      .toEqual(
        await rowTestIds(
          page.locator(
            `[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`,
          ),
        ),
      );
    const firstWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${firstProject.workspaceId}`;
    const secondWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondWorkspace.workspace.id}`;
    const ordinaryRows = page.locator(
      `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
    );
    await expect
      .poll(() => rowTestIds(ordinaryRows))
      .toEqual([secondWorkspaceTestId, firstWorkspaceTestId]);
    await dragWithoutReordering(ordinaryRows);

    await expect
      .poll(() =>
        rowTestIds(
          peer.locator(
            `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
          ),
        ),
      )
      .toEqual(
        await rowTestIds(
          page.locator(
            `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
          ),
        ),
      );
    await peer.getByTestId(firstProjectTestId).click();
    await expect(page.getByTestId(firstWorkspaceTestId)).toHaveCount(0);
    await peer.reload();
    await waitForSidebarHydration(peer);
    await expect(peer.getByTestId(firstWorkspaceTestId)).toHaveCount(0);
    await page.getByTestId(firstProjectTestId).click();
    await expect(peer.getByTestId(firstWorkspaceTestId)).toBeVisible();

    // Browser offline emulation does not close an established WebSocket.
    offline = true;
    await Promise.all([peerSocket?.close(), serverSocket?.close()]);
    await peer.getByTestId(firstProjectTestId).click();
    await expect(peer.getByTestId("sidebar-sync-error")).toBeVisible({ timeout: 20000 });
    offline = false;
    await expect(page.getByTestId(firstWorkspaceTestId)).toHaveCount(0);
    await expect(peer.getByTestId("sidebar-sync-error")).toHaveCount(0);
    await page.getByTestId(firstProjectTestId).click();
    await expect(peer.getByTestId(firstWorkspaceTestId)).toBeVisible();

    await firstProject.client.setWorkspacePinned(firstProject.workspaceId, true);
    await secondProject.client.setWorkspacePinned(secondProject.workspaceId, true);
    const secondProjectWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondProject.workspaceId}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );
    await expect
      .poll(() =>
        rowTestIds(
          peer.locator(
            `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
          ),
        ),
      )
      .toEqual(
        await rowTestIds(
          page.locator(
            `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
          ),
        ),
      );
    await peer.screenshot({ path: "test-results/sidebar-state-synced.png" });
    await peer.mouse.move(900, 500);
    await peer.setViewportSize({ width: 390, height: 844 });
    await peer.getByRole("button", { name: "Open menu", exact: true }).click();
    await waitForSidebarHydration(peer);
    await expect(peer.getByTestId(secondWorkspaceTestId)).toBeVisible();
    await page.getByTestId(firstProjectTestId).click();
    await expect(peer.getByTestId(secondWorkspaceTestId)).toHaveCount(0);
    await peer.getByTestId(firstProjectTestId).click({ position: { x: 12, y: 16 } });
    await expect(peer.getByTestId(secondWorkspaceTestId)).toBeVisible();
    await expect(page.getByTestId(secondWorkspaceTestId)).toBeVisible();
    await peer.screenshot({ path: "test-results/sidebar-state-compact.png" });
  } catch (error) {
    await peer.screenshot({ path: "test-results/sidebar-state-peer-failure.png" });
    console.log("Sidebar state at failure", await firstProject.client.readSidebarState());
    throw error;
  } finally {
    offline = false;
    await Promise.all([firstProject.cleanup(), secondProject.cleanup()]);
    await peerContext.close();
  }
});

test("cancelling a workspace move preserves its project and chats", async ({ page }) => {
  const source = await seedWorkspace({ repoPrefix: "recreation-source-" });
  const destination = await seedWorkspace({ repoPrefix: "recreation-destination-" });
  try {
    await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "First chat",
    });
    await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "Other chat",
    });
    await source.client.setWorkspacePinned(source.workspaceId, true);
    await destination.client.archiveWorkspace(destination.workspaceId);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${source.workspaceId}`);
    const target = page.getByTestId(
      `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`,
    );
    await dragWorkspaceToProject(row, target);
    const modal = page.getByTestId("project-move-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Move to project");
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(row).toBeVisible();
  } finally {
    await source.cleanup();
    await destination.cleanup();
  }
});

async function dragWorkspaceToProject(row: Locator, target: Locator) {
  const page = row.page();
  const from = await visibleBoundingBox(row);
  const to = await visibleBoundingBox(target);
  await page.mouse.move(from.x + 90, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 90, from.y + from.height / 2 + 8);
  await page.mouse.move(to.x + 90, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("the workspace menu moves every chat together and preserves membership after reload", async ({
  page,
}) => {
  const source = await seedWorkspace({ repoPrefix: "move-source-" });
  const destination = await seedWorkspace({ repoPrefix: "move-destination-" });
  const inspector = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "project-move" });
  try {
    const first = await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "First retained chat",
    });
    const second = await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "Second retained chat",
    });
    const project = (await inspector.listProjects()).projects.find(
      (entry) => entry.projectId === destination.projectId,
    )!;
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const workspaceKey = `${getServerId()}:${source.workspaceId}`;
    const row = page.getByTestId(`sidebar-workspace-row-${workspaceKey}`);
    await row.hover();
    await page.getByTestId(`sidebar-workspace-kebab-${workspaceKey}`).click();
    await page.getByTestId(`sidebar-workspace-menu-move-project-${workspaceKey}`).click();
    await page.getByTestId("project-move-project").click();
    await page.getByText(project.projectDisplayName, { exact: true }).last().click();
    await page.getByTestId("project-move-confirm").click();
    await expect(page.getByTestId("project-move-modal")).toHaveCount(0);
    const destinationRowId = `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`;
    await expect.poll(() => sidebarProjectForWorkspace(row)).toBe(destinationRowId);
    const workspace = (await inspector.fetchWorkspaces()).entries.find(
      (entry) => entry.id === source.workspaceId,
    )!;
    expect(workspace).toMatchObject({
      projectId: source.projectId,
      workspaceDirectory: source.repoPath,
      projectMembership: {
        key: projectEquivalenceViewKey(destination.projectKey),
        name: project.projectDisplayName,
      },
    });
    const chats = (await source.client.fetchAgents()).entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.workspaceId === source.workspaceId);
    expect(chats.map((agent) => agent.id).sort()).toEqual([first.id, second.id].sort());
    expect(chats.map((agent) => agent.cwd)).toEqual([source.repoPath, source.repoPath]);
    await page.reload();
    await waitForSidebarHydration(page);
    await expect(row).toBeVisible();
    await expect.poll(() => sidebarProjectForWorkspace(row)).toBe(destinationRowId);
    expect(
      (await inspector.fetchWorkspaces()).entries.find((entry) => entry.id === source.workspaceId)
        ?.projectMembership,
    ).toEqual(workspace.projectMembership);
    await page.screenshot({ path: test.info().outputPath("moved-workspace.png") });
  } finally {
    await inspector.close();
    await source.client.archiveWorkspace(source.workspaceId).catch(() => undefined);
    await source.cleanup();
    await destination.cleanup();
  }
});

test("a failed move stays open with a visible error", async ({ page }) => {
  const source = await seedWorkspace({ repoPrefix: "move-failure-source-" });
  const destination = await seedWorkspace({ repoPrefix: "move-failure-destination-" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${source.workspaceId}`);
    const target = page.getByTestId(
      `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`,
    );
    await dragWorkspaceToProject(row, target);
    await expect(page.getByTestId("project-move-modal")).toBeVisible();
    await source.client.archiveWorkspace(source.workspaceId);
    await page.getByTestId("project-move-confirm").click();
    // A refused move shows as a toast since 68faa7a52; the modal stays open for a retry.
    await expect(page.getByText("Restore this workspace before moving it.").first()).toBeVisible();
    await expect(page.getByTestId("project-move-modal")).toBeVisible();
    await page
      .getByTestId("project-move-modal")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(page.getByTestId("project-move-modal")).toHaveCount(0);
  } finally {
    await source.cleanup();
    await destination.cleanup();
  }
});

test("protected workspace drop explains the block", async ({ page }) => {
  const source = await seedWorkspace({ repoPrefix: "protected-drop-source-" });
  const destination = await seedWorkspace({ repoPrefix: "protected-drop-destination-" });
  try {
    await source.client.setWorkspaceLifecycle({
      workspaceId: source.workspaceId,
      protected: true,
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${source.workspaceId}`);
    const target = page.getByTestId(
      `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`,
    );
    const from = await visibleBoundingBox(row);
    const to = await visibleBoundingBox(target);
    await page.mouse.move(from.x + 90, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 90, from.y + from.height / 2 + 8);
    await page.mouse.move(to.x + 90, to.y + to.height / 2, { steps: 12 });
    await expect(page.getByTestId("project-drop-blocked")).toBeVisible();
    await expect(
      page.getByText(
        "This workspace is protected. Turn off protection in Workspace actions before moving it.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("protected-drop.png") });
    await page.mouse.up();
    await expect(page.getByTestId("project-move-modal")).toHaveCount(0);
    expect(
      (await source.client.fetchWorkspaces()).entries.find(
        (entry) => entry.id === source.workspaceId,
      )?.projectMembership,
    ).toBeFalsy();
    await source.client.setWorkspaceLifecycle({
      workspaceId: source.workspaceId,
      protected: false,
    });
    await dragWorkspaceToProject(row, target);
    await expect(page.getByTestId("project-move-modal")).toBeVisible();
  } finally {
    await page.mouse.up();
    await source.client
      .setWorkspaceLifecycle({ workspaceId: source.workspaceId, protected: false })
      .catch(() => undefined);
    await source.cleanup();
    await destination.cleanup();
  }
});

async function selectWorkspaceSort(page: Page, name: "Manual" | "Created" | "Last prompt") {
  await openSidebarDisplayPreferences(page);
  await page.getByRole("menuitem", { name: /^Sort/ }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

async function reconnectSidebar(page: Page): Promise<void> {
  await page.reload();
  await waitForSidebarHydration(page);
}

async function expectNoWorkspaceSortChoice(page: Page): Promise<void> {
  await openSidebarDisplayPreferences(page);
  await expect(page.getByRole("menuitem", { name: /^Sort/ })).toHaveCount(0);
}

async function promptWorkspace(seed: Awaited<ReturnType<typeof seedWorkspace>>, agentId: string) {
  await seed.client.sendAgentMessage(agentId, "sidebar ordering check");
  expect((await seed.client.waitForFinish(agentId, 30_000)).status).toBe("idle");
}

test("Created stays stable, Last prompt follows human submissions and survives tab archive", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seed = await seedWorkspace({ repoPrefix: "sidebar-sort-" });
  try {
    const newer = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "Newer workspace",
    });
    if (!newer.workspace) throw new Error(newer.error ?? "Workspace creation failed");
    const agent = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: seed.workspaceId,
      modeId: "load-test",
      model: "e2e-fast-stream",
      title: "Ordering agent",
    });
    const newerAgent = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: newer.workspace.id,
      modeId: "load-test",
      model: "e2e-fast-stream",
      title: "Newer agent",
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const oldId = `sidebar-workspace-row-${getServerId()}:${seed.workspaceId}`;
    const newId = `sidebar-workspace-row-${getServerId()}:${newer.workspace.id}`;
    const rows = page.locator(`[data-testid="${oldId}"], [data-testid="${newId}"]`);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await promptWorkspace(seed, agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await selectWorkspaceSort(page, "Last prompt");
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await promptWorkspace(seed, newerAgent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await promptWorkspace(seed, agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await seed.client.archiveAgent(agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await reconnectSidebar(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await selectWorkspaceSort(page, "Created");
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await selectSidebarStatusGrouping(page);
    await expectNoWorkspaceSortChoice(page);
  } finally {
    await seed.cleanup();
  }
});

async function seedCompactProject() {
  const seed = await seedWorkspace({
    repoPrefix: "sidebar-visibility-",
    title: "Oldest workspace",
  });
  const ids = [seed.workspaceId];
  for (let index = 2; index <= 12; index += 1) {
    const created = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: `Workspace ${index}`,
    });
    if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
    ids.unshift(created.workspace.id);
  }
  const agent = await seed.client.createAgent({
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
    cwd: seed.repoPath,
    workspaceId: seed.workspaceId,
    title: "Overflow agent",
  });
  return { seed, ids, agent };
}

async function expectWorkspaceOrder(rows: Locator, ids: string[]) {
  await expect
    .poll(() => rowTestIds(rows))
    .toEqual(ids.map((id) => `sidebar-workspace-row-${getServerId()}:${id}`));
}

async function revealWorkspaces(list: Locator, action: "Show more" | "Show less") {
  await list.getByLabel(action, { exact: true }).click();
}

async function selectProjectGrouping(page: Page) {
  await openSidebarDisplayPreferences(page);
  await page.getByRole("menuitem", { name: /^Group/ }).click();
  await page.getByTestId("sidebar-grouping-project").click();
}

type CompactProject = Awaited<ReturnType<typeof seedCompactProject>>;

function compactProjectRows(page: Page, seed: CompactProject["seed"]) {
  const list = page.getByTestId(`sidebar-workspace-list-${seed.projectKey}`);
  return {
    rows: list.locator('[data-testid^="sidebar-workspace-row-"]'),
    group: list.locator(".."),
    project: page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(seed.projectKey)}`),
  };
}

async function expectActiveOverflowTransitions(page: Page, { seed, ids, agent }: CompactProject) {
  const { rows } = compactProjectRows(page, seed);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));

  await seed.client.sendAgentMessage(agent.id, "show active overflow");
  await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[11]]);
  await seed.client.waitForFinish(agent.id, 15_000);
  await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[11]]);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

async function expectRevealSurvivesSortingAndCollapse(
  page: Page,
  { seed, ids, agent }: CompactProject,
) {
  const { rows, group, project } = compactProjectRows(page, seed);
  const retainedRows = await rows.elementHandles();
  await revealWorkspaces(group, "Show more");
  await expectWorkspaceOrder(rows, ids);
  for (const [index, retained] of retainedRows.entries()) {
    expect(
      await rows.nth(index).evaluate((current, previous) => current === previous, retained),
    ).toBe(true);
  }
  await project.click();
  await expect(rows).toHaveCount(0);
  await project.click();
  await expectWorkspaceOrder(rows, ids);
  await seed.client.sendAgentMessage(agent.id, "expanded overflow");
  await seed.client.waitForFinish(agent.id, 15_000);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expectWorkspaceOrder(rows, ids);
  await selectWorkspaceSort(page, "Last prompt");
  await expectWorkspaceOrder(rows, [ids[11], ...ids.slice(0, 11)]);
  const revealedRow = await rows.nth(8).elementHandle();
  await revealWorkspaces(group, "Show less");
  await expectWorkspaceOrder(rows, [ids[11], ...ids.slice(0, 6)]);
  await selectWorkspaceSort(page, "Created");
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
  expect(await revealedRow!.evaluate((row) => row.isConnected)).toBe(false);
  await reconnectSidebar(page);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

async function expectStatusBucketsRetainActiveOverflow(
  page: Page,
  { seed, ids, agent }: CompactProject,
) {
  const { rows } = compactProjectRows(page, seed);
  await selectSidebarStatusGrouping(page);
  const done = page.getByTestId("sidebar-status-group-rows-done");
  const doneRows = done.locator('[data-testid^="sidebar-workspace-row-"]');
  await expect(doneRows).toHaveCount(7);
  await revealWorkspaces(done, "Show more");
  await expect(doneRows).toHaveCount(12);
  await seed.client.sendAgentMessage(agent.id, "status overflow");
  await seed.client.waitForFinish(agent.id, 15_000);
  await expect(
    page
      .getByTestId("sidebar-status-group-rows-attention")
      .getByText("Oldest workspace", { exact: true }),
  ).toBeVisible();
  await expect(doneRows).toHaveCount(11);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expect(doneRows).toHaveCount(12);
  await revealWorkspaces(done, "Show less");
  await expect(doneRows).toHaveCount(7);
  const activeAgents: Array<{ id: string }> = [];
  for (const workspaceId of ids.slice(0, 8)) {
    activeAgents.push(
      await seed.client.createAgent({
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "load-test",
        cwd: seed.repoPath,
        workspaceId,
        title: "Active overflow agent",
      }),
    );
  }
  await Promise.all(
    activeAgents.map((item) => seed.client.sendAgentMessage(item.id, "active bucket")),
  );
  await Promise.all(activeAgents.map((item) => seed.client.waitForFinish(item.id, 15_000)));
  const attention = page.getByTestId("sidebar-status-group-rows-attention");
  await expect(attention.locator('[data-testid^="sidebar-workspace-row-"]')).toHaveCount(8);
  await expect(attention.getByLabel("Show more", { exact: true })).toHaveCount(0);
  for (const workspaceId of ids.slice(0, 8)) await seed.client.clearWorkspaceAttention(workspaceId);
  await expect(doneRows).toHaveCount(7);
  await selectProjectGrouping(page);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

test("compact groups retain active overflow and reveal the current ordered rows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await seedCompactProject();
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await test.step("Active overflow appears without intervening Done rows", () =>
      expectActiveOverflowTransitions(page, fixture));
    await test.step("Reveal follows current sort and survives collapse", () =>
      expectRevealSurvivesSortingAndCollapse(page, fixture));
    await test.step("Status reveals Done rows and keeps every active row", () =>
      expectStatusBucketsRetainActiveOverflow(page, fixture));
  } finally {
    await fixture.seed.cleanup();
  }
});

async function restorePreBetaOrder(page: Page, projectKey: string, workspaceKeys: string[]) {
  await page.evaluate(
    ({ projectKey: scope, workspaceKeys: order }) => {
      localStorage.setItem(
        "sidebar-project-workspace-order",
        JSON.stringify({
          version: 1,
          state: {
            projectOrder: [scope],
            pinnedWorkspaceOrder: [],
            workspaceOrderByProject: { [scope]: order },
          },
        }),
      );
    },
    { projectKey, workspaceKeys },
  );
  await reconnectSidebar(page);
}

test("Manual restores pre-beta order and keeps drag order across sorting and reloads", async ({
  page,
}) => {
  const seed = await seedWorkspace({ repoPrefix: "sidebar-manual-" });
  try {
    const second = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "New manual workspace",
    });
    if (!second.workspace) throw new Error(second.error ?? "Workspace creation failed");
    const keys = [seed.workspaceId, second.workspace.id].map((id) => `${getServerId()}:${id}`);
    const ids = keys.map((key) => `sidebar-workspace-row-${key}`);
    const rows = page.locator(ids.map((id) => `[data-testid="${id}"]`).join(", "));
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await restorePreBetaOrder(page, projectEquivalenceViewKey(seed.projectKey), keys);
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await selectWorkspaceSort(page, "Created");
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await selectWorkspaceSort(page, "Last prompt");
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await reconnectSidebar(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await selectWorkspaceSort(page, "Created");
    await reconnectSidebar(page);
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
  } finally {
    await seed.cleanup();
  }
});

function workspaceRows(page: Page, ids: string[]) {
  return page.locator(
    ids.map((id) => `[data-testid="sidebar-workspace-row-${getServerId()}:${id}"]`).join(", "),
  );
}

async function openWorkspaceRow(page: Page, workspaceId: string) {
  await page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}`));
}

test("collapsed groups lead with the open workspace instead of hiding it behind Show more", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { seed, ids } = await seedCompactProject();
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectWorkspaceSort(page, "Created");
    const { rows, group } = compactProjectRows(page, seed);
    await expectWorkspaceOrder(rows, ids.slice(0, 7));
    await revealWorkspaces(group, "Show more");
    await openWorkspaceRow(page, ids[9]!);
    await expectWorkspaceOrder(rows, ids);
    await revealWorkspaces(group, "Show less");
    await expectWorkspaceOrder(rows, [ids[9]!, ...ids.slice(0, 7)]);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${ids[9]!}`),
    ).toHaveAttribute("aria-selected", "true");
    await reconnectSidebar(page);
    await expectWorkspaceOrder(rows, [ids[9]!, ...ids.slice(0, 7)]);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${ids[9]!}`),
    ).toHaveAttribute("aria-selected", "true");
    await openWorkspaceRow(page, ids[2]!);
    await expectWorkspaceOrder(rows, ids.slice(0, 7));
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${ids[2]!}`),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    await seed.cleanup();
  }
});

test("a Manual drag in a collapsed group keeps the open workspace's saved place", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { seed, ids } = await seedCompactProject();
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const projectKey = projectEquivalenceViewKey(seed.projectKey);
    await restorePreBetaOrder(
      page,
      projectKey,
      ids.map((id) => `${getServerId()}:${id}`),
    );
    await selectWorkspaceSort(page, "Manual");
    const rows = workspaceRows(page, ids);
    const toggle = page.getByTestId(`sidebar-project-show-more-${projectKey}`);
    await expectWorkspaceOrder(rows, ids.slice(0, 7));
    await toggle.click();
    await openWorkspaceRow(page, ids[9]!);
    await toggle.click();
    await expectWorkspaceOrder(rows, [ids[9]!, ...ids.slice(0, 7)]);
    await quickDragFirstRowAfterSecond(workspaceRows(page, [ids[0]!, ids[1]!]), pressWorkspaceRow);
    await expectWorkspaceOrder(rows, [ids[9]!, ids[1]!, ids[0]!, ...ids.slice(2, 7)]);
    await reconnectSidebar(page);
    await expectWorkspaceOrder(rows, [ids[9]!, ids[1]!, ids[0]!, ...ids.slice(2, 7)]);
    await toggle.click();
    await expectWorkspaceOrder(rows, [ids[1]!, ids[0]!, ...ids.slice(2)]);
  } finally {
    await seed.cleanup();
  }
});
