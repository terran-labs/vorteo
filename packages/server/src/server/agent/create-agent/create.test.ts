import { readInstallationSettings } from "../../execution-installation/settings/projection.js";

import { readInstallationProviders } from "../../execution-installation/settings/providers.js";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { realpath } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

import {
  createTestAgentClient,
  createTestAgentClients,
} from "../../test-utils/fake-agent-client.js";

import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";

import { AgentManager, ManagedAgent } from "../agent-manager.js";

import { AgentStorage } from "../agent-storage.js";

import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";

import { createProviderEnv } from "../provider-launch-config.js";

import { captureSkillPolicy } from "../../orchestration-skills/internal/policy.js";

import { inventorySkills } from "../../orchestration-skills/internal/inventory.js";

import type { AgentSessionConfig } from "../agent-sdk-types.js";

import {
  createAgentCommand,
  launchCodexHome,
  leadLaunchCreateInput,
  prepareLeadLaunch,
  startConfirmedLeadLaunch,
} from "./create.js";
import {
  LEAD_LAUNCH_ID_LABEL,
  leadLaunchQuestion,
  type LeadLaunchRecord,
} from "../lead-launch/model.js";
import { randomUUID } from "node:crypto";
import { planProviderPreferencesMigration } from "../provider-preferences/migration.js";
import { sharedWorkflowProfileId } from "@getpaseo/protocol/provider-preferences";

import { QuotaReserveAdmissionError } from "../quota-reserve/admission.js";

import { TaskOwnerEvidenceStore } from "../../authorization/task-owner-evidence.js";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import { z } from "zod";

import { QuotaReservePolling } from "../quota-reserve/polling.js";

import { ProviderUsageService } from "../../../services/quota-fetcher/service.js";

import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";

const logger = createTestLogger();

function createRealAgentManager(storage: AgentStorage): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
}

async function removeRealAgentManagerWorkdir({
  agentManager,
  storage,
  workdir,
}: {
  agentManager: AgentManager;
  storage: AgentStorage;
  workdir: string;
}): Promise<void> {
  agentManager.prepareForShutdown();
  await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
  await agentManager.flushForShutdown();
  await storage.flush();
  rmSync(workdir, { recursive: true, force: true });
}

// Creates a worktree directory under repoRoot and reports it back as a fresh
// workspace so the command can stamp the agent with it (mirrors the production
// worktree service).
function fakeWorktreeCreator(args: { repoRoot: string; createdWorkspaceId: string }) {
  const worktreePath = join(args.repoRoot, "worktree");
  const workspaceCwd = join(worktreePath, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });
  return async (): Promise<CreatePaseoWorktreeWorkflowResult> =>
    ({
      worktree: { worktreePath },
      intent: {},
      workspace: { workspaceId: args.createdWorkspaceId, cwd: workspaceCwd },
      repoRoot: args.repoRoot,
      created: true,
    }) as unknown as CreatePaseoWorktreeWorkflowResult;
}

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const streamAgent = vi.fn(() => (async function* noop() {})());
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      reloadStalePluginSession: async () => {},
      streamAgent,
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-create-test",
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
  });

  expect(streamAgent).toHaveBeenCalledWith("agent-1", "hello from create", {
    clientMessageId: "msg-create-1",
  });
});

test("session create returns the created agent and ordinary provider first-turn error", async () => {
  const snapshot = {
    id: "agent-provider-failure",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const error = new Error("Provider first turn failed");
  const createAgent = vi.fn(async () => snapshot);
  const onCreated = vi.fn();
  const streamAgent = vi.fn(() => {
    throw error;
  });

  const result = await createAgentCommand(
    {
      agentManager: {
        createAgent,
        getAgent: vi.fn(() => snapshot),
        tryRunOutOfBand: vi.fn(() => false),
        reloadStalePluginSession: async () => {},
        streamAgent,
      } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
      agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    },
    {
      kind: "session",
      config: { provider: "codex", cwd: snapshot.cwd },
      workspaceId: "workspace-provider-failure",
      initialPrompt: "Start this task",
      clientMessageId: "message-provider-failure",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      onCreated,
    },
  );

  expect(createAgent).toHaveBeenCalledTimes(1);
  expect(onCreated).toHaveBeenCalledExactlyOnceWith({
    agentId: snapshot.id,
    createdWorktree: null,
  });
  expect(streamAgent).toHaveBeenCalledExactlyOnceWith(snapshot.id, "Start this task", {
    clientMessageId: "message-provider-failure",
  });
  expect(result).toEqual({
    snapshot,
    liveSnapshot: snapshot,
    initialPromptStarted: false,
    initialPromptError: error,
  });
});

test("MCP quota admission preserves log and throw failure modes", async () => {
  const snapshot = {
    id: "agent-mcp-quota-failure",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const error = new QuotaReserveAdmissionError("cruise");
  const promptLogger = createTestLogger();
  const logError = vi.spyOn(promptLogger, "error");
  const streamAgent = vi.fn();
  const prepareQuotaReserveAdmission = vi.fn(async () => {
    throw error;
  });
  const launch = (promptFailure: "log" | "throw") =>
    createAgentCommand(
      {
        agentManager: {
          createAgent: vi.fn(async () => snapshot),
          getAgent: vi.fn(() => snapshot),
          checkQuotaReserveLaunch: vi.fn(async () => {}),
          prepareQuotaReserveAdmission,
          streamAgent,
        } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
        agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
        logger: promptLogger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "mcp",
        provider: "codex",
        title: "Quota failure",
        cwd: snapshot.cwd,
        workspaceId: "workspace-mcp-quota-failure",
        config: {
          quotaReserve: {
            policy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
            state: { kind: "ready", revision: 0, changedAt: "2026-11-01T00:00:00.000Z" },
          },
        },
        initialPrompt: "Do not dispatch",
        notifyOnFinish: false,
        promptFailure,
      },
    );

  await expect(launch("log")).resolves.toEqual({
    snapshot,
    liveSnapshot: snapshot,
    initialPromptStarted: false,
    initialPromptError: null,
  });
  expect(logError).toHaveBeenCalledExactlyOnceWith(
    { err: error, agentId: snapshot.id },
    "Failed to run initial prompt",
  );
  logError.mockClear();

  await expect(launch("throw")).rejects.toBe(error);
  expect(logError).not.toHaveBeenCalled();
  expect(prepareQuotaReserveAdmission.mock.calls).toEqual([[snapshot.id], [snapshot.id]]);
  expect(streamAgent).not.toHaveBeenCalled();
});

test("session create validates the requested mode against the provider's modes", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(
    new Error("Invalid mode 'plan' for provider 'opencode'. Available modes: build, myplan"),
  );
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "plan" },
      workspaceId: "ws-create-test",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
    }),
  ).rejects.toThrow("Invalid mode 'plan'");

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "opencode",
      cwd: "/tmp/paseo-create-test",
      requestedMode: "plan",
    }),
  );
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create applies the resolved mode from the provider create config", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({
    modeId: "build",
    featureValues: { auto_accept: true },
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "build" },
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      modeId: "build",
      featureValues: { auto_accept: true },
    }),
    undefined,
    expect.anything(),
  );
});

test("mcp create accepts provider-only internal input and leaves model undefined", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async (input) => {
        expect(input.provider).toBe("claude");
        return {};
      }),
    } as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-create-test",
    title: "provider default",
    initialPrompt: "hello",
    notifyOnFinish: false,
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      model: undefined,
    }),
    undefined,
    expect.objectContaining({
      workspaceId: "ws-create-test",
    }),
  );
});

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-source");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
      },
    );

    const streamAgent = vi.spyOn(agentManager, "streamAgent");
    const { snapshot: child } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager,
        createPaseoWorktree: fakeWorktreeCreator({
          repoRoot: workdir,
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "child",
        initialPrompt: "do the thing",
        notifyOnFinish: false,
        callerAgentId: parent.id,
        worktree: { worktreeName: "feature", baseBranch: "main" },
      },
    );

    const clientMessageId = streamAgent.mock.calls[0]?.[2]?.clientMessageId;
    expect(z.uuid().safeParse(clientMessageId).success).toBe(true);
    expect(streamAgent).toHaveBeenCalledTimes(1);
    expect(streamAgent).toHaveBeenCalledWith(
      child.id,
      `<paseo-system version="1" kind="agent-message" source-agent-id="${parent.id}" message-id="${clientMessageId}">\ndo the thing\n</paseo-system>`,
      { origin: "agent", clientMessageId },
    );
    const storedChild = await storage.get(child.id);
    expect(storedChild?.workspaceId).toBe("ws-new-worktree");
    expect(child.cwd).toBe(join(workdir, "worktree", "packages", "app"));
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create exposes the created worktree before dispatching the initial prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-worktree-callback-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const createdWorktree = await fakeWorktreeCreator({
    repoRoot: workdir,
    createdWorkspaceId: "ws-created-worktree",
  })();
  let observed:
    | {
        createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
        lifecycle: ManagedAgent["lifecycle"] | null;
      }
    | undefined;

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return {};
          },
        },
        createPaseoWorktree: async () => createdWorktree,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "worktree callback",
        initialPrompt: "Say done.",
        notifyOnFinish: false,
        worktree: { worktreeName: "feature", baseBranch: "main" },
        onCreated: ({ agentId, createdWorktree: callbackWorktree }) => {
          observed = {
            createdWorktree: callbackWorktree,
            lifecycle: agentManager.getAgent(agentId)?.lifecycle ?? null,
          };
        },
      },
    );

    expect(observed).toEqual({ createdWorktree, lifecycle: "idle" });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("failed asynchronous owner evidence persistence prevents initial prompt dispatch", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-owner-evidence-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const starts: unknown[] = [];
  const agentManager = new AgentManager({
    clients: createTestAgentClients({
      onStartTurn: (prompt) => {
        starts.push(prompt);
      },
    }),
    registry: storage,
    logger,
  });
  try {
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        },
        {
          kind: "session",
          config: { provider: "codex", cwd: workdir },
          workspaceId: "workspace-evidence",
          initialPrompt: "Implement the approved change",
          labels: {},
          firstAgentContext: { attachments: [] },

          onCreated: async () => {
            await Promise.resolve();
            throw new Error("Owner evidence persistence failed");
          },
        },
      ),
    ).rejects.toThrow("Owner evidence persistence failed");
    expect(starts).toEqual([]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps the prompt title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Implement auth retries with backoff";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-title-source",
        initialPrompt: `${title}\n\ninclude tests`,
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps an explicit title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-explicit-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Explicit override";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir, title },
        workspaceId: "ws-explicit-title-source",
        initialPrompt: "Implement auth retries with backoff",
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create with an internal config skips provider session persistence", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };
  const input = {
    kind: "session" as const,
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
  };

  await createAgentCommand(dependencies, {
    ...input,
    config: { provider: "codex", cwd: "/tmp/paseo-create-test", internal: true },
  });
  await createAgentCommand(dependencies, {
    ...input,
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
  });

  expect(createAgent).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ provider: "codex", internal: true }),
    undefined,
    expect.objectContaining({ persistSession: false }),
  );
  expect(createAgent.mock.calls[1]?.[0]).not.toHaveProperty("internal");
  expect(createAgent.mock.calls[1]?.[2]).not.toHaveProperty("persistSession");
});

test.each([undefined, "agent"] as const)(
  "session create forwards message identity and origin %s",
  async (origin) => {
    const snapshot = {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/paseo-create-test",
      runtimeInfo: null,
    } as ManagedAgent;
    const streamAgent = vi.fn(() => (async function* noop() {})());
    const dependencies: Parameters<typeof createAgentCommand>[0] = {
      agentManager: {
        createAgent: vi.fn(async () => snapshot),
        getAgent: vi.fn(() => snapshot),
        tryRunOutOfBand: vi.fn(() => false),
        hasInFlightRun: vi.fn(() => false),
        reloadStalePluginSession: vi.fn(async () => {}),
        streamAgent,
        waitForAgentRunStart: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
      agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
      logger: createTestLogger(),
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    };

    await createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
      workspaceId: "ws-create-test",
      initialPrompt: "hello from create",
      origin,
      clientMessageId: "msg-create-1",

      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
    });

    expect(streamAgent).toHaveBeenCalledWith("agent-1", "hello from create", {
      clientMessageId: "msg-create-1",
      ...(origin ? { origin } : {}),
    });
  },
);

test("session create retains the workspace selected by worktree provisioning", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-new-worktree",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-new-worktree");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("top-level MCP creation records canonical agent origin without inventing a parent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "mcp-create-origin-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  try {
    const created = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "mcp",
        provider: "codex",
        title: "Machine-created task",
        cwd: workdir,
        workspaceId: "fixture-workspace",
        initialPrompt: "top-level machine instruction",
        background: false,
        notifyOnFinish: false,
      },
    );
    expect(created.initialPromptStarted).toBe(true);
    const messages = agentManager
      .getTimeline(created.snapshot.id)
      .filter((item) => item.type === "user_message");
    expect(messages).toMatchObject([
      {
        text: "top-level machine instruction",
        origin: "agent",
        clientMessageId: expect.any(String),
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(z.uuid().safeParse(messages[0].clientMessageId).success).toBe(true);
    expect(created.snapshot.labels).not.toHaveProperty(PARENT_AGENT_ID_LABEL);
    expect(await new TaskOwnerEvidenceStore(workdir).list(created.snapshot.id)).toEqual([]);
    expect(agentManager.listAgents()).toHaveLength(1);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

async function reserveLaunchHarness(remaining: (read: number) => number | null) {
  const workdir = mkdtempSync(join(tmpdir(), "reserve-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const starts: unknown[] = [];
  const agentManager = new AgentManager({
    clients: createTestAgentClients({
      onStartTurn: (prompt) => {
        starts.push(prompt);
      },
    }),
    registry: storage,
    logger,
  });
  let reads = 0;
  const usageService = new ProviderUsageService({
    logger,
    fetchers: [
      {
        providerId: "codex",
        displayName: "Codex",
        fetchUsage: async () => {
          reads += 1;
          return {
            providerId: "codex",
            displayName: "Codex",
            status: "available",
            planLabel: null,
            windows: [{ id: "weekly", label: "Weekly", remainingPct: remaining(reads) }],
            reserveWindowIds: ["weekly"],
          };
        },
      },
    ],
  });
  const polling = new QuotaReservePolling({ agentManager, usageService, logger });
  agentManager.setQuotaReserveObservationReader((provider) => polling.readForAdmission(provider));
  const created: string[] = [];
  const launch = () =>
    createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: {
          provider: "codex",
          cwd: workdir,
          quotaReservePolicy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
        },
        workspaceId: "reserve-workspace",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        initialPrompt: "First protected prompt",

        onCreated: ({ agentId }) => {
          created.push(agentId);
        },
      },
    );
  return {
    launch,
    starts,
    created,
    storage,
    agentManager,
    reads: () => reads,
    close: async () => {
      await polling.stop();
      await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
    },
  };
}

test("reserve launch checks quota before creation and durably refreshes before the first prompt", async () => {
  const harness = await reserveLaunchHarness(() => 50);
  try {
    const result = await harness.launch();
    expect(result.initialPromptStarted).toBe(true);
    expect(harness.reads()).toBe(2);
    expect(harness.starts).toEqual(["First protected prompt"]);
    expect(harness.created).toEqual([result.snapshot.id]);
    expect((await harness.storage.get(result.snapshot.id))?.config?.quotaReserve?.state.kind).toBe(
      "ready",
    );
  } finally {
    await harness.close();
  }
});

test.each([
  { remaining: 14, message: "Cruise Reserve" },
  { remaining: 15, message: "Cruise Reserve" },
  { remaining: 10, message: "Redline" },
  { remaining: null, message: "unavailable" },
])(
  "reserve launch at $remaining blocks before creating an agent",
  async ({ remaining, message }) => {
    const harness = await reserveLaunchHarness(() => remaining);
    try {
      await expect(harness.launch()).rejects.toThrow(message);
      expect(harness.reads()).toBe(1);
      expect(harness.starts).toEqual([]);
      expect(harness.created).toEqual([]);
      expect(harness.agentManager.listAgents()).toEqual([]);
      expect(await harness.storage.list()).toEqual([]);
    } finally {
      await harness.close();
    }
  },
);

test("a quota drop during creation reports the created agent for cleanup and never sends its prompt", async () => {
  const harness = await reserveLaunchHarness((read) => (read === 1 ? 50 : 14));
  try {
    await expect(harness.launch()).rejects.toThrow("Cruise Reserve");
    expect(harness.starts).toEqual([]);
    expect(harness.created).toHaveLength(1);
    const stored = await harness.storage.get(harness.created[0]!);
    expect(stored?.config?.quotaReserve?.state).toMatchObject({ kind: "held", reason: "cruise" });
  } finally {
    await harness.close();
  }
});

test("team dispatch uses the chosen account and preserves the frozen worker settings", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "worker-team-dispatch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = new AgentManager({
    clients: { codex: createTestAgentClient("codex"), backup: createTestAgentClient("backup") },
    registry: storage,
    logger,
  });
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;
  const worker = {
    id: "reviewer",
    name: "Reviewer",
    provider: "codex",
    model: "frozen",
    thinkingOptionId: "high",
  };
  const pickTeamWorkerAccount = vi.fn(async () => ({
    provider: "backup",
    reason: "alternate-usage-unreadable",
    droppedLowProviders: ["codex"],
    earliestResetAt: null,
  }));
  try {
    const parent = await agentManager.createAgent(
      {
        cwd: workdir,
        provider: "codex",
        profileLaunch: {
          profile: { id: "team", name: "Team", provider: "codex", workerProfileIds: [worker.id] },
          workers: [worker],
        },
      },
      undefined,
      { workspaceId: "ws-team" },
    );
    const settings = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers: { backup: { extends: "codex" } },
    });
    const dependencies = {
      agentManager,
      agentStorage: storage,
      logger,
      providerSnapshotManager,
      pickTeamWorkerAccount,
      getSharedProviderConfig: () => settings,
      serverId: "host",
    };
    const launch = {
      kind: "mcp" as const,
      callerAgentId: parent.id,
      title: "Review",
      profileId: worker.id,
      thinking: "override",
      notifyOnFinish: false,
    };
    const result = await createAgentCommand(dependencies, launch);
    expect(result.accountChoiceCode).toBe("alternate-usage-unreadable");
    expect(result.snapshot.config).toMatchObject({
      provider: "backup",
      model: "frozen",
      thinkingOptionId: "high",
    });
    expect(result.snapshot.labels[PARENT_AGENT_ID_LABEL]).toBe(parent.id);
    expect((await storage.get(result.snapshot.id))?.workerGovernance).toEqual({
      supervisorAgentId: parent.id,
      serverId: "host",
      workerProfileId: worker.id,
      accountChoice: { provider: "backup", reason: result.accountChoiceReason },
    });
    expect(pickTeamWorkerAccount).toHaveBeenCalledWith(
      expect.objectContaining({ worker, supervisorProvider: "codex" }),
    );
    await expect(
      createAgentCommand(dependencies, { ...launch, callerAgentId: result.snapshot.id }),
    ).rejects.toMatchObject({
      code: "team-worker-launch",
    });
    expect(agentManager.getAgent(result.snapshot.id)?.workerGovernance).toEqual(
      (await storage.get(result.snapshot.id))?.workerGovernance,
    );
    const reloaded = await agentManager.reloadAgentSession(result.snapshot.id);
    expect(reloaded.workerGovernance).toEqual(result.snapshot.workerGovernance);
    const readStorage = vi
      .spyOn(storage, "get")
      .mockRejectedValue(new Error("Storage unavailable"));
    try {
      await expect(
        createAgentCommand(dependencies, {
          ...launch,
          callerAgentId: result.snapshot.id,
          provider: "codex/frozen",
        }),
      ).rejects.toMatchObject({ code: "team-worker-launch" });
      expect(readStorage).not.toHaveBeenCalled();
    } finally {
      readStorage.mockRestore();
    }
    await expect(
      createAgentCommand(dependencies, { ...launch, callerAgentId: undefined }),
    ).rejects.toThrow("provider/model is required");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("a shared supervisor retains frozen worker values after inspecting installation context", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "shared-worker-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;
  try {
    const worker = {
      id: "shared-workflow/codex/worker",
      name: "Worker",
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: "medium",
    };
    const parent = await agentManager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
        profileLaunch: {
          configurationRevision: 8,
          profile: { id: "team", name: "Team", provider: "codex", workerProfileId: worker.id },
          worker,
        },
      },
      undefined,
      { workspaceId: "ws-shared-worker", owner: { kind: "user" } },
    );
    const getSharedProviderConfig = vi.fn(() => {
      return MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: false },
        agentProfiles: [{ ...worker, model: "changed-model" }],
      });
    });
    const validateSharedConfiguration = vi
      .fn()
      .mockRejectedValue(new Error("Frozen worker model is unavailable"));
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager,
          getSharedProviderConfig,
          validateSharedConfiguration,
        },
        {
          kind: "mcp",
          provider: "codex/gpt-5.4",
          profileId: worker.id,
          callerAgentId: parent.id,
          title: "Worker",
          background: true,
          notifyOnFinish: false,
        },
      ),
    ).rejects.toThrow("Frozen worker model is unavailable");
    expect(getSharedProviderConfig).toHaveBeenCalledTimes(1);
    expect(validateSharedConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        thinkingOptionId: "medium",
        profileLaunch: expect.objectContaining({ configurationRevision: 8 }),
      }),
    );
    expect(agentManager.listAgents()).toHaveLength(1);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("a managed worker follows its supervisor to another account of the same provider type only", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "worker-follows-supervisor-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const accounts = ["one", "two", "three", "other"];
  const agentManager = new AgentManager({
    clients: Object.fromEntries(accounts.map((id) => [id, createTestAgentClient(id)])),
    registry: storage,
    logger,
  });
  try {
    // The team launched on account one; its supervisors have since moved.
    const worker = {
      id: "shared-profile/codex/worker",
      name: "Worker",
      provider: "one",
      model: "gpt-5.4",
      thinkingOptionId: "medium",
    };
    const supervisorOn = (provider: string) =>
      agentManager.createAgent(
        {
          provider,
          cwd: workdir,
          profileLaunch: {
            profile: { id: "team", name: "Team", provider: "one", workerProfileId: worker.id },
            worker,
          },
        },
        undefined,
        { workspaceId: "worker-follows-workspace", owner: { kind: "user" } },
      );
    const sameType = await supervisorOn("two");
    const otherType = await supervisorOn("other");
    const settings = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers: {
        one: { extends: "codex" },
        two: { extends: "codex" },
        three: { extends: "codex" },
        other: { extends: "claude" },
      },
    });
    const launch = (
      callerAgentId: string,
      provider: string,
      profileId: string | undefined,
      launchLogger = logger,
    ) =>
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger: launchLogger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          getSharedProviderConfig: () => settings,
        },
        {
          kind: "mcp",
          provider,
          profileId,
          callerAgentId,
          title: "Worker",
          background: true,
          notifyOnFinish: false,
        },
      );
    const anotherAccount = "The selected workflow belongs to another account.";
    await expect(launch(sameType.id, "three/gpt-5.4", worker.id)).rejects.toThrow(anotherAccount);
    await expect(launch(otherType.id, "other/gpt-5.4", worker.id)).rejects.toThrow(anotherAccount);
    await expect(launch(sameType.id, "two/gpt-5.4", undefined)).rejects.toThrow(
      "must launch its configured worker preset",
    );

    // The refusal record never replaces the refusal, and never grows with the request.
    const records: unknown[] = [];
    const withWarn = (warn: (fields: unknown) => void) =>
      Object.assign(Object.create(logger), { warn }) as typeof logger;
    const failing = withWarn(() => {
      throw new Error("log sink failed");
    });
    const recording = withWarn((fields) => records.push(fields));
    const oversized = `three/${"x".repeat(5000)}`;
    await expect(launch(sameType.id, oversized, worker.id, failing)).rejects.toThrow(
      anotherAccount,
    );
    await expect(launch(sameType.id, oversized, worker.id, recording)).rejects.toThrow(
      anotherAccount,
    );
    expect(records).toEqual([expect.objectContaining({ refusalCode: "another-account" })]);
    expect(JSON.stringify(records).length).toBeLessThan(2000);
    expect(JSON.stringify(records)).not.toContain(anotherAccount);

    const followed = await launch(sameType.id, "two/requested-model", worker.id);
    expect(followed.snapshot.provider).toBe("two");
    expect(followed.snapshot.config).toMatchObject({
      model: "gpt-5.4",
      thinkingOptionId: "medium",
    });
    expect(agentManager.getAgent(sameType.id)?.config.profileLaunch?.worker).toEqual(worker);

    await agentManager.updateUsageLimitHold(followed.snapshot.id, () => ({
      stoppedAt: new Date().toISOString(),
    }));
    await expect(launch(sameType.id, "two/gpt-5.4", worker.id)).rejects.toThrow(
      "Quota exhausted on this account",
    );
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("new managed worker dispatch checks current installation exclusions and fails closed offline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "installation-worker-admission-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  try {
    const worker = {
      id: "shared-workflow/codex/worker",
      name: "Worker",
      provider: "codex",
      model: "gpt-5.4",
    };
    const parent = await agentManager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
        profileLaunch: {
          profile: { id: "team", name: "Team", provider: "codex", workerProfileId: worker.id },
          worker,
        },
      },
      undefined,
      { workspaceId: "worker-admission-workspace", owner: { kind: "user" } },
    );
    const cached = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      sharedProviderPreferences: {
        version: 1,
        revision: 1,
        legacyProfiles: {},
        providers: {},
        installation: {
          installationId: "00000000-0000-4000-8000-000000000001",
          environment: "host",
          serverId: "host",
          revision: 1,
        },
      },
    });
    const canonical = MutableDaemonConfigSchema.parse({
      ...cached,
      sharedProviderPreferences: {
        ...cached.sharedProviderPreferences,
        version: 1,
        revision: 2,
        legacyProfiles: {},
        providers: {
          codex: {
            defaults: {},
            preferredModels: [],
            preferredThinkingOptions: [],
            defaultWorkflowId: null,
            workflows: [{ ...worker, id: "worker", excludedEnvironments: ["host"] }],
          },
        },
      },
    }).sharedProviderPreferences;
    if (!canonical) throw new Error("missing canonical profiles");
    let offline = false;
    let reads = 0;
    const dependencies: Parameters<typeof createAgentCommand>[0] = {
      agentManager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: {
        resolveCreateConfig: async () => {
          throw new Error("Unexpected provider preparation");
        },
      },
      getSharedProviderConfig: () => cached,
      installationProfileReader: {
        read: async () => {
          reads++;
          if (offline) throw new Error("coordinator offline");
          return canonical;
        },
      },
    };
    const input: Parameters<typeof createAgentCommand>[1] = {
      kind: "mcp",
      provider: "codex/gpt-5.4",
      profileId: worker.id,
      callerAgentId: parent.id,
      title: "Worker",
      background: true,
      notifyOnFinish: false,
    };
    await expect(createAgentCommand(dependencies, input)).rejects.toThrow("excluded from the host");
    offline = true;
    await expect(createAgentCommand(dependencies, input)).rejects.toThrow("coordinator offline");
    expect(reads).toBe(2);
    expect(agentManager.listAgents().map((agent) => agent.id)).toEqual([parent.id]);
    expect(agentManager.getAgent(parent.id)?.config.profileLaunch?.worker).toEqual(worker);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("profileless installation tasks require fresh settings authority before registration", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "shared-skills-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const binding = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  let reads = 0;
  try {
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          getSharedProviderConfig: () => settings,
          installationSettingsReader: {
            async read(received) {
              expect(received).toEqual(binding);
              reads++;
              throw new Error("Coordinator offline");
            },
          },
        },
        {
          kind: "session",
          config: { provider: "codex", cwd: workdir },
          workspaceId: "shared-skills",
          initialPrompt: "Do not start",
          labels: {},
          provisionalTitle: null,
          firstAgentContext: { attachments: [] },
        },
      ),
    ).rejects.toThrow("Coordinator offline");
    expect(reads).toBe(1);
    expect(agentManager.listAgents()).toEqual([]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("a project's exclusions refuse launches in an excluded environment or with an excluded account", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "project-policy-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const binding = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: { codex: { enabled: true } },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const definitions = readInstallationProviders("host", settings.providers);
  const project = join(workdir, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  async function launch(policy: Record<string, unknown>) {
    return createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        getSharedProviderConfig: () => settings,
        installationSettingsReader: {
          async read() {
            return {
              ...binding,
              revision: 2,
              installationInstructions: "",
              settings: {
                ...readInstallationSettings(settings),
                skillLibrary: [],
                providerDefinitions: definitions,
                projectPolicies: { [project]: policy },
              },
            };
          },
        },
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: join(project, "src") },
        workspaceId: "project-policy",
        initialPrompt: "Do not start",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
      },
    );
  }
  try {
    await expect(launch({ excludedEnvironments: ["host"] })).rejects.toThrow(
      "This project is excluded from the Host environment",
    );
    await expect(launch({ providerIds: [definitions[0].id] })).rejects.toThrow(
      "This project excludes the selected account",
    );
    expect(agentManager.listAgents()).toEqual([]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("direct task creation cannot bypass an excluded provider using stale enabled local settings", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "shared-provider-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const binding = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: { codex: { enabled: true } },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const definitions = readInstallationProviders("host", settings.providers);
  try {
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          getSharedProviderConfig: () => settings,
          installationSettingsReader: {
            async read() {
              return {
                ...binding,
                revision: 2,
                installationInstructions: "",
                settings: {
                  ...readInstallationSettings(settings),
                  skillLibrary: [],
                  providerDefinitions: definitions,
                  resourceExclusions: {
                    host: {
                      terminalProfileIds: [],
                      metadataProviderIds: [],
                      providerIds: [definitions[0].id],
                    },
                  },
                },
              };
            },
          },
        },
        {
          kind: "session",
          config: { provider: "codex", cwd: workdir },
          workspaceId: "shared-provider",
          initialPrompt: "Do not start",
          labels: {},
          provisionalTitle: null,
          firstAgentContext: { attachments: [] },
        },
      ),
    ).rejects.toThrow("excluded from this environment");
    expect(agentManager.listAgents()).toEqual([]);
    expect(settings.providers.codex.enabled).toBe(true);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("account rebinding during authority lookup rejects the task before registration", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "shared-provider-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const binding = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  let settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: { codex: { enabled: true } },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const definitions = readInstallationProviders("host", settings.providers);
  try {
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          getSharedProviderConfig: () => settings,
          installationSettingsReader: {
            async read() {
              settings = MutableDaemonConfigSchema.parse({
                ...settings,
                providers: {
                  ...settings.providers,
                  codex: { ...settings.providers.codex, env: { CODEX_HOME: "/different-account" } },
                },
              });
              return {
                ...binding,
                revision: 2,
                installationInstructions: "",
                settings: {
                  ...readInstallationSettings(settings),
                  skillLibrary: [],
                  providerDefinitions: definitions,
                },
              };
            },
          },
        },
        {
          kind: "session",
          config: { provider: "codex", cwd: workdir },
          workspaceId: "shared-provider",
          initialPrompt: "Do not start",
          labels: {},
          provisionalTitle: null,
          firstAgentContext: { attachments: [] },
        },
      ),
    ).rejects.toThrow("changed during launch");
    expect(agentManager.listAgents()).toEqual([]);
    expect(settings.providers.codex.env).toEqual({ CODEX_HOME: "/different-account" });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("Codex skill snapshots read the CODEX_HOME the session launches with", () => {
  const providers = {
    codex: { env: { CODEX_HOME: "/base" } },
    "codex-account-own": { extends: "codex", env: { CODEX_HOME: "/account" } },
    "codex-account-inherits": { extends: "codex" },
  };
  const daemon = { CODEX_HOME: "/daemon" };
  // The account's own home wins, as in the registry's env merge.
  expect(launchCodexHome("codex", { providers }, "codex-account-own", daemon)).toBe("/account");
  // Without one, the extended provider's home is inherited before the daemon's.
  expect(launchCodexHome("codex", { providers }, "codex-account-inherits", daemon)).toBe("/base");
  const plain = { codex: {}, "codex-account-inherits": { extends: "codex" } };
  expect(launchCodexHome("codex", { providers: plain }, "codex-account-inherits", daemon)).toBe(
    "/daemon",
  );
  // Undefined lets the inventory use ~/.codex.
  expect(
    launchCodexHome("codex", { providers: plain }, "codex-account-inherits", {}),
  ).toBeUndefined();
  expect(launchCodexHome("claude", { providers }, "codex-account-own", daemon)).toBeUndefined();
});

test("an explicit empty account home stops inheritance and captures default-home skills", async () => {
  const home = mkdtempSync(join(tmpdir(), "create-empty-codex-home-"));
  try {
    const cwd = join(home, "project");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const parentHome = join(home, "parent");
    const daemonHome = join(home, "daemon");
    const defaultSkill = join(home, ".codex/skills/.system/openai-docs");
    for (const directory of [
      defaultSkill,
      join(parentHome, "skills/.system/openai-docs"),
      join(daemonHome, "skills/.system/openai-docs"),
    ]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "SKILL.md"),
        `---\nname: openai-docs\ndescription: ${directory}\n---\n`,
      );
    }
    const providers = {
      codex: { env: { CODEX_HOME: parentHome } },
      account: { extends: "codex", env: { CODEX_HOME: "" } },
    };
    // Launch preserves the empty child override; Codex itself then chooses its default home.
    const launchEnv = createProviderEnv({
      baseEnv: { CODEX_HOME: daemonHome },
      runtimeSettings: { env: { ...providers.codex.env, ...providers.account.env } },
    });
    expect(launchEnv.CODEX_HOME).toBe("");
    const codexHome = launchCodexHome("codex", { providers }, "account", {
      CODEX_HOME: daemonHome,
    });
    const inventory = await inventorySkills({ home, cwd });
    expect(inventory.skills.map((skill) => skill.path)).toEqual([defaultSkill]);
    const config: AgentSessionConfig = {
      provider: "account",
      cwd,
      profileLaunch: {
        profile: {
          id: "docs",
          name: "Docs",
          provider: "codex",
          skillPolicy: { mode: "selected", skills: [inventory.skills[0]!.identity] },
        },
      },
    };
    await captureSkillPolicy(config, "codex", { home, codexHome });
    expect(config.profileLaunch?.skillSnapshot?.skills.map((skill) => skill.path)).toEqual([
      await realpath(defaultSkill),
    ]);
    expect(codexHome).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  { value: "", expected: undefined },
  { value: " ", expected: " " },
  { value: "/literal path ", expected: "/literal path " },
])(
  "Codex home preserves literal paths and treats only empty as default: $value",
  ({ value, expected }) => {
    const providers = {
      codex: { env: { CODEX_HOME: "/base" } },
      middle: { extends: "codex", env: { CODEX_HOME: value } },
      account: { extends: "middle" },
    };
    expect(launchCodexHome("codex", { providers }, "account", { CODEX_HOME: "/daemon" })).toBe(
      expected,
    );
    expect(launchCodexHome("codex", undefined, "codex", { CODEX_HOME: value })).toBe(expected);
  },
);

test("Codex home follows multiple inherited providers and bounds cycles", () => {
  const providers = {
    codex: { env: { CODEX_HOME: "/base" } },
    middle: { extends: "codex" },
    account: { extends: "middle" },
  };
  expect(launchCodexHome("codex", { providers }, "account", { CODEX_HOME: "/daemon" })).toBe(
    "/base",
  );
  const cycle = { account: { extends: "middle" }, middle: { extends: "account" } };
  expect(launchCodexHome("codex", { providers: cycle }, "account", { CODEX_HOME: "/daemon" })).toBe(
    "/daemon",
  );
  expect(launchCodexHome("codex", { providers: cycle }, "account", {})).toBeUndefined();
  const overriddenCycle = { ...cycle, middle: { extends: "account", env: { CODEX_HOME: "" } } };
  expect(
    launchCodexHome("codex", { providers: overriddenCycle }, "account", { CODEX_HOME: "/daemon" }),
  ).toBeUndefined();
});

test.each(["ancestor", "missing"])("Codex home stops at a %s invalid chain entry", (entry) => {
  const providers = {
    codex: { env: { CODEX_HOME: "/base" } },
    middle: { extends: "codex" },
    account: { extends: "middle" },
  };
  // Exercise malformed runtime input without loosening the helper's configuration type.
  if (entry === "ancestor") Reflect.set(providers.middle, "env", { CODEX_HOME: 42 });
  if (entry === "missing") Reflect.set(providers.middle, "extends", "missing-provider");
  expect(launchCodexHome("codex", { providers }, "account", { CODEX_HOME: "/daemon" })).toBe(
    "/daemon",
  );
  expect(launchCodexHome("codex", { providers }, "account", {})).toBeUndefined();
});

test.each([undefined, "selected-workspace"])(
  "MCP background intent only applies when creating a workspace, selected=%s",
  async (workspaceId) => {
    const workdir = mkdtempSync(join(tmpdir(), "mcp-background-placement-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const manager = createRealAgentManager(storage);
    const ensureWorkspace = vi.fn(async () => "new-background-workspace");
    try {
      const created = await createAgentCommand(
        {
          agentManager: manager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          ensureWorkspaceForCreate: ensureWorkspace,
        },
        {
          kind: "mcp",
          provider: "codex",
          title: "Background task",
          cwd: workdir,
          workspaceId,
          background: true,
          notifyOnFinish: false,
        },
      );
      expect(created.snapshot.workspaceId).toBe(workspaceId ?? "new-background-workspace");
      if (workspaceId) expect(ensureWorkspace).not.toHaveBeenCalled();
      else
        expect(ensureWorkspace).toHaveBeenCalledWith(
          workdir,
          { prompt: "" },
          { callerWorkspaceId: undefined, background: true },
        );
    } finally {
      await removeRealAgentManagerWorkdir({ agentManager: manager, storage, workdir });
    }
  },
);

test("a lead on another preset starts once, only on the owner's choice, with the confirmed values", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "lead-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = new AgentManager({
    clients: { one: createTestAgentClient("one") },
    registry: storage,
    logger,
  });
  const delivered: string[] = [];
  agentManager.setMessageQueueControl({
    pause: vi.fn(),
    wake: vi.fn(),
    acceptedHistory: async () => [],
    recordProviderMessageId: vi.fn(),
    reconcileHistory: vi.fn(),
    suppressHistoryRestoration: vi.fn(),
    queueRestartContinuation: vi.fn(),
    queueQuestionAnswer: async (_agentId: string, _questionId: string, text: string) => {
      delivered.push(text);
    },
  } as unknown as Parameters<AgentManager["setMessageQueueControl"]>[0]);
  try {
    const worker = { id: "worker", name: "Worker", provider: "one", model: "gpt-5.4" };
    const profiles: Array<{
      id: string;
      name: string;
      provider: string;
      model: string;
      thinkingOptionId?: string;
      instructions?: string;
    }> = [
      { id: "lead", name: "Lead", provider: "one", model: "gpt-5.4", thinkingOptionId: "high" },
      { id: "worker", name: "Worker", provider: "one", model: "gpt-5.4" },
    ];
    const supervisor = await agentManager.createAgent(
      {
        provider: "one",
        cwd: workdir,
        profileLaunch: {
          profile: { id: "team", name: "Team", provider: "one", workerProfileId: worker.id },
          worker,
        },
      },
      undefined,
      { workspaceId: "ws-team", owner: { kind: "user" } },
    );
    const dependencies = {
      agentManager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      getAgentProfiles: () => profiles,
    };
    agentManager.setLeadLauncher((confirmed, record) =>
      startConfirmedLeadLaunch(dependencies, confirmed, record),
    );
    const request = async (): Promise<LeadLaunchRecord> => {
      const id = randomUUID();
      const prompt = "Lead the new workspace";
      const binding = await prepareLeadLaunch(
        dependencies,
        leadLaunchCreateInput({
          callerAgentId: supervisor.id,
          launchId: id,
          profileId: "lead",
          provider: "one",
          title: "Lead",
          initialPrompt: prompt,
          cwd: workdir,
          workspaceId: "ws-lead",
          leadLaunch: { phase: "prepare" },
        }),
      );
      const record: LeadLaunchRecord = {
        id,
        callerAgentId: supervisor.id,
        requestedAt: new Date().toISOString(),
        title: "Lead",
        reason: "Needs a stronger model",
        initialPrompt: prompt,
        options: [{ optionId: "requested", profileId: "lead", label: "Start on Lead", binding }],
        status: "pending",
      };
      await agentManager.requestLeadLaunch(
        supervisor.id,
        record,
        leadLaunchQuestion({
          record,
          callerTitle: "Coordinator",
          workerBinding: null,
          workspaceLabel: "lead",
          now: record.requestedAt,
        }),
      );
      return record;
    };
    const leads = () =>
      agentManager.listAgents().filter((agent) => agent.labels[LEAD_LAUNCH_ID_LABEL]);
    const answer = (questionId: string, optionIds?: string[], text = "Start on Lead") =>
      agentManager.answerQuestion(supervisor.id, {
        questionId,
        answer: text,
        answeredBy: "browser:owner",
        ...(optionIds ? { optionIds, source: "option" as const } : {}),
      });

    // create_agent still refuses the other preset and points to the confirmed route.
    await expect(
      createAgentCommand(dependencies, {
        kind: "mcp",
        provider: "one",
        profileId: "lead",
        callerAgentId: supervisor.id,
        title: "Lead",
        background: true,
        notifyOnFinish: false,
      }),
    ).rejects.toThrow("request_lead_launch");

    // Asking starts nothing, and the launch path refuses a record the owner has not claimed.
    const first = await request();
    expect(leads()).toEqual([]);
    // The card recommends nothing; the agent's requested escalation is not a default.
    const card = (await agentManager.readQuestions(supervisor.id)).find((q) => q.id === first.id);
    expect(card?.recommendedOptionIds).toBeUndefined();
    await expect(
      startConfirmedLeadLaunch(
        dependencies,
        { launchId: first.id, callerAgentId: supervisor.id, option: first.options[0]! },
        first,
      ),
    ).rejects.toThrow("not been confirmed");
    // Only a listed option counts; free text is never interpreted as consent.
    await expect(answer(first.id, ["alternative-9"])).rejects.toThrow();
    await expect(answer(first.id, undefined, "sure, go ahead")).rejects.toThrow();
    expect(leads()).toEqual([]);

    await answer(first.id, ["requested"]);
    await answer(first.id, ["requested"]);
    expect(leads()).toHaveLength(1);
    const lead = leads()[0]!;
    expect(lead.config).toMatchObject({
      provider: "one",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });
    expect(lead.config.profileLaunch?.profile.id).toBe("lead");
    expect(lead.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    expect(lead.workspaceId).toBe("ws-lead");
    expect(await agentManager.readLeadLaunch(supervisor.id, first.id)).toMatchObject({
      status: "launched",
      launchedAgentId: lead.id,
      approvedBy: "browser:owner",
    });
    expect(delivered.at(-1)).toContain(lead.id);

    // Two answers racing each other still claim the launch once.
    const concurrent = await request();
    await Promise.all([answer(concurrent.id, ["requested"]), answer(concurrent.id, ["requested"])]);
    expect(leads()).toHaveLength(2);

    // Any edit to the preset after the ask refuses the launch, including settings the card does
    // not display, such as the preset's instructions.
    const second = await request();
    profiles[0] = { ...profiles[0]!, instructions: "Also push to main." };
    await answer(second.id, ["requested"]);
    expect(leads()).toHaveLength(2);
    expect(await agentManager.readLeadLaunch(supervisor.id, second.id)).toMatchObject({
      status: "failed",
      failureCode: "lead-binding-changed",
    });

    // Withdrawing cancels the launch for good.
    const third = await request();
    await agentManager.mutateQuestions(supervisor.id, { operation: "withdraw", id: third.id });
    await expect(answer(third.id, ["requested"])).rejects.toThrow("withdrew");
    expect(await agentManager.readLeadLaunch(supervisor.id, third.id)).toMatchObject({
      status: "cancelled",
    });
    expect(leads()).toHaveLength(2);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("a supervisor's worker launching off the worker preset is logged by the preset fence", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "worker-hop-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = new AgentManager({
    clients: { one: createTestAgentClient("one") },
    registry: storage,
    logger,
  });
  try {
    const worker = { id: "worker", name: "Worker", provider: "one", model: "gpt-5.4" };
    const profiles = [worker, { id: "lead", name: "Lead", provider: "one", model: "gpt-5.5" }];
    const supervisor = await agentManager.createAgent(
      {
        provider: "one",
        cwd: workdir,
        profileLaunch: {
          profile: { id: "team", name: "Team", provider: "one", workerProfileId: worker.id },
          worker,
        },
      },
      undefined,
      { workspaceId: "ws-team", owner: { kind: "user" } },
    );
    // A worker preset never has a worker of its own, so the worker's create_agent is open.
    const child = await agentManager.createAgent({ provider: "one", cwd: workdir }, undefined, {
      workspaceId: "ws-team",
      labels: { [PARENT_AGENT_ID_LABEL]: supervisor.id },
      owner: { kind: "user" },
    });
    const warnings: Array<{ fields: unknown; message: unknown }> = [];
    const recording = Object.assign(Object.create(logger), {
      warn: (fields: unknown, message: unknown) => warnings.push({ fields, message }),
    }) as typeof logger;
    const launch = (profileId: string, detached: boolean) =>
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger: recording,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          getAgentProfiles: () => profiles,
        },
        {
          kind: "mcp",
          provider: "one",
          profileId,
          callerAgentId: child.id,
          title: "Hop",
          detached,
          background: true,
          notifyOnFinish: false,
        },
      );

    // Report-only for now: the hop still launches, but it is no longer silent.
    const hop = await launch("lead", true);
    expect(hop.snapshot.config.profileLaunch?.profile.id).toBe("lead");
    expect(warnings).toContainEqual({
      message: "Preset fence would refuse",
      fields: expect.objectContaining({
        path: "create_agent",
        reason: "preset-required",
        callerAgentId: child.id,
        supervisorAgentId: supervisor.id,
        workerProfileId: worker.id,
      }),
    });

    // A builder's attached reviewer on the supervisor's worker preset stays unflagged.
    warnings.length = 0;
    await launch(worker.id, false);
    expect(warnings).toEqual([]);

    // An idle coordinator is closed out of memory; its stored record still governs the worker.
    await agentManager.closeAgent(supervisor.id);
    expect(agentManager.getAgent(supervisor.id)).toBeNull();
    warnings.length = 0;
    await launch("lead", true);
    expect(warnings).toContainEqual({
      message: "Preset fence would refuse",
      fields: expect.objectContaining({
        reason: "preset-required",
        supervisorAgentId: supervisor.id,
      }),
    });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("an unrelated settings save between the ask and the click still launches the confirmed lead", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "lead-launch-unrelated-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = new AgentManager({
    clients: { one: createTestAgentClient("one") },
    registry: storage,
    logger,
  });
  agentManager.setMessageQueueControl({
    pause: vi.fn(),
    wake: vi.fn(),
    acceptedHistory: async () => [],
    recordProviderMessageId: vi.fn(),
    reconcileHistory: vi.fn(),
    suppressHistoryRestoration: vi.fn(),
    queueRestartContinuation: vi.fn(),
    queueQuestionAnswer: vi.fn(async () => {}),
  } as unknown as Parameters<AgentManager["setMessageQueueControl"]>[0]);
  try {
    const providers = { one: { extends: "codex" } };
    const { preferences } = planProviderPreferencesMigration({
      profiles: [
        { id: "lead", name: "Lead", provider: "one", model: "gpt-5.4", thinkingOptionId: "high" },
        { id: "other", name: "Other", provider: "one", model: "gpt-5.4" },
      ],
      providers,
    });
    let settings = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers,
      sharedProviderPreferences: preferences,
    });
    const worker = { id: "worker", name: "Worker", provider: "one", model: "gpt-5.4" };
    const supervisor = await agentManager.createAgent(
      {
        provider: "one",
        cwd: workdir,
        profileLaunch: {
          profile: { id: "team", name: "Team", provider: "one", workerProfileId: worker.id },
          worker,
        },
      },
      undefined,
      { workspaceId: "ws-team", owner: { kind: "user" } },
    );
    const dependencies = {
      agentManager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      getSharedProviderConfig: () => settings,
      validateSharedConfiguration: async () => [],
    };
    agentManager.setLeadLauncher((confirmed, record) =>
      startConfirmedLeadLaunch(dependencies, confirmed, record),
    );
    const id = randomUUID();
    const profileId = sharedWorkflowProfileId("one", "lead");
    const binding = await prepareLeadLaunch(
      dependencies,
      leadLaunchCreateInput({
        callerAgentId: supervisor.id,
        launchId: id,
        profileId,
        provider: "one",
        title: "Lead",
        initialPrompt: "Lead the new workspace",
        cwd: workdir,
        workspaceId: "ws-lead",
        leadLaunch: { phase: "prepare" },
      }),
    );
    const record: LeadLaunchRecord = {
      id,
      callerAgentId: supervisor.id,
      requestedAt: new Date().toISOString(),
      title: "Lead",
      reason: "Needs a stronger model",
      initialPrompt: "Lead the new workspace",
      options: [{ optionId: "requested", profileId, label: "Start on Lead", binding }],
      status: "pending",
    };
    await agentManager.requestLeadLaunch(
      supervisor.id,
      record,
      leadLaunchQuestion({
        record,
        callerTitle: "Coordinator",
        workerBinding: null,
        workspaceLabel: "lead",
        now: record.requestedAt,
      }),
    );

    // The owner saves a different preset, which bumps the shared preferences revision.
    const edited = structuredClone(preferences);
    edited.revision += 1;
    const other = edited.providers.codex!.workflows.find((workflow) => workflow.id === "other")!;
    other.thinkingOptionId = "low";
    settings = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers,
      sharedProviderPreferences: edited,
    });

    await agentManager.answerQuestion(supervisor.id, {
      questionId: id,
      answer: "Start on Lead",
      answeredBy: "browser:owner",
      optionIds: ["requested"],
      source: "option",
    });
    expect(await agentManager.readLeadLaunch(supervisor.id, id)).toMatchObject({
      status: "launched",
    });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("an unanswered lead launch expires after 24 hours, closes its card and starts nothing", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "lead-launch-expiry-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = new AgentManager({
    clients: { one: createTestAgentClient("one") },
    registry: storage,
    logger,
  });
  const delivered: string[] = [];
  agentManager.setMessageQueueControl({
    pause: vi.fn(),
    wake: vi.fn(),
    acceptedHistory: async () => [],
    recordProviderMessageId: vi.fn(),
    reconcileHistory: vi.fn(),
    suppressHistoryRestoration: vi.fn(),
    queueRestartContinuation: vi.fn(),
    queueQuestionAnswer: async (_agentId: string, _questionId: string, text: string) => {
      delivered.push(text);
    },
  } as unknown as Parameters<AgentManager["setMessageQueueControl"]>[0]);
  try {
    const worker = { id: "worker", name: "Worker", provider: "one", model: "gpt-5.4" };
    const profiles = [{ id: "lead", name: "Lead", provider: "one", model: "gpt-5.4" }];
    const supervisor = await agentManager.createAgent(
      {
        provider: "one",
        cwd: workdir,
        profileLaunch: {
          profile: { id: "team", name: "Team", provider: "one", workerProfileId: worker.id },
          worker,
        },
      },
      undefined,
      { workspaceId: "ws-team", owner: { kind: "user" } },
    );
    const dependencies = {
      agentManager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      getAgentProfiles: () => profiles,
    };
    agentManager.setLeadLauncher((confirmed, record) =>
      startConfirmedLeadLaunch(dependencies, confirmed, record),
    );
    const request = async (requestedAt: string): Promise<LeadLaunchRecord> => {
      const id = randomUUID();
      const binding = await prepareLeadLaunch(
        dependencies,
        leadLaunchCreateInput({
          callerAgentId: supervisor.id,
          launchId: id,
          profileId: "lead",
          provider: "one",
          title: "Lead",
          initialPrompt: "Lead the new workspace",
          cwd: workdir,
          workspaceId: "ws-lead",
          leadLaunch: { phase: "prepare" },
        }),
      );
      const record: LeadLaunchRecord = {
        id,
        callerAgentId: supervisor.id,
        requestedAt,
        title: "Lead",
        reason: "Needs a stronger model",
        initialPrompt: "Lead the new workspace",
        options: [{ optionId: "requested", profileId: "lead", label: "Start on Lead", binding }],
        status: "pending",
      };
      await agentManager.requestLeadLaunch(
        supervisor.id,
        record,
        leadLaunchQuestion({
          record,
          callerTitle: "Coordinator",
          workerBinding: null,
          workspaceLabel: "lead",
          now: requestedAt,
        }),
      );
      return record;
    };
    const leads = () =>
      agentManager.listAgents().filter((agent) => agent.labels[LEAD_LAUNCH_ID_LABEL]);
    const card = async (id: string) =>
      (await agentManager.readQuestions(supervisor.id)).find((question) => question.id === id);

    // The hourly sweep closes a request past 24 hours and tells the coordinator to ask again.
    const swept = await request(new Date().toISOString());
    await agentManager.expireLeadLaunches(Date.now() + 25 * 60 * 60_000);
    expect(await agentManager.readLeadLaunch(supervisor.id, swept.id)).toMatchObject({
      status: "cancelled",
      failureCode: "expired",
    });
    expect(await card(swept.id)).toMatchObject({
      status: "answered",
      answeredBy: "daemon:lead-launch-expiry",
    });
    expect(delivered.at(-1)).toContain("expired after 24 hours");

    // An owner click that arrives after the limit, before the sweep, starts nothing either.
    const late = await request(new Date(Date.now() - 25 * 60 * 60_000).toISOString());
    await expect(
      agentManager.answerQuestion(supervisor.id, {
        questionId: late.id,
        answer: "Start on Lead",
        answeredBy: "browser:owner",
        optionIds: ["requested"],
        source: "option",
      }),
    ).rejects.toThrow("expired");
    expect((await card(late.id))?.answeredBy).toBe("daemon:lead-launch-expiry");
    expect(leads()).toEqual([]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});
