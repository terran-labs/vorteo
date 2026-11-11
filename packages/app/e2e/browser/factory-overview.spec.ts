import { expect, test } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";

test("per-project Factory Overview opens on desktop and compact", async ({ page }, testInfo) => {
  const { seedWorkspace } = await import("../support/helpers/seed-client");
  const workspace = await seedWorkspace({ repoPrefix: "factory-overview-" });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/h/${getServerId()}/factory/${workspace.projectId}`);
      const overview = page.getByTestId("factory-overview");
      await expect(overview).toBeVisible();
      await expect(overview.getByTestId("factory-overview-off")).toBeVisible();
      await expect(overview.getByTestId("preset-controls")).toHaveCount(0);
      await expect(overview.getByRole("switch")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`factory-overview-${width}.png`),
        fullPage: true,
      });
    }
  } finally {
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await workspace.cleanup();
  }
});
