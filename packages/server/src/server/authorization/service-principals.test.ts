import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ServicePrincipalStore } from "./service-principals.js";
import { SERVICE_ALLOWED_OPERATIONS, SERVICE_DENIED_OPERATIONS } from "./service-restrictions.js";
import { projectServiceDirectoryMessage } from "./service-projections.js";

describe("service principal store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function store() {
    const dir = mkdtempSync(join(tmpdir(), "service-principals-"));
    dirs.push(dir);
    return { dir, store: new ServicePrincipalStore(dir) };
  }

  test("enforces exact-agent message grants, issuer control and expiry", async () => {
    const { store: principals } = store();
    await expect(
      principals.create({
        label: "lanes",
        permissions: [],
        grants: [{ actions: ["agent.message"], workspaceIds: ["w1"] }],
        issuerPrincipalId: "owner",
      }),
    ).rejects.toThrow(/exact agent IDs only/);
    const { principal } = await principals.create({
      label: "bridge",
      permissions: [],
      grants: [{ actions: ["agent.read", "agent.message"], agentIds: ["a1"] }],
      issuerPrincipalId: "hub:x",
    });
    await expect(principals.revoke(principal.id, "hub:other")).rejects.toThrow(
      /owner or the issuer/,
    );
    await expect(principals.setGrants(principal.id, [], "hub:other")).rejects.toThrow(
      /owner or the issuer/,
    );
    await expect(principals.revoke(principal.id, "hub:x")).resolves.toMatchObject({
      revokedAt: expect.any(String),
    });

    await expect(
      principals.create({
        label: "past",
        permissions: ["workspace.read"],
        expiresAt: "2000-01-01T00:00:00Z",
        issuerPrincipalId: "owner",
      }),
    ).rejects.toThrow(/future/);
    const soon = await principals.create({
      label: "soon",
      permissions: ["workspace.read"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuerPrincipalId: "owner",
    });
    await expect(principals.authenticate(soon.token)).resolves.not.toBeNull();
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    try {
      await expect(principals.authenticate(soon.token)).resolves.toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test("an unreadable store admits nobody and is never overwritten", async () => {
    const { dir, store: first } = store();
    const { token } = await first.create({
      label: "observer",
      permissions: ["workspace.read"],
      issuerPrincipalId: "owner",
    });
    const file = join(dir, "service-principals.json");
    writeFileSync(file, "{ not json");
    const reopened = new ServicePrincipalStore(dir);
    await expect(reopened.authenticate(token)).rejects.toThrow(/unreadable/);
    await expect(
      reopened.create({
        label: "new",
        permissions: ["workspace.read"],
        issuerPrincipalId: "owner",
      }),
    ).rejects.toThrow(/unreadable/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("service session operations", () => {
  test("service sessions may use exactly the reviewed operations", () => {
    expect([...SERVICE_ALLOWED_OPERATIONS].sort()).toEqual([
      "agent.timeline.set_subscription.request",
      "cancel_agent_request",
      "fetch_agent_request",
      "fetch_agent_timeline_request",
      "fetch_agents_request",
      "fetch_workspaces_request",
      "project.list.request",
      "send_agent_message_request",
      "subscription.release.request",
    ]);
    // No allowed operation addresses the filesystem, terminals or other hosts.
    for (const operation of SERVICE_ALLOWED_OPERATIONS)
      expect(SERVICE_DENIED_OPERATIONS.has(operation)).toBe(false);
    for (const operation of [
      "file_explorer_request",
      "file_download_token_request",
      "agent.queue.attachment.get.request",
      "set_agent_mode_request",
      "create_agent_request",
      "agent_permission_response",
    ])
      expect(SERVICE_ALLOWED_OPERATIONS.has(operation)).toBe(false);
  });
});

describe("service directory projection", () => {
  test("a workspace removal never carries the emptied project's root path or custom name", () => {
    const projected = projectServiceDirectoryMessage({
      type: "workspace_update",
      payload: {
        kind: "remove",
        id: "w1",
        emptyProject: {
          projectId: "p1",
          projectKey: "k",
          projectDisplayName: "Secret",
          projectCustomName: "Private name",
          projectRootPath: "/Users/owner/secret",
          projectKind: "git",
        },
      },
    } as never) as unknown as { payload: { emptyProject: Record<string, unknown> } };
    expect(projected.payload.emptyProject).toEqual({
      projectId: "p1",
      projectKey: "k",
      projectDisplayName: "Secret",
      projectKind: "git",
      projectRootPath: "",
    });
  });
});
