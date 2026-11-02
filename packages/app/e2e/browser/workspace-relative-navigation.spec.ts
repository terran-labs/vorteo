import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import {
  expectSidebarWorkspaceSelected,
  switchWorkspaceViaSidebar,
} from "../support/helpers/workspace-ui";

function workspaceRows(page: Page, projectKey: string) {
  return page
    .getByTestId(`sidebar-workspace-list-${projectEquivalenceViewKey(projectKey)}`)
    .filter({ visible: true })
    .locator(`[data-testid^="sidebar-workspace-row-${getServerId()}:"]`)
    .filter({ visible: true });
}

async function readVisibleWorkspaceOrder(page: Page, projectKey: string, count: number) {
  const rows = workspaceRows(page, projectKey);
  await expect(rows).toHaveCount(count);
  const order = await rows.evaluateAll(
    (elements, prefix) =>
      elements.map((element) => element.getAttribute("data-testid")!.slice(prefix.length)),
    `sidebar-workspace-row-${getServerId()}:`,
  );
  expect(new Set(order).size).toBe(count);
  return order;
}

async function navigateWorkspace(
  page: Page,
  direction: "next" | "previous",
  workspaceId: string,
): Promise<void> {
  await page.keyboard.press(direction === "next" ? "Alt+]" : "Alt+[");
  await expectSidebarWorkspaceSelected({ page, serverId: getServerId(), workspaceId });
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}$`));
}

test("previous and next traverse every visible workspace while digit shortcuts stop at nine", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = await seedWorkspace({
    repoPrefix: "relative-navigation-",
    title: "Workspace 01",
  });
  try {
    for (let index = 2; index <= 12; index += 1) {
      const created = await project.client.createWorkspace({
        source: { kind: "directory", path: project.repoPath },
        title: `Workspace ${String(index).padStart(2, "0")}`,
      });
      expect(created.error).toBeNull();
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await gotoAppShell(page);
    const order = await readVisibleWorkspaceOrder(page, project.projectKey, 12);

    await test.step("next crosses the ninth workspace and previous returns to it", async () => {
      await switchWorkspaceViaSidebar({ page, serverId: getServerId(), workspaceId: order[8] });
      await navigateWorkspace(page, "next", order[9]);
      await navigateWorkspace(page, "previous", order[8]);
    });

    await test.step("wrapping uses the true first and last visible workspace", async () => {
      await switchWorkspaceViaSidebar({ page, serverId: getServerId(), workspaceId: order[0] });
      await navigateWorkspace(page, "previous", order[11]);
      await navigateWorkspace(page, "next", order[0]);
    });

    await test.step("the ninth digit shortcut still selects the ninth workspace", async () => {
      await page.keyboard.press("Alt+9");
      await expectSidebarWorkspaceSelected({
        page,
        serverId: getServerId(),
        workspaceId: order[8],
      });
    });
  } finally {
    await project.cleanup();
  }
});

test("limited project trees retain twenty rows while shortcuts reach the hidden tail", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = await seedWorkspace({ repoPrefix: "limited-navigation-", title: "Workspace 01" });
  try {
    for (let index = 2; index <= 21; index += 1) {
      const created = await project.client.createWorkspace({
        source: { kind: "directory", path: project.repoPath },
        title: `Workspace ${String(index).padStart(2, "0")}`,
      });
      expect(created.error).toBeNull();
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await gotoAppShell(page);
    const initial = await readVisibleWorkspaceOrder(page, project.projectKey, 20);
    const toggle = page
      .getByTestId(`sidebar-project-show-more-${projectEquivalenceViewKey(project.projectKey)}`)
      .filter({ visible: true });
    await expect(toggle).toHaveAccessibleName("Show more");
    await toggle.click();
    const order = await readVisibleWorkspaceOrder(page, project.projectKey, 21);
    expect(order.slice(0, 20)).toEqual(initial);
    await expect(toggle).toHaveAccessibleName("Show less");
    await toggle.click();
    expect(await readVisibleWorkspaceOrder(page, project.projectKey, 20)).toEqual(initial);
    await switchWorkspaceViaSidebar({ page, serverId: getServerId(), workspaceId: order[19] });
    await page.keyboard.press("Alt+]");
    await expect(page).toHaveURL(new RegExp(`/workspace/${order[20]}$`));
    expect(await readVisibleWorkspaceOrder(page, project.projectKey, 20)).toEqual(initial);
    await expect(
      page
        .getByTestId(`sidebar-workspace-row-${getServerId()}:${order[20]}`)
        .filter({ visible: true }),
    ).toHaveCount(0);
    await expect(toggle).toHaveAccessibleName("Show more");
    await navigateWorkspace(page, "previous", order[19]);
    await switchWorkspaceViaSidebar({ page, serverId: getServerId(), workspaceId: order[0] });
    await page.keyboard.press("Alt+[");
    await expect(page).toHaveURL(new RegExp(`/workspace/${order[20]}$`));
    expect(await readVisibleWorkspaceOrder(page, project.projectKey, 20)).toEqual(initial);
    await toggle.click();
    await expectSidebarWorkspaceSelected({ page, serverId: getServerId(), workspaceId: order[20] });
    await navigateWorkspace(page, "next", order[0]);
    await page.keyboard.press("Alt+9");
    await expectSidebarWorkspaceSelected({ page, serverId: getServerId(), workspaceId: order[8] });
    await expect(page).toHaveURL(new RegExp(`/workspace/${order[8]}$`));
  } finally {
    await project.cleanup();
  }
});
