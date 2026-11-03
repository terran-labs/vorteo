import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { startAgentRun } from "./agent-prompt.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, { purpose: "interactive" }]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming a stored agent keeps its unread flag and its last-activity time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-resume-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000401";
  const lastActive = "2026-01-02T03:04:05.000Z";
  const markedUnread = "2026-01-09T03:04:05.000Z";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-a",
    });
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected a stored agent");
    }
    // The agent finished days ago, and was marked unread later without being opened, which
    // moves `updatedAt` on its own. Clients already hold that newer time, and
    // `acceptAgentDirectoryUpdate` drops anything older, so the resumed agent must not come
    // back carrying only `lastActivityAt`.
    await storage.upsert({
      ...stored,
      updatedAt: markedUnread,
      lastActivityAt: lastActive,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: lastActive,
    });

    await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
    await manager.flush();
    await storage.flush();

    // Loading the runtime is neither the agent working nor the user reading the chat.
    // Forging either rewrites the workspace's "last used" and drops it out of Ready to review.
    const resumed = await storage.get(agentId);
    expect(resumed?.requiresAttention).toBe(true);
    expect(resumed?.attentionReason).toBe("finished");
    expect(resumed?.updatedAt).toBe(markedUnread);
    expect(resumed?.lastActivityAt).toBe(markedUnread);
    expect(manager.getAgent(agentId)?.attention.requiresAttention).toBe(true);
    expect(manager.getAgent(agentId)?.updatedAt.toISOString()).toBe(markedUnread);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("loads an archived agent's history after its working directory is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-missing-cwd-"));
  const worktree = path.join(root, "managed-worktree");
  await mkdir(worktree, { recursive: true });
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000501";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: worktree }, agentId, {
      workspaceId: "workspace-worktree",
    });
    await startAgentRun(manager, agent.id, "what did you change", logger, {});
    // Dispatching a run does not finish it: the provider appends the reply to its
    // history afterwards, and the turn is finalized only once that append lands.
    // Archive after the turn is finalized so the transcript this test reads back is
    // already on disk when the worktree goes away.
    const finished = await manager.waitForAgentEvent(agent.id);
    expect(finished.status).toBe("idle");
    await manager.archiveAgent(agent.id);
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    // Archiving the workspace removes the worktree it owned. The agent's history is
    // persisted and reading it must not depend on that directory still being there.
    await rm(worktree, { recursive: true, force: true });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(loaded.id).toBe(agentId);
    // The transcript is replayed from the provider's persisted history, so the reply the
    // agent gave before the worktree went away is still readable.
    const replies = manager
      .getTimeline(agentId)
      .filter((item) => item.type === "assistant_message");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((item) => item.type === "assistant_message" && item.text.length > 0)).toBe(
      true,
    );
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

interface FlakyHistoryClient {
  client: AgentClient;
  historyReads: () => number;
  failNextReads: (count: number) => void;
  holdNextRead: () => () => void;
}

function createFlakyHistoryClient(baseClient: AgentClient): FlakyHistoryClient {
  let reads = 0;
  let failures = 0;
  let gate: Promise<void> | null = null;
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (config, launchContext) =>
      await baseClient.createSession(config, launchContext),
    resumeSession: async (handle, overrides, launchContext, options) => {
      const session = await baseClient.resumeSession(handle, overrides, launchContext, options);
      const readHistory = session.streamHistory.bind(session);
      session.streamHistory = async function* () {
        reads += 1;
        if (gate) {
          const held = gate;
          gate = null;
          await held;
        }
        if (failures > 0) {
          failures -= 1;
          throw new Error("Session host connection closed.");
        }
        yield* readHistory();
      };
      return session;
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  return {
    client,
    historyReads: () => reads,
    failNextReads: (count) => {
      failures = count;
    },
    holdNextRead: () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

function replyText(items: ReturnType<AgentManager["getTimeline"]>): string {
  return items.map((item) => (item.type === "assistant_message" ? item.text : "")).join("");
}

/** Records a finished turn, then drops the manager the way a daemon restart does. */
async function createStoredAgentWithReply(params: {
  client: AgentClient;
  storage: AgentStorage;
  agentId: string;
  cwd: string;
}): Promise<number> {
  const { client, storage, agentId, cwd } = params;
  const logger = createTestLogger();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agent = await manager.createAgent({ provider: "codex", cwd }, agentId, {
    workspaceId: "workspace-history",
  });
  await startAgentRun(manager, agent.id, "summarize the change", logger, {});
  const finished = await manager.waitForAgentEvent(agent.id);
  expect(finished.status).toBe("idle");
  const rowCount = manager.getTimeline(agent.id).length;
  await manager.closeAgent(agent.id);
  await manager.flush();
  await storage.flush();
  return rowCount;
}

test("a registered agent whose history failed to load retries it on the next load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-history-retry-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("expected Codex test client");
  const flaky = createFlakyHistoryClient(baseClient);
  const manager = new AgentManager({ clients: { codex: flaky.client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000601";
  const deps = { agentManager: manager, agentStorage: storage, logger };

  try {
    const rowCount = await createStoredAgentWithReply({
      client: baseClient,
      storage,
      agentId,
      cwd: root,
    });
    expect(rowCount).toBeGreaterThan(0);

    flaky.failNextReads(2);
    await expect(ensureAgentLoaded(agentId, deps)).rejects.toThrow("Session host connection");
    // Resume registered the agent before its history read failed.
    expect(manager.getAgent(agentId)).not.toBeNull();
    expect(manager.getTimeline(agentId)).toEqual([]);
    expect(manager.needsTimelineHydration(agentId)).toBe(true);

    await expect(ensureAgentLoaded(agentId, deps)).rejects.toThrow("Session host connection");
    expect(flaky.historyReads()).toBe(2);

    await ensureAgentLoaded(agentId, deps);
    expect(flaky.historyReads()).toBe(3);
    expect(manager.getTimeline(agentId)).toHaveLength(rowCount);
    expect(manager.fetchTimeline(agentId).rows.length).toBeGreaterThan(0);
    expect(manager.needsTimelineHydration(agentId)).toBe(false);

    // Primed agents return from memory without another provider read.
    await ensureAgentLoaded(agentId, deps);
    expect(flaky.historyReads()).toBe(3);
    expect(manager.getTimeline(agentId)).toHaveLength(rowCount);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent loads share one history retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-history-concurrent-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("expected Codex test client");
  const flaky = createFlakyHistoryClient(baseClient);
  const manager = new AgentManager({ clients: { codex: flaky.client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000602";
  const deps = { agentManager: manager, agentStorage: storage, logger };

  try {
    const rowCount = await createStoredAgentWithReply({
      client: baseClient,
      storage,
      agentId,
      cwd: root,
    });

    flaky.failNextReads(1);
    await expect(ensureAgentLoaded(agentId, deps)).rejects.toThrow("Session host connection");

    const release = flaky.holdNextRead();
    const first = ensureAgentLoaded(agentId, deps);
    const second = ensureAgentLoaded(agentId, deps);
    release();
    const [firstAgent, secondAgent] = await Promise.all([first, second]);

    expect(firstAgent.id).toBe(agentId);
    expect(secondAgent.id).toBe(agentId);
    expect(flaky.historyReads()).toBe(2);
    expect(manager.getTimeline(agentId)).toHaveLength(rowCount);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a retry after new turns replaces the partial timeline with the full history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-history-partial-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("expected Codex test client");
  const flaky = createFlakyHistoryClient(baseClient);
  const manager = new AgentManager({ clients: { codex: flaky.client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000603";
  const deps = { agentManager: manager, agentStorage: storage, logger };

  try {
    await createStoredAgentWithReply({ client: baseClient, storage, agentId, cwd: root });

    flaky.failNextReads(1);
    await expect(ensureAgentLoaded(agentId, deps)).rejects.toThrow("Session host connection");

    // The owner keeps chatting: only the new turn reaches the in-memory timeline.
    await startAgentRun(manager, agentId, "and the tests?", logger, {});
    const running = manager.waitForAgentEvent(agentId);
    // A run in flight may hold rows the provider has not written yet.
    expect(manager.needsTimelineHydration(agentId)).toBe(false);
    expect((await running).status).toBe("idle");
    const partialText = replyText(manager.getTimeline(agentId));
    expect(partialText).not.toBe("");
    const partialEpoch = manager.fetchTimeline(agentId).epoch;
    expect(manager.needsTimelineHydration(agentId)).toBe(true);

    await ensureAgentLoaded(agentId, deps);
    // Both turns give the fake's same reply; the replay restores the earlier one too.
    expect(replyText(manager.getTimeline(agentId))).toBe(partialText.repeat(2));
    expect(manager.fetchTimeline(agentId).epoch).not.toBe(partialEpoch);
    expect(manager.needsTimelineHydration(agentId)).toBe(false);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
