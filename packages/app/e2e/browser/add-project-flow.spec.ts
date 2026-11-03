import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import {
  addProjectFlow,
  chooseAddHostFromProjectFlow,
  addProjectFlowBack,
  addProjectFlowHost,
  addProjectFlowInput,
  addProjectFlowLocation,
  addProjectFlowMethod,
  browseAddProjectFolderPath,
  chooseAddProjectMethod,
  expectAddProjectPage,
  expectNewWorkspaceForAddedProject,
  expectAddProjectResultVisible,
  navigateAddProjectResults,
  navigateAndDismissAddProject,
  watchAddProjectRenderWarnings,
  openAddProjectFlow,
  openAddProjectHostSelection,
} from "../support/helpers/add-project-flow";
import { gotoAppShell } from "../support/helpers/app";
import {
  disconnectAllHostsAndReload,
  addConnectedHostAndReload,
  addConnectedHostsAndReload,
  addOfflineHostAndReload,
  waitForConnectedHost,
} from "../support/helpers/hosts";
import {
  type IsolatedHostDaemon,
  startIsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { expectNewWorkspaceHost } from "../support/helpers/new-workspace";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

const SECONDARY_HOST_ID = "add-project-flow-secondary";
const SECONDARY_HOST_LABEL = "Secondary Host";
const PROJECTS_HOST_ID = "add-project-flow-projects";
const PROJECTS_HOST_LABEL = "Projects Host";

async function expectProjectDirectory(pathname: string): Promise<void> {
  await expect.poll(async () => (await stat(pathname)).isDirectory()).toBe(true);
}

async function removeCreatedProject(
  pathname: string,
  knownProjectId: string | null,
): Promise<void> {
  const client = await connectSeedClient();
  try {
    let projectId = knownProjectId;
    if (!projectId) {
      const result = await client.addProject(pathname);
      projectId = result.project?.projectId ?? null;
    }
    if (projectId) await client.removeProject(projectId).catch(() => undefined);
  } finally {
    await client.close();
  }
}

async function expectProjectHasNoWorkspaces(projectId: string): Promise<void> {
  const client = await connectSeedClient();
  try {
    const result = await client.fetchWorkspaces({ filter: { projectId } });
    expect(result.entries).toEqual([]);
  } finally {
    await client.close();
  }
}

test.describe("Add Project command-center flow", () => {
  test.describe.configure({ timeout: 180_000 });

  test("Add host replaces the project dialog when no hosts are connected", async ({ page }) => {
    await gotoAppShell(page);
    await disconnectAllHostsAndReload(page);
    await openAddProjectHostSelection(page);
    const originalUrl = page.url();
    await chooseAddHostFromProjectFlow(page);
    await expect(addProjectFlow(page)).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Direct connection", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(originalUrl);
  });

  test("method selection shows the daemon's available project sources without search", async ({
    page,
  }) => {
    await gotoAppShell(page);

    await openAddProjectFlow(page);

    await expect(addProjectFlowMethod(page, "open-folder")).toContainText("Open a folder");
    await expect(addProjectFlowMethod(page, "directory-search")).toHaveCount(0);
    await expect(addProjectFlowMethod(page, "github")).toContainText("Clone from GitHub");
    await expect(addProjectFlowMethod(page, "new-directory")).toContainText("New project folder");
    await expect(addProjectFlowInput(page)).toHaveCount(0);
    await expect(addProjectFlow(page).getByRole("textbox")).toHaveCount(0);
    await expect(page.getByTestId("add-project-flow-page-host")).toHaveCount(0);
  });

  test("an offline extra host neither appears nor forces host selection", async ({ page }) => {
    await gotoAppShell(page);
    await addOfflineHostAndReload(page, {
      serverId: "add-project-flow-offline",
      label: "Offline Host",
    });

    await openAddProjectFlow(page);

    await expect(addProjectFlowHost(page, "add-project-flow-offline")).toHaveCount(0);
    await expect(addProjectFlowMethod(page, "open-folder")).toBeVisible();
  });

  test.describe("with two connected hosts", () => {
    let secondaryHost: IsolatedHostDaemon;

    test.beforeAll(async () => {
      secondaryHost = await startIsolatedHostDaemon(SECONDARY_HOST_ID);
    });

    test.afterAll(async () => {
      await secondaryHost?.close();
    });

    test("keyboard selection chooses the second host", async ({ page }) => {
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryHost.serverId,
        label: SECONDARY_HOST_LABEL,
        port: secondaryHost.port,
      });
      await waitForConnectedHost(page, {
        serverId: SECONDARY_HOST_ID,
        endpoint: `localhost:${secondaryHost.port}`,
      });
      await openAddProjectHostSelection(page);

      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");

      await expectAddProjectPage(page, "method");
      await expect(addProjectFlow(page)).toContainText(SECONDARY_HOST_LABEL);
    });

    test("Escape and Back restore searchable page input before closing at the root", async ({
      page,
    }) => {
      const renderWarnings = watchAddProjectRenderWarnings(page);
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryHost.serverId,
        label: SECONDARY_HOST_LABEL,
        port: secondaryHost.port,
      });
      await waitForConnectedHost(page, {
        serverId: SECONDARY_HOST_ID,
        endpoint: `localhost:${secondaryHost.port}`,
      });
      await openAddProjectHostSelection(page);

      await addProjectFlowInput(page).fill("o");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "method");

      await chooseAddProjectMethod(page, "new-directory");
      await expectAddProjectPage(page, "folder-browser");
      await page.keyboard.press("Escape");

      await expectAddProjectPage(page, "method");
      await expect(addProjectFlowInput(page)).toHaveCount(0);
      await chooseAddProjectMethod(page, "new-directory");
      await expectAddProjectPage(page, "folder-browser");
      await addProjectFlowBack(page).click();

      await expectAddProjectPage(page, "method");
      await addProjectFlowBack(page).click();
      await expectAddProjectPage(page, "host");
      await expect(addProjectFlowInput(page)).toHaveValue("o");
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "method");
      await expect(addProjectFlow(page)).toContainText(SECONDARY_HOST_LABEL);

      await page.keyboard.press("Escape");
      await expectAddProjectPage(page, "host");
      await navigateAndDismissAddProject(page);
      await expect(addProjectFlow(page)).not.toBeVisible();
      expect(renderWarnings).toEqual([]);
    });

    test("New directory creates a Project on the selected remote host", async ({ page }) => {
      const parentDirectory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-remote-project-"));
      const directoryName = `remote-${randomUUID().slice(0, 8)}`;
      const directoryPath = path.join(parentDirectory, directoryName);

      try {
        await gotoAppShell(page);
        await addConnectedHostAndReload(page, {
          serverId: secondaryHost.serverId,
          label: SECONDARY_HOST_LABEL,
          port: secondaryHost.port,
        });
        await waitForConnectedHost(page, {
          serverId: SECONDARY_HOST_ID,
          endpoint: `localhost:${secondaryHost.port}`,
        });
        await openAddProjectHostSelection(page);
        await addProjectFlowHost(page, SECONDARY_HOST_ID).click();
        await expectAddProjectPage(page, "method");

        await expect(addProjectFlowMethod(page, "new-directory")).toContainText(
          `Create an empty folder on ${SECONDARY_HOST_LABEL}`,
        );
        await chooseAddProjectMethod(page, "new-directory");
        // The temporary parent is outside the host's browsable home, so create by path.
        await addProjectFlowInput(page).fill(directoryPath);
        const createAtPath = page.getByTestId("add-project-flow-create-at-path");
        await expect(createAtPath).toContainText(`Create folder “${directoryName}”`);
        await createAtPath.click();

        const projectId = await expectOpenedProject(page, directoryName);
        await expectNewWorkspaceForAddedProject(page, {
          serverId: SECONDARY_HOST_ID,
          projectId,
          projectName: directoryName,
          projectPath: directoryPath,
        });
        await expectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);
        await expectProjectDirectory(directoryPath);
      } finally {
        await rm(parentDirectory, { recursive: true, force: true });
      }
    });
  });

  test("filtered hosts keep the keyboard-selected row visible", async ({ page }) => {
    const hosts: IsolatedHostDaemon[] = [];
    try {
      for (let index = 1; index <= 3; index += 1) {
        hosts.push(await startIsolatedHostDaemon(`scroll-host-${index}`));
      }
      await page.setViewportSize({ width: 1280, height: 360 });
      await gotoAppShell(page);
      await addConnectedHostsAndReload(
        page,
        hosts.map((host, index) => ({
          serverId: host.serverId,
          port: host.port,
          label: index < 2 ? `Fleet 0${index + 1}` : "Other host",
        })),
        { primaryLabel: "Fleet 00" },
      );
      for (const host of hosts) {
        await waitForConnectedHost(page, {
          serverId: host.serverId,
          endpoint: `localhost:${host.port}`,
        });
      }
      await openAddProjectHostSelection(page);
      await expect(
        addProjectFlow(page).getByRole("button").filter({ hasText: "Other host" }),
      ).toBeVisible();

      await addProjectFlowInput(page).fill("Fleet");
      await expect(addProjectFlowHost(page, hosts[2]!.serverId)).toHaveCount(0);
      await navigateAddProjectResults(page, "ArrowDown", 2);
      await expectAddProjectResultVisible(page, "Fleet 02");

      // Filtering out the first host moves retained rows to new positions.
      await addProjectFlowInput(page).fill("scroll-host");
      await expect(addProjectFlowHost(page, getServerId())).toHaveCount(0);
      await expectAddProjectResultVisible(page, "Fleet 01");
      await navigateAddProjectResults(page, "ArrowDown", 2);
      await expectAddProjectResultVisible(page, "Other host");
      await navigateAddProjectResults(page, "ArrowDown", 1);
      await expectAddProjectResultVisible(page, "Fleet 01");

      await addProjectFlowInput(page).fill("Fleet");
      await expectAddProjectResultVisible(page, "Fleet 00");
      await navigateAddProjectResults(page, "ArrowDown", 2);
      await expectAddProjectResultVisible(page, "Fleet 02");
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "method");
      await expect(addProjectFlow(page)).toContainText("Fleet 02");
    } finally {
      await Promise.all(hosts.map((host) => host.close()));
    }
  });

  test("keyboard folder search adds the selected Project", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);

    await chooseAddProjectMethod(page, "open-folder");
    await page.keyboard.type(projectPickerFixture.fuzzyQuery);
    await expect(addProjectFlow(page)).toContainText(projectPickerFixture.projectName, {
      timeout: 30_000,
    });
    await page.keyboard.press("Enter");

    const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
    projectPickerFixture.rememberProjectId(projectId);
    await expectNewWorkspaceForAddedProject(page, {
      serverId: getServerId(),
      projectId,
      projectName: projectPickerFixture.projectName,
      projectPath: projectPickerFixture.projectPath,
    });
    await expectProjectHasNoWorkspaces(projectId);
  });

  test("keyboard navigation keeps the selected row inside the visible results", async ({
    page,
  }) => {
    const parentDirectory = await mkdtemp(path.join(homedir(), "paseo-e2e-scroll-"));
    const rowPath = (index: number) =>
      path.join(parentDirectory, `scroll-probe-${String(index).padStart(2, "0")}`);
    let projectId: string | null = null;
    try {
      await Promise.all(Array.from({ length: 16 }, (_, index) => mkdir(rowPath(index))));
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "open-folder");
      await addProjectFlowInput(page).fill(path.basename(parentDirectory));
      const results = page.getByTestId("add-project-flow-results");
      await expect(results.getByRole("button", { name: /scroll-probe-/ })).toHaveCount(16, {
        timeout: 30_000,
      });

      await navigateAddProjectResults(page, "ArrowDown", 12);
      await expectAddProjectResultVisible(page, rowPath(11));
      await navigateAddProjectResults(page, "ArrowUp", 12);
      await expectAddProjectResultVisible(page, parentDirectory);
      await navigateAddProjectResults(page, "ArrowUp", 1);
      await expectAddProjectResultVisible(page, rowPath(15));
      await navigateAddProjectResults(page, "ArrowDown", 1);
      await expectAddProjectResultVisible(page, parentDirectory);

      await navigateAddProjectResults(page, "ArrowDown", 12);
      await expectAddProjectResultVisible(page, rowPath(11));
      await addProjectFlowInput(page).fill(`${path.basename(parentDirectory)}probe`);
      await expect(results.getByRole("button")).toHaveCount(16);
      await expectAddProjectResultVisible(page, rowPath(0));
      await navigateAddProjectResults(page, "ArrowDown", 12);
      await expectAddProjectResultVisible(page, rowPath(12));
      await addProjectFlowInput(page).fill(path.basename(parentDirectory));
      await expect(results.getByRole("button")).toHaveCount(17);
      await expectAddProjectResultVisible(page, parentDirectory);
      await navigateAddProjectResults(page, "ArrowDown", 12);
      await expectAddProjectResultVisible(page, rowPath(11));
      await page.keyboard.press("Enter");
      projectId = await expectOpenedProject(page, "scroll-probe-11");
      await expectNewWorkspaceForAddedProject(page, {
        serverId: getServerId(),
        projectId,
        projectName: "scroll-probe-11",
        projectPath: rowPath(11),
      });
    } finally {
      if (projectId) await removeCreatedProject(rowPath(11), projectId);
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  test("a complete repository URL remains selectable without a GitHub search result", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);
    await chooseAddProjectMethod(page, "github");

    const remote = "https://github.invalid/acme/manual.git";
    await addProjectFlowInput(page).fill(remote);
    await expect(addProjectFlow(page).getByText("manual", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");

    await expectAddProjectPage(page, "folder-browser");
    const title = addProjectFlow(page).getByTestId("add-project-flow-title");
    await expect(title.getByText("Clone manual", { exact: true })).toBeVisible();
    await expect(title.getByText("localhost", { exact: true })).toBeVisible();
    await expect(title).not.toContainText("Where should Paseo create");
    await addProjectFlowBack(page).click();
    await expect(addProjectFlowInput(page)).toHaveValue(remote);
  });

  test("New project folder validates the name, then creates a Project in the browsed folder", async ({
    page,
  }) => {
    // Browsing is limited to the host's locations; the daemon's home is one of them.
    const parentDirectory = await mkdtemp(path.join(homedir(), "paseo-e2e-new-project-"));
    const directoryName = `created-${randomUUID().slice(0, 8)}`;
    const directoryPath = path.join(parentDirectory, directoryName);
    let projectId: string | null = null;

    try {
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "new-directory");
      await expect(addProjectFlowLocation(page)).toHaveText("Locations");

      await browseAddProjectFolderPath(page, parentDirectory, path.basename(parentDirectory));
      await page.keyboard.type("../invalid");
      await expect(page.getByTestId("add-project-flow-create-folder")).toHaveCount(0);
      await expect(page.getByTestId("add-project-flow-empty")).toContainText(
        "Choose a different folder name",
      );

      await addProjectFlowInput(page).fill(directoryName);
      const create = page.getByTestId("add-project-flow-create-folder");
      await expect(create).toContainText(`Create folder “${directoryName}”`);
      await page.keyboard.press("Enter");

      projectId = await expectOpenedProject(page, directoryName);
      await expectNewWorkspaceForAddedProject(page, {
        serverId: getServerId(),
        projectId,
        projectName: directoryName,
        projectPath: directoryPath,
      });
      await expectProjectHasNoWorkspaces(projectId);
      await expectProjectDirectory(directoryPath);
    } finally {
      await removeCreatedProject(directoryPath, projectId).catch(() => undefined);
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  // Hosts that advertise a Projects folder get the simpler flow; the legacy tests above
  // cover hosts without one.
  test.describe("with a Projects folder", () => {
    let projectsHost: IsolatedHostDaemon;
    let projectsRoot: string;

    test.beforeAll(async () => {
      projectsRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-e2e-projects-")));
      await mkdir(path.join(projectsRoot, "clients"));
      projectsHost = await startIsolatedHostDaemon(PROJECTS_HOST_ID, {
        environment: { ...process.env, PASEO_PROJECTS_ROOT: projectsRoot },
      });
    });

    test.afterAll(async () => {
      await projectsHost?.close();
      if (projectsRoot) await rm(projectsRoot, { recursive: true, force: true });
    });

    test("offers two options and adds a new nested folder without choosing a host", async ({
      page,
    }) => {
      const directoryName = `created-${randomUUID().slice(0, 8)}`;
      const directoryPath = path.join(projectsRoot, "clients", directoryName);
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: projectsHost.serverId,
        label: PROJECTS_HOST_LABEL,
        port: projectsHost.port,
      });
      await waitForConnectedHost(page, {
        serverId: PROJECTS_HOST_ID,
        endpoint: `localhost:${projectsHost.port}`,
      });

      // Two connected hosts, but the Projects folder host is chosen without asking.
      await openAddProjectFlow(page);
      await expect(addProjectFlowMethod(page, "open-folder")).toContainText("Choose a folder");
      await expect(addProjectFlowMethod(page, "github")).toContainText("Clone from GitHub");
      await expect(addProjectFlowMethod(page, "new-directory")).toHaveCount(0);
      await expect(addProjectFlowMethod(page, "directory-search")).toHaveCount(0);
      await expect(addProjectFlowMethod(page, "browse")).toHaveCount(0);

      await chooseAddProjectMethod(page, "open-folder");
      const breadcrumb = page.getByTestId("add-project-flow-breadcrumb");
      const primary = page.getByTestId("add-project-flow-primary");
      await expect(breadcrumb).toHaveText("Projects", { timeout: 30_000 });
      await expect(primary).toContainText("Add “Projects” as project");
      await expect(primary).toBeDisabled();

      // The list only navigates: choosing a folder enters it.
      await page.getByTestId("add-project-flow-folder-clients").click();
      await expect(breadcrumb).toContainText("clients");
      await expect(primary).toContainText("Add “clients” as project");

      await page.getByTestId("add-project-flow-new-folder").click();
      await page.getByTestId("add-project-flow-new-folder-name").fill(directoryName);
      await page.keyboard.press("Enter");
      await expect(breadcrumb).toContainText(directoryName, { timeout: 30_000 });
      await expectProjectDirectory(directoryPath);
      await expect(primary).toContainText(`Add “${directoryName}” as project`);

      await page.keyboard.press("ControlOrMeta+Enter");
      const projectId = await expectOpenedProject(page, directoryName);
      await expectNewWorkspaceForAddedProject(page, {
        serverId: PROJECTS_HOST_ID,
        projectId,
        projectName: directoryName,
        projectPath: directoryPath,
      });
    });

    test("Clone from GitHub defaults to the Projects folder and can change location", async ({
      page,
    }) => {
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: projectsHost.serverId,
        label: PROJECTS_HOST_LABEL,
        port: projectsHost.port,
      });
      await waitForConnectedHost(page, {
        serverId: PROJECTS_HOST_ID,
        endpoint: `localhost:${projectsHost.port}`,
      });
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "github");

      await addProjectFlowInput(page).fill("https://github.invalid/acme/manual.git");
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "clone-destination");
      await expect(page.getByTestId("add-project-flow-clone-default")).toContainText("Clone into");
      await expect(page.getByTestId("add-project-flow-clone-default")).toContainText("manual");

      await page.getByTestId("add-project-flow-clone-change-location").click();
      await expectAddProjectPage(page, "folder-browser");
      await expect(page.getByTestId("add-project-flow-primary")).toContainText("Clone here");
      await expect(page.getByTestId("add-project-flow-new-folder")).toBeVisible();
    });
  });

  test("a pasted path opens directly without browsing first", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);
    await chooseAddProjectMethod(page, "open-folder");

    await addProjectFlowInput(page).fill(projectPickerFixture.projectPath);
    const option = page.getByTestId(
      `add-project-flow-path-${encodeURIComponent(projectPickerFixture.projectPath)}`,
    );
    await expect(option).toBeVisible();
    await expect(page.getByTestId("add-project-flow-loading")).toHaveCount(0);
    await option.click();

    const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
    projectPickerFixture.rememberProjectId(projectId);
    await expectNewWorkspaceForAddedProject(page, {
      serverId: getServerId(),
      projectId,
      projectName: projectPickerFixture.projectName,
      projectPath: projectPickerFixture.projectPath,
    });
    await expectProjectHasNoWorkspaces(projectId);
  });

  test("browsing into a folder and opening it adds that Project", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);
    await chooseAddProjectMethod(page, "open-folder");

    const parent = path.dirname(projectPickerFixture.projectPath);
    await browseAddProjectFolderPath(page, parent, path.basename(parent));
    // Typing filters this folder's children; Enter enters the best match.
    await page.keyboard.type(projectPickerFixture.projectName);
    await expect(
      page.getByTestId(
        `add-project-flow-folder-${encodeURIComponent(projectPickerFixture.projectName)}`,
      ),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(addProjectFlowLocation(page)).toContainText(projectPickerFixture.projectName);
    await expect(page.getByTestId("add-project-flow-use-folder")).toBeVisible();
    // Backspace with an empty filter goes up one folder.
    await page.keyboard.press("Backspace");
    await expect(addProjectFlowLocation(page)).not.toContainText(projectPickerFixture.projectName);
    await page.keyboard.type(projectPickerFixture.projectName);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("add-project-flow-use-folder")).toBeVisible();
    await page.keyboard.press("Enter");

    const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
    projectPickerFixture.rememberProjectId(projectId);
    await expectNewWorkspaceForAddedProject(page, {
      serverId: getServerId(),
      projectId,
      projectName: projectPickerFixture.projectName,
      projectPath: projectPickerFixture.projectPath,
    });
  });
});

test.describe("Compact Add project context", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("canceling Add project preserves the sidebar", async ({ page }) => {
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await openAddProjectFlow(page);
    await page.keyboard.press("Escape");
    await expect(addProjectFlow(page)).not.toBeVisible();
    await expect(page.getByTestId("sidebar-collapse")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("sidebar-search")).toBeVisible();
  });
  test("successful Add project reveals the new workspace page", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await openAddProjectFlow(page);
    await chooseAddProjectMethod(page, "open-folder");
    await addProjectFlowInput(page).fill(projectPickerFixture.fuzzyQuery);
    await expect(addProjectFlow(page)).toContainText(projectPickerFixture.projectName);
    await page.keyboard.press("Enter");
    const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
    projectPickerFixture.rememberProjectId(projectId);
    await expectNewWorkspaceForAddedProject(page, {
      serverId: getServerId(),
      projectId,
      projectName: projectPickerFixture.projectName,
      projectPath: projectPickerFixture.projectPath,
    });
    await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
  });
});
