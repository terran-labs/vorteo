import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";

/** The daemon's Factory service reads this file on every call. */
function factoryStateFile(): string {
  return path.join(process.env.E2E_PASEO_HOME!, "factory", "projects.json");
}

/** Seeds one paused Factory, so its overview and settings show without starting any work. */
async function seedPausedFactory(projectId: string): Promise<void> {
  await mkdir(path.dirname(factoryStateFile()), { recursive: true });
  await writeFile(
    factoryStateFile(),
    JSON.stringify({
      schemaVersion: 1,
      projects: {
        [projectId]: {
          repository: "acme/factory-settings",
          enabled: true,
          paused: true,
          workers: {
            plannerProfileId: null,
            planning: true,
            workerProfileId: null,
            reviewerProfileId: null,
          },
          roles: {},
        },
      },
    }),
  );
}

async function savedPlannerProfile(projectId: string): Promise<unknown> {
  const state = JSON.parse(await readFile(factoryStateFile(), "utf8")) as {
    projects: Record<string, { workers: { plannerProfileId?: unknown } }>;
  };
  return state.projects[projectId]?.workers.plannerProfileId ?? null;
}

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
      // A Factory that is off has no settings to open.
      await expect(page.getByTestId("factory-settings-open")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`factory-overview-${width}.png`),
        fullPage: true,
      });
    }

    // The Sample Factory is a scope of its own; its controls change nothing.
    await page.getByTestId("factory-scope-selector").filter({ visible: true }).first().click();
    await page.getByTestId("factory-scope-sample").click();
    await expect(page).toHaveURL(new RegExp(`/h/${getServerId()}/factory/sample$`));
    const sample = page.getByTestId("factory-overview").filter({ visible: true }).last();
    await expect(sample.getByTestId("factory-sample-notice")).toBeVisible();
    await expect(sample.getByRole("switch")).toBeDisabled();
    await expect(page.getByTestId("factory-settings-open")).toHaveCount(0);

    // All Factories never shows sample data.
    await page.goto(`/h/${getServerId()}/factory`);
    await expect(page.getByTestId("factory-overview")).toBeVisible();
    await expect(page.getByTestId("factory-sample-notice")).toHaveCount(0);
  } finally {
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await workspace.cleanup();
  }
});

// The owner's check from #360: change a stage model in the Factory's settings and change it back.
test("a Factory's settings change a stage model and change it back", async ({ page }) => {
  const { seedWorkspace } = await import("../support/helpers/seed-client");
  const workspace = await seedWorkspace({ repoPrefix: "factory-settings-" });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  await seedPausedFactory(workspace.projectId);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await page.goto(`/h/${getServerId()}/factory/${workspace.projectId}`);
    await page.getByTestId("factory-settings-open").filter({ visible: true }).first().click();
    await expect(page).toHaveURL(
      new RegExp(`/h/${getServerId()}/factory/${workspace.projectId}/settings$`),
    );
    const stages = page.getByTestId("factory-issue-stages").filter({ visible: true }).first();
    const plan = stages.getByTestId("preset-controls").first();

    await plan.getByTestId("agent-preset-selector").click();
    await page
      .locator('[data-testid^="preset-row-"]')
      .filter({ hasText: "E2E mock" })
      .first()
      .click();
    await page.getByTestId("preset-use-profile").click();
    await expect.poll(() => savedPlannerProfile(workspace.projectId)).not.toBeNull();
    await expect(stages.getByText("E2E mock").first()).toBeVisible();

    await stages.getByRole("button", { name: "Default", exact: true }).first().click();
    await expect.poll(() => savedPlannerProfile(workspace.projectId)).toBeNull();
    await expect(page.getByText("factory_owner_only")).toHaveCount(0);
  } finally {
    await rm(factoryStateFile(), { force: true });
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await workspace.cleanup();
  }
});
