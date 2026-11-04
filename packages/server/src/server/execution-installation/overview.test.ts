import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { InstallationConfig } from "./config.js";
import { InstallationOverviewReader, type OverviewDependencies } from "./overview.js";

const page = <T>(entries: T[]) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });

describe("installation overview", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("reads through read-only principals and reports an unreachable environment without data", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "overview-"));
    dirs.push(stateDir);
    const config = {
      stateDir,
      public: {
        installationId: "inst",
        environments: [
          { kind: "host", serverId: "srv_host" },
          { kind: "container", serverId: "srv_dev" },
        ],
      },
    } as unknown as InstallationConfig;
    const issued: { kind: string; permissions: string[] }[] = [];
    const serviceTokens: string[] = [];
    const dependencies: OverviewDependencies = {
      connectOwner: async (kind) => ({
        getLastServerInfoMessage: () => ({ features: { servicePrincipals: true } }) as never,
        createServicePrincipal: async (input: { permissions: string[] }) => {
          issued.push({ kind, permissions: input.permissions });
          return { requestId: "r", principal: null, token: `token-${kind}`, error: null };
        },
        close: async () => undefined,
      }),
      connectService: async (kind, token) => {
        serviceTokens.push(token);
        if (kind === "container") throw new Error("connect ECONNREFUSED 127.0.0.1:6768");
        return {
          getLastServerInfoMessage: () => null,
          listProjects: async () => ({ projects: [{ projectKey: "remote:vorteo" }] }) as never,
          fetchWorkspaces: async () => page([{ id: "ws1" }]) as never,
          fetchAgents: async () => page([{ agent: { id: "a1" } }]) as never,
          close: async () => undefined,
        };
      },
    };

    const reader = new InstallationOverviewReader(config, dependencies);
    const first = await reader.read();
    await reader.read();

    expect(first.environments).toEqual([
      expect.objectContaining({
        kind: "host",
        status: "ok",
        projects: [{ projectKey: "remote:vorteo" }],
        workspaces: [{ id: "ws1" }],
        agents: [{ agent: { id: "a1" } }],
      }),
      expect.objectContaining({
        kind: "container",
        status: "unavailable",
        error: "connect ECONNREFUSED 127.0.0.1:6768",
        projects: [],
        workspaces: [],
        agents: [],
      }),
    ]);
    // Each environment's principal is issued once, read-only, and every read uses it.
    expect(issued).toEqual([
      { kind: "host", permissions: ["workspace.read"] },
      { kind: "container", permissions: ["workspace.read"] },
    ]);
    expect(new Set(serviceTokens)).toEqual(new Set(["token-host", "token-container"]));
    expect(statSync(join(stateDir, "overview-daemon-credentials.json")).mode & 0o777).toBe(0o600);
  });
});
