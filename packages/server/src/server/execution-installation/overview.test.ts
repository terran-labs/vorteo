import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import pino from "pino";
import { hashDaemonPassword } from "../auth.js";
import { createInstallationServer } from "./server.js";
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
          fetchWorkspaces: async () =>
            page([
              {
                id: "ws1",
                projectId: "p1",
                status: "running",
                projectRootPath: "/Users/owner/secret",
                scripts: [
                  { scriptName: "web", publicProxyUrl: "https://preview", terminalId: "t1" },
                ],
                gitRuntime: { remoteUrl: "https://user:tok@github.com/o/r.git" },
                githubRuntime: { pullRequest: { url: "https://github.com/o/r/pull/1" } },
              },
            ]) as never,
          fetchAgents: async () =>
            page([
              {
                agent: {
                  id: "a1",
                  status: "running",
                  pendingPermissions: [{ id: "p" }],
                  journal: [{ text: "secret" }],
                  lastError: "token=abc",
                  runtimeInfo: { extra: { k: "v" } },
                },
                project: {
                  projectKey: "k",
                  checkout: { remoteUrl: "https://user:tok@github.com/o/r.git" },
                },
              },
            ]) as never,
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
        projects: [{ projectKey: "remote:vorteo", projectRootPath: "" }],
        // Workspaces keep identity and status; paths, scripts, git and forge state stay inside.
        workspaces: [
          {
            id: "ws1",
            projectId: "p1",
            status: "running",
            projectRootPath: "",
            scripts: [],
            gitRuntime: {},
            githubRuntime: {},
          },
        ],
        // Only projected agent fields leave Vorteo, and URL credentials are stripped.
        agents: [
          {
            agent: { id: "a1", status: "running" },
            project: { projectKey: "k", workspaceName: null },
          },
        ],
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

  test.skipIf(process.platform === "win32")(
    "the HTTP route admits only observer or Host agent tokens, and observers manage nothing",
    async () => {
      const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "overview-http-")));
      dirs.push(stateDir);
      writeFileSync(join(stateDir, "index.html"), "<html><head></head></html>");
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const config = {
        public: {
          version: 1,
          installationId: randomUUID(),
          origin: "https://owner.example.test",
          environments: [
            { kind: "host", serverId: "host", endpoint: "host.example.test", useTls: true },
          ],
        },
        listenPort: 6770,
        webDistDir: stateDir,
        stateDir,
        ownerPasswordHash: hashDaemonPassword("owner"),
        hostAgentTokenHash: digest("host"),
        containerAgentTokenHash: digest("guest"),
        host: {
          endpoint: "127.0.0.1:6771",
          password: "host-pass",
          launchdService: "gui/501/local.vorteo.test.host",
        },
      } as unknown as InstallationConfig;
      const offline: OverviewDependencies = {
        connectOwner: async () => {
          throw new Error("offline");
        },
        connectService: async () => {
          throw new Error("offline");
        },
      };
      const app = createInstallationServer(
        config,
        {
          restart: async () => {
            throw Error("No daemon restart");
          },
        } as never,
        pino({ level: "silent" }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        offline,
      );
      const listener = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => listener.once("listening", resolve));
      const address = listener.address();
      if (!address || typeof address === "string") throw Error("Missing test address");
      config.listenPort = address.port;
      const request = (route: string, token?: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${address.port}/api/installation/${route}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            origin: `http://127.0.0.1:${address.port}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      try {
        expect((await request("overview")).status).toBe(401);
        expect((await request("overview", "guest")).status).toBe(401);
        const created = await request("overview/observers", "host", { label: "Vorton" });
        expect(created.status).toBe(200);
        const { principal, token } = (await created.json()) as {
          principal: { id: string };
          token: string;
        };
        const read = await request("overview", token);
        expect(read.status).toBe(200);
        expect(
          ((await read.json()) as { environments: { status: string }[] }).environments[0]?.status,
        ).toBe("unavailable");
        // Observer tokens authorize the overview only.
        expect((await request("overview/observers", token)).status).toBe(403);
        expect((await request(`overview/observers/${principal.id}/revoke`, token, {})).status).toBe(
          403,
        );
        expect(
          (await request(`overview/observers/${principal.id}/revoke`, "host", {})).status,
        ).toBe(200);
        expect((await request("overview", token)).status).toBe(401);
      } finally {
        await new Promise((resolve) => listener.close(resolve));
      }
    },
  );
});
