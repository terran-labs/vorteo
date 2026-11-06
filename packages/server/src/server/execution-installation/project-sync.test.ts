import { describe, expect, test } from "vitest";
import {
  folderProjectKey,
  planProjectSync,
  type ProjectSyncEntry,
  type ProjectSyncHost,
} from "./project-sync.js";

const ROOT = "/Users/owner/dev";

function project(input: Partial<ProjectSyncEntry> & { projectId: string; path: string }) {
  const { path, ...rest } = input;
  return {
    projectKey: null,
    projectKeyPinned: false,
    rootPath: path,
    logicalRootPath: path,
    kind: "git",
    displayName: path.split("/").at(-1)!,
    customName: null,
    archived: false,
    system: false,
    factory: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...rest,
  } satisfies ProjectSyncEntry;
}

function hosts(host: ProjectSyncEntry[], dev: ProjectSyncEntry[]): ProjectSyncHost[] {
  return [
    { kind: "host", projectsRoot: ROOT, projects: host },
    { kind: "container", projectsRoot: ROOT, projects: dev },
  ];
}

describe("planProjectSync", () => {
  test("repairs split System projects, a Dev-only project and a Factory alias folder", () => {
    const plan = planProjectSync(
      hosts(
        [
          project({
            projectId: "host-system",
            path: `${ROOT}/vorteo`,
            projectKey: "system:srv_host",
            system: true,
          }),
          project({
            projectId: "host-freed",
            path: `${ROOT}/freed`,
            projectKey: "remote:github.com/acme/freed",
          }),
          // Outside the shared folder: stays on its host.
          project({ projectId: "host-only", path: "/Users/owner/.local/work" }),
        ],
        [
          project({
            projectId: "dev-system",
            path: `${ROOT}/vorteo`,
            projectKey: "system:srv_dev",
            system: true,
          }),
          project({
            projectId: "dev-vorton",
            path: `${ROOT}/vorton`,
            projectKey: "host:srv_dev:/Users/owner/dev/vorton",
            customName: "Vorton",
          }),
          project({
            projectId: "dev-freed",
            path: "/Users/guest/dev/freed",
            logicalRootPath: `${ROOT}/freed`,
            projectKey: "remote:github.com/acme/freed",
            factory: true,
          }),
          // The Projects folder itself is never a synchronized project.
          project({ projectId: "dev-root", path: ROOT }),
        ],
      ),
    );

    expect(plan.get("host")).toEqual([
      { kind: "set_key", projectId: "host-freed", projectKey: "remote:github.com/acme/freed" },
      { kind: "set_key", projectId: "host-system", projectKey: "system:srv_host" },
      {
        kind: "create",
        rootPath: `${ROOT}/vorton`,
        projectKey: "host:srv_dev:/Users/owner/dev/vorton",
        displayName: "vorton",
        customName: "Vorton",
      },
      { kind: "rename_key", from: "system:srv_dev", to: "system:srv_host" },
    ]);
    expect(plan.get("container")).toEqual([
      { kind: "set_key", projectId: "dev-freed", projectKey: "remote:github.com/acme/freed" },
      { kind: "set_key", projectId: "dev-system", projectKey: "system:srv_host" },
      {
        kind: "set_key",
        projectId: "dev-vorton",
        projectKey: "host:srv_dev:/Users/owner/dev/vorton",
      },
      { kind: "rename_key", from: "system:srv_dev", to: "system:srv_host" },
    ]);

    // Once applied, keys stay; only the rename under the replaced key repeats, so a batch cut
    // short after its key change still moves memberships. A key still held elsewhere, even
    // outside the Projects folder, is never renamed.
    const settled = planProjectSync(
      hosts(
        [
          project({
            projectId: "a",
            path: `${ROOT}/vorteo`,
            projectKey: "k",
            projectKeyPinned: true,
          }),
          project({ projectId: "outside", path: "/Users/owner/work", projectKey: "held" }),
        ],
        [
          project({
            projectId: "b",
            path: `${ROOT}/vorteo`,
            projectKey: "k",
            projectKeyPinned: true,
            previousKeys: ["system:srv_dev", "held"],
          }),
        ],
      ),
    );
    const rename = { kind: "rename_key", from: "system:srv_dev", to: "k" };
    expect(settled.get("host")).toEqual([rename]);
    expect(settled.get("container")).toEqual([rename]);
  });

  test("never joins different folders by remote, and never restores an archived project", () => {
    const remote = "remote:github.com/acme/app";
    const plan = planProjectSync(
      hosts(
        [
          project({ projectId: "host-app", path: `${ROOT}/app`, projectKey: remote }),
          project({ projectId: "host-old", path: `${ROOT}/old`, archived: true }),
        ],
        [
          project({
            projectId: "dev-clone",
            path: `${ROOT}/app-clone`,
            projectKey: remote,
            createdAt: "2026-10-02T00:00:00.000Z",
          }),
          project({ projectId: "dev-old", path: `${ROOT}/old`, projectKey: "old" }),
        ],
      ),
    );
    const cloneKey = folderProjectKey(`${ROOT}/app-clone`);
    expect(plan.get("host")).toEqual([
      { kind: "set_key", projectId: "host-app", projectKey: remote },
      {
        kind: "create",
        rootPath: `${ROOT}/app-clone`,
        projectKey: cloneKey,
        displayName: "app-clone",
        customName: null,
      },
    ]);
    // The clone keeps its own identity; memberships under the remote key stay with the original.
    expect(plan.get("container")).toEqual([
      {
        kind: "create",
        rootPath: `${ROOT}/app`,
        projectKey: remote,
        displayName: "app",
        customName: null,
      },
      { kind: "set_key", projectId: "dev-clone", projectKey: cloneKey },
      { kind: "set_key", projectId: "dev-old", projectKey: "old" },
    ]);
  });

  test("does nothing unless every host shares the same Projects folder", () => {
    const plan = planProjectSync([
      {
        kind: "host",
        projectsRoot: ROOT,
        projects: [project({ projectId: "a", path: `${ROOT}/a` })],
      },
      { kind: "container", projectsRoot: "/elsewhere", projects: [] },
    ]);
    expect(plan.size).toBe(0);
  });
});
