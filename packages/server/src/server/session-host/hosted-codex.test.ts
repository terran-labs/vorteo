import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type {
  AgentClient,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import {
  CONTROLLED_SESSION_CAPABILITIES,
  ControlledSession,
} from "../test-utils/controlled-provider-session.js";
import { createSessionHostConnector } from "./connector.js";
import { createAgentProviderRuntime } from "../agent/provider-runtime.js";
import { resolveFactoryCodexAccount } from "../execution-installation/accounts/codex-signin-consumer.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { FactoryManagedCodexAccount } from "../agent/providers/codex/factory-boundary.js";
import { createAppliedSeqStore } from "./applied-store.js";
import { planHostedStartup } from "./boot-attach.js";
import type { HostedAdoption } from "./hosted-agent-client.js";
import { createHostedAgentClient } from "./hosted-agent-client.js";
import { HostedAgentSession } from "./hosted-agent-session.js";
import { rotateSessionHostToken, sessionHostPaths } from "./host-files.js";
import { startSessionHost } from "./host.js";
import { createProviderSessionFactory, type HostedClientFactory } from "./provider-sessions.js";

const logger = pino({ level: "silent" });
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const CUSTOM_PROVIDER = { id: "codex-account-1", label: "Codex 1", extends: "codex" };
const config: AgentSessionConfig = { provider: "codex", cwd: "/work", model: "gpt-5.4" };

/**
 * A host whose client factory builds Codex-shaped sessions (goals on, /goal and /compact handled)
 * and records what the worker asked it to build.
 */
async function codexFixture(
  options: {
    managed?: true;
    resolve?: () => Promise<FactoryManagedCodexAccount | null>;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "hosted-codex-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = sessionHostPaths(home);
  const token = await rotateSessionHostToken(paths);
  const hosted: ControlledSession[] = [];
  const factoryInputs: Parameters<HostedClientFactory>[0][] = [];
  const host = await startSessionHost({
    socketPath: paths.socketPath,
    token,
    mcpToken: "test-mcp-token",
    factoryManagedCodex: options.managed,
    openSession: createProviderSessionFactory({
      logger,
      createClient: (input) => {
        factoryInputs.push(input);
        return {
          provider: "codex",
          capabilities: CONTROLLED_SESSION_CAPABILITIES,
          async createSession(sessionConfig) {
            const session = new ControlledSession(sessionConfig, [], {
              provider: "codex",
              goals: true,
            });
            hosted.push(session);
            return session;
          },
          async resumeSession(_handle, overrides) {
            const session = new ControlledSession(
              { provider: "codex", cwd: "/", ...overrides },
              [],
              {
                provider: "codex",
                goals: true,
              },
            );
            hosted.push(session);
            return session;
          },
          async fetchCatalog() {
            return { models: [], modes: [] };
          },
          async isAvailable() {
            return true;
          },
        };
      },
    }),
  });
  cleanups.push(() => host.close());
  const newConnector = () => {
    const connector = createSessionHostConnector({ paths, logger, retryAfterMs: 0 });
    cleanups.push(() => connector.close());
    return connector;
  };
  const connector = newConnector();
  const local: ControlledSession[] = [];
  const inner: AgentClient = {
    provider: "codex",
    capabilities: CONTROLLED_SESSION_CAPABILITIES,
    async createSession(sessionConfig) {
      const session = new ControlledSession(sessionConfig, [], { provider: "codex" });
      local.push(session);
      return session;
    },
    async resumeSession(_handle, overrides) {
      const session = new ControlledSession({ provider: "codex", cwd: "/", ...overrides }, [], {
        provider: "codex",
      });
      local.push(session);
      return session;
    },
    async fetchCatalog() {
      return { models: [], modes: [] };
    },
    async isAvailable() {
      return true;
    },
  };
  const newWorker = (workerConnector: ReturnType<typeof newConnector>) =>
    createHostedAgentClient({
      inner,
      runtimeSettings: { env: { CODEX_HOME: "/accounts/codex-1" } },
      customProvider: CUSTOM_PROVIDER,
      factoryManagedAccount: options.resolve,
      routing: { connector: workerConnector, isEnabled: () => true, logger },
    });
  return {
    client: newWorker(connector),
    hosted,
    local,
    factoryInputs,
    connector,
    paths,
    newWorker,
    newConnector,
  };
}

const managedAccount: FactoryManagedCodexAccount = {
  providerId: CUSTOM_PROVIDER.id,
  accountKey: "stable-installation-account",
  codexHome: "/accounts/codex-1",
  codexBinary: "/native/bin/codex",
};
const confined = { ...config, factoryCodexBoundary: "checkout-write" as const };

test("daemon provider runtime routes the installed account through the session host", async () => {
  const fixture = await codexFixture({ managed: true });
  const home = realpathSync(mkdtempSync(join(tmpdir(), "factory-managed-runtime-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const creationId = "00000000-0000-4000-8000-000000000001";
  const providerId = `codex-account-${creationId}`;
  const codexHome = join(home, "codex-accounts", providerId);
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const definition = {
    id: "fixture-account",
    providerType: "codex",
    bindings: { host: providerId },
    policy: { enabled: true },
    accountSetup: { provider: "codex", creationId },
  };
  const providerOverrides = {
    [providerId]: { extends: "codex", label: "Fixture", env: { CODEX_HOME: codexHome } },
  };
  const store = {
    readInstallationSettingsAuthority: async () => ({
      environment: "host",
      serverId: "host",
      settings: { providerDefinitions: [definition], resourceExclusions: {} },
    }),
    get: () => ({ providers: providerOverrides }),
  } as unknown as DaemonConfigStore;
  const worker = async () => {
    const runtime = await createAgentProviderRuntime({
      paseoHome: home,
      logger,
      snapshotManager: {
        providerOverrides,
        sessionHost: { connector: fixture.newConnector(), isEnabled: () => true, logger },
        resolveFactoryManagedCodexAccount: (id) =>
          resolveFactoryCodexAccount(store, home, "host", id, async () => "/native/bin/codex"),
      },
    });
    cleanups.push(() => runtime.shutdown());
    return runtime.snapshotManager.getAgentManagerProviderState().clients[providerId]!;
  };
  const client = await worker();
  const context = { agentId: "managed-runtime-agent" };
  await client.createSession(confined, context);
  expect(fixture.factoryInputs[0]?.factoryManagedCodex).toMatchObject({
    providerId,
    codexHome,
    accountKey: definition.id,
  });
  const handle = { provider: "codex", sessionId: "managed-runtime-thread", metadata: confined };
  const recovered = await worker();
  await recovered.resumeSession(handle, {}, context);
  expect(fixture.hosted).toHaveLength(1);
  definition.policy.enabled = false;
  await expect(recovered.resumeSession(handle, {}, context)).rejects.toThrow(
    "account is unavailable",
  );
});

test("confined Codex opens and resumes only with the current daemon-resolved account", async () => {
  let current: FactoryManagedCodexAccount | null = managedAccount;
  let reads = 0;
  const fixture = await codexFixture({
    managed: true,
    resolve: async () => {
      reads++;
      return current;
    },
  });
  const context = { agentId: "factory-agent", env: { UNRELATED_VALUE: "worker-only" } };
  const created = await fixture.client.createSession(
    { ...confined, factoryManagedCodex: { accountKey: "agent-supplied" } } as AgentSessionConfig,
    context,
  );
  expect(created).toBeInstanceOf(HostedAgentSession);
  expect(fixture.factoryInputs[0]?.factoryManagedCodex).toEqual({
    ...managedAccount,
    boundary: "checkout-write",
  });

  const transport = await fixture.newConnector().connect();
  expect(transport?.factoryManagedCodex).toBe(true);
  expect(await transport?.list()).toEqual([
    expect.objectContaining({
      factoryCodexPlacement: { providerId: CUSTOM_PROVIDER.id, boundary: "checkout-write" },
    }),
  ]);
  await expect(
    transport?.attach({ sessionId: "factory-agent", afterSeq: null }),
  ).rejects.toMatchObject({ code: "unauthorized" });

  const handle = { provider: "codex", sessionId: "factory-thread", metadata: confined };
  const worker = fixture.newWorker(fixture.newConnector());
  await expect(
    worker.resumeSession(handle, {}, { agentId: "another-verified-agent" }),
  ).resolves.toBeInstanceOf(HostedAgentSession);
  current = { ...managedAccount, accountKey: "another-account" };
  await expect(worker.resumeSession(handle, {}, context)).rejects.toThrow(
    "account binding changed",
  );
  expect(reads).toBeGreaterThan(1);
  current = null;
  await expect(
    fixture.client.resumeSession(handle, {}, { agentId: "revoked-agent" }),
  ).rejects.toThrow("account is unavailable");
  expect(fixture.local).toEqual([]);
  expect(fixture.factoryInputs).toHaveLength(2);
});

test("an older host can open ordinary Codex but cannot open confined Codex", async () => {
  const fixture = await codexFixture({ resolve: async () => managedAccount });
  await expect(
    fixture.client.createSession(confined, { agentId: "factory-agent" }),
  ).rejects.toThrow("does not support confined Codex accounts");
  expect(fixture.local).toEqual([]);
  expect(fixture.factoryInputs).toEqual([]);
  await expect(
    fixture.client.createSession(config, { agentId: "ordinary-agent" }),
  ).resolves.toBeInstanceOf(HostedAgentSession);
  expect(fixture.factoryInputs[0]?.factoryManagedCodex).toBeUndefined();
});

test("startup attaches a confined turn only after verifying the saved provider and current account", async () => {
  const fixture = await codexFixture({ managed: true, resolve: async () => managedAccount });
  const session = await fixture.client.createSession(confined, { agentId: "factory-agent" });
  await session.startTurn("an in-flight turn");
  const connector = fixture.newConnector();
  const adoptions = new Map<string, HostedAdoption>();
  let current: FactoryManagedCodexAccount | null = null;
  let provider = "a-different-provider";
  const lookedUp: string[] = [];
  const plan = () =>
    planHostedStartup({
      routing: {
        connector,
        adoptions,
        applied: createAppliedSeqStore(fixture.paths),
        isEnabled: () => true,
        logger,
        async resolveFactoryManagedCodexAccount(providerId) {
          lookedUp.push(providerId);
          return current;
        },
      },
      agents: {
        async get() {
          return { provider, config: confined };
        },
      },
      logger,
    });
  expect((await plan()).adopted).toEqual([]);
  expect(lookedUp).toEqual([]);
  provider = CUSTOM_PROVIDER.id;
  expect((await plan()).adopted).toEqual([]);
  current = managedAccount;
  expect((await plan()).adopted).toEqual(["factory-agent"]);
  expect(lookedUp).toEqual([CUSTOM_PROVIDER.id, CUSTOM_PROVIDER.id]);
  expect(adoptions.get("factory-agent")?.factoryManagedCodex?.accountKey).toBe(
    managedAccount.accountKey,
  );
});

test("a Codex session is hosted with its account descriptor and reports its own capabilities", async () => {
  const fixture = await codexFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  expect(session).toBeInstanceOf(HostedAgentSession);
  expect(fixture.local).toEqual([]);
  // The host built the same derived client the worker would have, from the open request alone.
  expect(fixture.factoryInputs).toEqual([
    expect.objectContaining({
      provider: "codex",
      customProvider: CUSTOM_PROVIDER,
      runtimeSettings: { env: { CODEX_HOME: "/accounts/codex-1" } },
    }),
  ]);
  // Goal support is a per-session fact the client cannot know; the snapshot carries it.
  expect(session.capabilities.supportsGoals).toBe(true);
  expect(session.goals).toBeDefined();

  // A resume reopens on the same account: the descriptor travels with the resume request too.
  const resumed = await fixture.client.resumeSession(
    {
      provider: "codex",
      sessionId: "thread-1",
      nativeHandle: "thread-1",
      metadata: { cwd: "/work" },
    },
    {},
    { agentId: "agent-2" },
  );
  expect(resumed).toBeInstanceOf(HostedAgentSession);
  expect(fixture.factoryInputs[1]).toEqual(
    expect.objectContaining({ provider: "codex", customProvider: CUSTOM_PROVIDER }),
  );
});

test("goal state and goal writes cross to the hosted provider and the mirror follows", async () => {
  const fixture = await codexFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  expect(session.goals!.state).toMatchObject({ status: "ready", goal: null });

  const set = await session.goals!.set({ objective: "ship durable sessions" } as never);
  expect(set).toMatchObject({ goal: { objective: "ship durable sessions", status: "active" } });
  expect(session.goals!.state).toEqual(set);
  await expect.poll(() => events.some((event) => event.type === "goal_changed")).toBe(true);

  expect(await session.goals!.read()).toEqual(set);
  const cleared = await session.goals!.clear();
  expect(cleared).toMatchObject({ goal: null });
  expect(session.goals!.state).toEqual(cleared);
  // The provider holds the truth.
  expect(fixture.hosted[0]!.goals!.state).toEqual(cleared);
});

test("Codex commands run out of band in the host and their events come back to the worker", async () => {
  const fixture = await codexFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const provider = fixture.hosted[0]!;

  // Recognition is local and synchronous, as the manager requires.
  expect(session.tryHandleOutOfBand!("plain prompt")).toBeNull();
  expect(session.tryHandleOutOfBand!("/unknown thing")).toBeNull();
  const setGoal = session.tryHandleOutOfBand!("/goal finish the migration");
  expect(setGoal?.intent).toBe("goal");
  expect(session.tryHandleOutOfBand!("/goal pause")?.intent).toBeUndefined();

  const emitted: AgentStreamEvent[] = [];
  await setGoal!.run({ emit: (event) => emitted.push(event) });
  expect(emitted).toEqual([
    expect.objectContaining({
      type: "timeline",
      item: { type: "assistant_message", text: "goal handled" },
    }),
  ]);
  expect(provider.commands).toEqual(["/goal finish the migration"]);
  expect(session.goals!.state).toMatchObject({ goal: { objective: "finish the migration" } });

  const compact = session.tryHandleOutOfBand!("/compact");
  expect(compact).not.toBeNull();
  await compact!.run({ emit: (event) => emitted.push(event) });
  expect(provider.commands).toEqual(["/goal finish the migration", "/compact"]);
  // The turn itself was never started for a command.
  expect(provider.calls).toEqual([]);
});

test("without goal support the hosted session exposes no goals and refuses /goal", async () => {
  const home = mkdtempSync(join(tmpdir(), "hosted-codex-plain-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = sessionHostPaths(home);
  const token = await rotateSessionHostToken(paths);
  const host = await startSessionHost({
    socketPath: paths.socketPath,
    token,
    mcpToken: "test-mcp-token",
    openSession: createProviderSessionFactory({
      logger,
      createClient: () => ({
        provider: "codex",
        capabilities: CONTROLLED_SESSION_CAPABILITIES,
        async createSession(sessionConfig) {
          return new ControlledSession(sessionConfig, [], { provider: "codex" });
        },
        async resumeSession(_handle, overrides) {
          return new ControlledSession({ provider: "codex", cwd: "/", ...overrides }, [], {
            provider: "codex",
          });
        },
        async fetchCatalog() {
          return { models: [], modes: [] };
        },
        async isAvailable() {
          return true;
        },
      }),
    }),
  });
  cleanups.push(() => host.close());
  const connector = createSessionHostConnector({ paths, logger, retryAfterMs: 0 });
  cleanups.push(() => connector.close());
  const client = createHostedAgentClient({
    inner: {
      provider: "codex",
      capabilities: CONTROLLED_SESSION_CAPABILITIES,
      async createSession(sessionConfig) {
        return new ControlledSession(sessionConfig, [], { provider: "codex" });
      },
      async resumeSession(_handle, overrides) {
        return new ControlledSession({ provider: "codex", cwd: "/", ...overrides });
      },
      async fetchCatalog() {
        return { models: [], modes: [] };
      },
      async isAvailable() {
        return true;
      },
    },
    routing: { connector, isEnabled: () => true, logger },
  });
  const session = await client.createSession(config, { agentId: "agent-1" });
  expect(session).toBeInstanceOf(HostedAgentSession);
  expect(session.goals).toBeUndefined();
  expect(session.capabilities.supportsGoals).toBe(false);
  expect(session.tryHandleOutOfBand!("/goal anything")).toBeNull();
  expect(session.tryHandleOutOfBand!("/compact")).not.toBeNull();
});
