import { planProviderPreferencesMigration } from "../agent/provider-preferences/migration.js";
import { sharedProfileId } from "@getpaseo/protocol/provider-preferences";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import {
  delegateToContainer,
  DelegationRequestSchema,
  type DelegationClient,
} from "../execution-installation/delegation.js";
import { TaskOwnerEvidenceStore } from "../authorization/task-owner-evidence.js";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import type { z } from "zod";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { WebSocket } from "ws";
import { SessionInboundMessageSchema, WSOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import pino from "pino";
import type { CreationSnapshot, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function createCreationDaemon(options: Parameters<typeof createTestPaseoDaemon>[0] = {}) {
  const agentClients = options.agentClients ?? createTestAgentClients();
  return createTestPaseoDaemon({
    ...options,
    agentClients,
    // Installed provider CLIs must not change when background naming starts.
    providerOverrides: Object.fromEntries(
      BUILTIN_PROVIDER_IDS.map((id) => [id, { enabled: id in agentClients }]),
    ),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("creation progresses before agent readiness and continues after the disconnected Session is cleaned up", async () => {
  const provider = deferred<void>();
  const ready = deferred<CreationSnapshot>();
  const disconnected = deferred<void>();
  const cleaned = deferred<void>();
  const directory = await mkdtemp(join(tmpdir(), "creation-wire-"));
  let agents = 0;
  let prompts = 0;
  const daemon = await createCreationDaemon({
    logger: pino(
      { level: "trace" },
      {
        write(line) {
          const { msg } = JSON.parse(line);
          if (msg === "Client disconnected; waiting for reconnect") disconnected.resolve();
          if (msg === "agent.session.lifecycle.cleanup") cleaned.resolve();
        },
      },
    ),
    agentClients: createTestAgentClients({
      // Workspace naming uses internal sessions through the same fake clients.
      beforeCreateSession: async (config) => {
        if (config.internal) return;
        agents++;
        await provider.promise;
      },
      onStartTurn: (_prompt, config) => {
        if (config.internal) return;
        prompts++;
      },
    }),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.7.2",
    clientId: "creation-subscriber",
  });
  const observer = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.7.2",
    clientId: "creation-independent-observer",
  });
  const observerMessages: SessionOutboundMessage[] = [];
  const unsubscribe = observer.subscribeRawMessages((message) => observerMessages.push(message));
  const workspaceId = "wks_0123456789abcdef";
  const agentId = randomUUID();
  const request = {
    idempotencyKey: "workspace-one",
    workspaceId,
    source: { kind: "directory" as const, path: directory },
    agent: {
      agentId,
      provider: "codex",
      cwd: directory,
      initialPrompt: "Create once",
      clientMessageId: "initial-one",
    },
  };
  try {
    await client.connect();
    await observer.connect();
    const first = client.createWorkspace({
      ...request,
      onEvent: (snapshot) => {
        if (snapshot.phase === "workspace_ready") ready.resolve(snapshot);
      },
    });
    void first.catch(() => undefined);
    const snapshot = await ready.promise;
    expect(snapshot).toMatchObject({ workspaceId, agentId, phase: "workspace_ready" });
    expect((await observer.fetchAgents()).entries).toHaveLength(0);
    expect(
      observerMessages.filter((message) => message.type === "workspace.create.update"),
    ).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await client.close();
    await disconnected.promise;
    await vi.advanceTimersByTimeAsync(90_000);
    await cleaned.promise;
    vi.useRealTimers();
    await expect(first).rejects.toThrow("closed");
    // A disconnected form cannot prevent the provider or initial prompt from starting.
    provider.resolve();
    await expect.poll(() => prompts).toBe(1);
    const replay = await observer.createWorkspace(request);
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(workspaceId);
    expect(replay.agent?.id).toBe(agentId);
    expect(replay.agent?.title).toBe("Create once");
    expect(agents).toBe(1);
    expect(prompts).toBe(1);
    const conflict = await observer.createWorkspace({
      ...request,
      idempotencyKey: "another-intent",
    });
    expect(conflict.error).toBe("workspace_id_conflict");
    expect(agents).toBe(1);
  } finally {
    vi.useRealTimers();
    provider.resolve();
    unsubscribe();
    await client.close();
    await observer.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

async function connectCreationPeer(port: number) {
  const timeout = 30_000;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: SessionOutboundMessage[] = [];
  socket.on("message", (data) => {
    const frame = WSOutboundMessageSchema.parse(JSON.parse(data.toString()));
    if (frame.type === "session") frames.push(frame.message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      clientType: "browser",
      clientId: randomUUID(),
      protocolVersion: 1,
      appVersion: "0.8.0",
    }),
  );
  await expect
    .poll(() => frames.some((m) => m.type === "status" && m.payload.status === "server_info"), {
      timeout,
    })
    .toBe(true);
  return {
    close: () => socket.close(),
    closeAndWait: async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, "close", { signal: AbortSignal.timeout(5_000) });
      socket.close();
      await closed;
    },
    request: async (
      message: z.input<typeof SessionInboundMessageSchema> & { requestId: string },
    ) => {
      socket.send(JSON.stringify({ type: "session", message }));
      const response = () =>
        frames.find(
          (m) =>
            "payload" in m && "requestId" in m.payload && m.payload.requestId === message.requestId,
        );
      await expect.poll(response, { timeout }).toBeDefined();
      return response()!;
    },
  };
}

test.each([false, true])(
  "workspace identity does not depend on subscribing (first subscribe=%s)",
  async (subscribe) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-identity-"));
    const daemon = await createCreationDaemon();
    const peer = await connectCreationPeer(daemon.port);
    try {
      const request = {
        type: "workspace.create.request" as const,
        source: { kind: "directory" as const, path: directory },
        idempotencyKey: "same-workspace",
      };
      const first = await peer.request({ ...request, requestId: "first", subscribe });
      const replay = await peer.request({ ...request, requestId: "replay", subscribe: !subscribe });
      if (first.type !== "workspace.create.response" || replay.type !== "workspace.create.response")
        throw new Error("Expected workspace responses");
      expect(first.payload.error).toBeNull();
      expect(replay.payload.error).toBeNull();
      expect(replay.payload.workspace?.id).toBe(first.payload.workspace?.id);
    } finally {
      peer.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60000,
);

test.each(["create_agent_request", "agent.create.request"] as const)(
  "legacy and modern agent RPCs share one creation identity (first %s)",
  async (type) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-agent-identity-"));
    let creations = 0;
    const daemon = await createCreationDaemon({
      agentClients: createTestAgentClients({
        beforeCreateSession: async (config) => {
          if (config.internal) return;
          creations++;
          // A real provider or Git checkout may take longer than Vitest's default 1s poll budget.
          await new Promise((resolve) => setTimeout(resolve, 1_200));
        },
      }),
    });
    const peer = await connectCreationPeer(daemon.port);
    try {
      const request = {
        config: { provider: "codex", cwd: directory },
        idempotencyKey: "same-agent",
      };
      const first = await peer.request({ ...request, type, requestId: "first" });
      const replay = await peer.request({
        ...request,
        type: type === "agent.create.request" ? "create_agent_request" : "agent.create.request",
        requestId: "replay",
      });
      const createdAgent = (message: SessionOutboundMessage) => {
        if (message.type === "agent.create.response") {
          expect(message.payload.error).toBeNull();
          return message.payload.agent;
        }
        if (message.type === "status" && message.payload.status === "agent_created")
          return message.payload.agent;
        throw new Error(`Unexpected creation result ${JSON.stringify(message)}`);
      };
      expect(createdAgent(replay)?.id).toBe(createdAgent(first)?.id);
      const agentId = createdAgent(first)!.id;
      await daemon.daemon.agentManager.setTitle(agentId, "Updated after creation");
      await daemon.daemon.agentManager.flush();
      const legacyReplay = await peer.request({
        ...request,
        type: "create_agent_request",
        requestId: "legacy-after-update",
      });
      expect(createdAgent(legacyReplay)?.title).toBe("Updated after creation");
      expect(creations).toBe(1);
    } finally {
      peer.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60000,
);

test("legacy keyed creation preserves checkout error codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creation-checkout-error-"));
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: directory, stdio: "pipe" },
  );
  const daemon = await createCreationDaemon({ agentClients: createTestAgentClients() });
  const peer = await connectCreationPeer(daemon.port);
  try {
    const result = await peer.request({
      type: "create_agent_request",
      requestId: "missing-branch",
      idempotencyKey: "missing-branch",
      config: { provider: "codex", cwd: directory },
      worktree: { mode: "checkout-branch", branch: "does-not-exist" },
    });
    expect(result).toMatchObject({
      type: "status",
      payload: { status: "agent_create_failed", errorCode: "unknown_branch" },
    });
  } finally {
    peer.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

test.each(["agent", "workspace"] as const)(
  "%s creation succeeds when the provider rejects its initial prompt",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-prompt-rejected-"));
    const rejection = "Input exceeds the maximum length of 1048576 characters.";
    let sessions = 0;
    let prompts = 0;
    const daemon = await createCreationDaemon({
      agentClients: createTestAgentClients({
        beforeCreateSession: async (config) => {
          if (config.internal) return;
          sessions++;
        },
        onStartTurn: (_prompt, config) => {
          if (config.internal) return;
          prompts++;
          throw new Error(rejection);
        },
      }),
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.11.1",
    });
    const snapshots: CreationSnapshot[] = [];
    const agent = {
      config: { provider: "codex", cwd: directory },
      initialPrompt: "Continue the attached conversation.",
      clientMessageId: "draft:initial-message",
    };
    const streamed: AgentTimelineItem[] = [];
    const unsubscribe = daemon.daemon.agentManager.subscribe((event) => {
      if (event.type === "agent_stream" && event.event.type === "timeline") {
        streamed.push(event.event.item);
      }
    });
    try {
      await client.connect();
      const submit = async () => {
        const common = {
          idempotencyKey: "rejected-first-prompt",
          onEvent: (snapshot: CreationSnapshot) => snapshots.push(snapshot),
        };
        if (kind === "agent") return client.createAgent({ ...common, ...agent });
        const result = await client.createWorkspace({
          ...common,
          source: { kind: "directory", path: directory },
          agent,
        });
        expect(result.error).toBeNull();
        return result.agent!;
      };
      const created = await submit();
      expect(created).toMatchObject({ status: "error", lastError: rejection });
      expect(snapshots.map((snapshot) => snapshot.phase)).not.toContain("prompt_started");
      expect(snapshots.at(-1)).toMatchObject({
        phase: "completed",
        error: null,
        agent: { id: created.id },
      });
      const expectedTimeline = [
        {
          type: "user_message",
          text: agent.initialPrompt,
          clientMessageId: agent.clientMessageId,
          messageId: agent.clientMessageId,
        },
        { type: "assistant_message", text: `[System Error] ${rejection}` },
      ];
      expect(
        (await client.fetchAgentTimeline(created.id)).entries.map((entry) => entry.item),
      ).toEqual(expectedTimeline);
      expect(streamed).toEqual(expectedTimeline);
      expect((await submit()).id).toBe(created.id);
      expect(
        (await client.fetchAgentTimeline(created.id)).entries.map((entry) => entry.item),
      ).toEqual(expectedTimeline);
      expect((await client.fetchAgents()).entries).toHaveLength(1);
      expect({ sessions, prompts }).toEqual({ sessions: 1, prompts: 1 });
    } finally {
      unsubscribe();
      await client.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60000,
);

test("combined worktree and agent creation owns setup on the workspace and replays one identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-owned-setup-"));
  const daemon = await createCreationDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await initializeSetupRepository(directory);
    await client.connect();
    const input = {
      idempotencyKey: "combined-workspace-setup",
      source: { kind: "worktree" as const, cwd: directory, worktreeSlug: "combined-setup" },
      agent: { config: { provider: "codex", cwd: directory } },
    };
    const first = await client.createWorkspace(input);
    const replay = await client.createWorkspace(input);
    expect(first.error).toBeNull();
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(first.workspace?.id);
    expect(replay.agent?.id).toBe(first.agent?.id);
    if (!first.workspace || !first.agent) throw new Error("Expected combined creation resources");
    const observation = client.observeWorkspaceSetup(first.workspace.id);
    await observation.ready;
    await expect
      .poll(async () => (await client.fetchWorkspaceSetupStatus(first.workspace!.id)).snapshot, {
        timeout: 10000,
      })
      .toMatchObject({
        status: "completed",
        detail: {
          log: "",
          commands: [
            expect.objectContaining({
              log: expect.stringContaining("workspace setup output\n"),
              status: "completed",
            }),
          ],
        },
      });
    await observation.release();
    expect(await readFile(join(first.workspace.workspaceDirectory!, "setup-runs"), "utf8")).toBe(
      "once\n",
    );
    const timeline = await client.fetchAgentTimeline(first.agent.id);
    expect(
      timeline.entries.map((entry) => entry.item).filter((item) => item.type === "tool_call"),
    ).toEqual([]);
    expect(first.agent.workspaceId).toBe(first.workspace.id);
    const conflict = await client.createWorkspace({
      ...input,
      source: { ...input.source, worktreeSlug: "different-intent" },
    });
    expect(conflict.error).toBe("workspace_request_key_conflict");
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

test.each(["create_agent_request", "agent.create.request"] as const)(
  "%s rejects mixed canonical worktree and legacy placement at the wire boundary",
  async (type) => {
    const directory = await mkdtemp(join(tmpdir(), "agent-worktree-rejected-"));
    const daemon = await createCreationDaemon();
    const peer = await connectCreationPeer(daemon.port);
    try {
      for (const placement of [{ git: { createWorktree: true } }, { worktreeName: "legacy" }]) {
        const response = await peer.request({
          type,
          requestId: randomUUID(),
          config: { provider: "codex", cwd: directory },
          ...placement,
          worktree: { mode: "branch-off", newBranch: "canonical" },
        });
        if (response.type !== "agent.create.response" && response.type !== "status")
          throw new Error("Expected agent creation response");
        const error = response.payload.error;
        expect(error).toContain("cannot be combined");
      }
    } finally {
      peer.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function initializeSetupRepository(directory: string): Promise<void> {
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  await writeFile(
    join(directory, "paseo.json"),
    JSON.stringify({
      worktree: {
        setup: [
          "node -e \"require('fs').appendFileSync('setup-runs', 'once\\n'); console.log('workspace setup output')\"",
        ],
      },
    }),
  );
  execFileSync("git", ["add", "paseo.json"], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "setup fixture",
    ],
    { cwd: directory, stdio: "pipe" },
  );
}

test("Hub-shaped keyed agent worktree creation uses workspace setup and preserves resource identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keyed-agent-workspace-setup-"));
  const daemon = await createCreationDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const peer = await connectCreationPeer(daemon.port);
  try {
    await initializeSetupRepository(directory);
    await client.connect();
    const input = {
      type: "create_agent_request" as const,
      idempotencyKey: "keyed-agent-worktree",
      config: { provider: "codex", cwd: directory },
      worktree: { mode: "branch-off" as const, newBranch: "keyed-agent-setup", base: "main" },
    };
    const first = await peer.request({ ...input, requestId: "first" });
    const replay = await peer.request({ ...input, requestId: "replay" });
    if (
      first.type !== "status" ||
      first.payload.status !== "agent_created" ||
      replay.type !== "status" ||
      replay.payload.status !== "agent_created"
    )
      throw new Error("Expected agent creation responses");
    expect(replay.payload.agent.id).toBe(first.payload.agent.id);
    expect(replay.payload.agent.workspaceId).toBe(first.payload.agent.workspaceId);
    const agent = first.payload.agent;
    if (!agent.workspaceId) throw new Error("Expected agent workspace ownership");
    await expect
      .poll(async () => (await client.fetchWorkspaceSetupStatus(agent.workspaceId!)).snapshot, {
        timeout: 10000,
      })
      .toMatchObject({
        status: "completed",
        detail: {
          log: "",
          commands: [
            expect.objectContaining({ log: expect.stringContaining("workspace setup output\n") }),
          ],
        },
      });
    expect(await readFile(join(agent.cwd, "setup-runs"), "utf8")).toBe("once\n");
    expect(
      (await client.fetchAgentTimeline(agent.id)).entries
        .map((entry) => entry.item)
        .filter((item) => item.type === "tool_call"),
    ).toEqual([]);
    const conflict = await peer.request({
      ...input,
      requestId: "conflict",
      worktree: { ...input.worktree, newBranch: "different-intent" },
    });
    expect(conflict).toMatchObject({
      type: "status",
      payload: { status: "agent_create_failed", error: "agent_request_key_conflict" },
    });
  } finally {
    peer.close();
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

test("delegated creation and messages retain attribution without becoming owner evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegated-provenance-"));
  const daemon = await createTestPaseoDaemon({
    auth: { password: "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76" },
    agentClients: createTestAgentClients(),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    password: "shared-secret",
  });
  try {
    await client.connect();
    const workspace = await client.createWorkspace({
      source: { kind: "directory", path: directory },
    });
    expect(workspace.error).toBeNull();
    const ownerCreated = await client.createAgent({
      provider: "codex",
      cwd: directory,
      workspaceId: workspace.workspace!.id,
      initialPrompt: "Owner initial instruction",
      clientMessageId: randomUUID(),
    });
    const evidence = new TaskOwnerEvidenceStore(daemon.paseoHome);
    await expect
      .poll(async () => {
        const timeline = await client.fetchAgentTimeline(ownerCreated.id, {
          limit: 0,
          projection: "canonical",
        });
        return timeline.entries
          .filter((entry) => entry.item.type === "user_message")
          .map((entry) => entry.item);
      })
      .toEqual([expect.objectContaining({ text: "Owner initial instruction" })]);
    const ownerTimeline = await client.fetchAgentTimeline(ownerCreated.id, {
      limit: 0,
      projection: "canonical",
    });
    const ownerMessage = ownerTimeline.entries.find((entry) => entry.item.type === "user_message");
    expect(ownerMessage?.item).not.toHaveProperty("origin");
    expect(await evidence.list(ownerCreated.id)).toEqual([
      expect.objectContaining({ text: "Owner initial instruction" }),
    ]);
    const created = await delegateToContainer(client, {
      operation: "create",
      workspaceId: workspace.workspace!.id,
      provider: "codex",
      title: "Delegated task",
      initialPrompt: "First delegated message",
      idempotencyKey: randomUUID(),
    });
    const agentId = (created as { id: string }).id;
    const messages = async () => {
      const timeline = await client.fetchAgentTimeline(agentId, {
        limit: 0,
        projection: "canonical",
      });
      return timeline.entries
        .filter((entry) => entry.item.type === "user_message")
        .map((entry) => entry.item);
    };
    await expect
      .poll(messages)
      .toEqual([expect.objectContaining({ text: "First delegated message", origin: "agent" })]);
    expect(await evidence.list(agentId)).toEqual([]);
    const request = {
      operation: "send" as const,
      agentId,
      text: "Second delegated message",
      messageId: randomUUID(),
    };
    await delegateToContainer(client, request);
    await delegateToContainer(client, request);
    await expect
      .poll(messages)
      .toEqual([
        expect.objectContaining({ text: "First delegated message", origin: "agent" }),
        expect.objectContaining({ text: "Second delegated message", origin: "agent" }),
      ]);
    await expect(
      client.sendAgentMessage(agentId, request.text, { messageId: request.messageId }),
    ).rejects.toThrow("agent_request_key_conflict");
    expect(await evidence.list(agentId)).toEqual([]);
    await client.sendAgentMessage(agentId, "Owner message", { messageId: randomUUID() });
    await expect.poll(messages).toHaveLength(3);
    expect((await messages())[2]).not.toHaveProperty("origin");
    expect(await evidence.list(agentId)).toEqual([
      expect.objectContaining({ text: "Owner message" }),
    ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

test("delegation accepts exact profiles without model overrides and preserves legacy create", async () => {
  const request = {
    operation: "create" as const,
    idempotencyKey: randomUUID(),
    provider: "codex",
    workspaceId: "workspace-id",
    title: "Exact task",
    initialPrompt: "Inspect only",
  };
  const profileId = sharedProfileId("codex", "exact");
  expect(DelegationRequestSchema.parse({ ...request, profileId })).toEqual({
    ...request,
    profileId,
  });
  for (const invalidProfileId of ["", "   "])
    expect(
      DelegationRequestSchema.safeParse({ ...request, profileId: invalidProfileId }).success,
    ).toBe(false);
  for (const model of ["other", ""])
    expect(DelegationRequestSchema.safeParse({ ...request, profileId, model }).success).toBe(false);
  expect(
    DelegationRequestSchema.safeParse({ ...request, profileId, callerAgentId: randomUUID() })
      .success,
  ).toBe(false);
  const createAgent = vi.fn().mockResolvedValue({ id: "created" });
  const fetchWorkspaces = vi
    .fn()
    .mockResolvedValueOnce({ entries: [], pageInfo: { hasMore: true, nextCursor: "next" } })
    .mockResolvedValue({
      entries: [{ id: request.workspaceId, workspaceDirectory: "/selected/dev" }],
      pageInfo: { hasMore: false },
    });
  const client = { createAgent, fetchWorkspaces } as unknown as DelegationClient;
  await delegateToContainer(client, DelegationRequestSchema.parse({ ...request, profileId }));
  expect(createAgent).toHaveBeenLastCalledWith({
    provider: "codex",
    cwd: "/selected/dev",
    workspaceId: request.workspaceId,
    title: request.title,
    initialPrompt: request.initialPrompt,
    origin: "agent",
    idempotencyKey: request.idempotencyKey,
    profileId,
    model: undefined,
  });
  expect(fetchWorkspaces).toHaveBeenNthCalledWith(2, { page: { limit: 200, cursor: "next" } });
  await delegateToContainer(
    client,
    DelegationRequestSchema.parse({ ...request, model: "legacy-model" }),
  );
  expect(createAgent).toHaveBeenLastCalledWith(
    expect.objectContaining({ provider: "codex", model: "legacy-model" }),
  );
  expect(createAgent.mock.lastCall![0]).not.toHaveProperty("profileId");
});

test("delegated exact profiles use native identity, account checks and idempotency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegated-profile-"));
  const daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const profiles = [
      {
        id: "exact",
        name: "Exact review",
        provider: "codex",
        model: "gpt-5.4-mini",
        featureValues: { test_feature: true },
        instructions: "Exact preset instructions",
      },
      { id: "other", name: "Other review", provider: "codex", model: "gpt-5.4-mini" },
    ];
    const preferences = planProviderPreferencesMigration({ profiles, providers: {} }).preferences;
    const current = (await client.getDaemonConfig()).config;
    await client.patchDaemonConfig({
      sharedProviderPreferences: preferences,
      expectedProviderPreferencesRevision: current.sharedProviderPreferences?.revision ?? null,
    });
    const workspace = await client.createWorkspace({
      source: { kind: "directory", path: directory },
    });
    expect(workspace.error).toBeNull();
    const profileId = sharedProfileId("codex", "exact");
    const request = DelegationRequestSchema.parse({
      operation: "create",
      idempotencyKey: randomUUID(),
      provider: "codex",
      profileId,
      workspaceId: workspace.workspace!.id,
      title: "Exact delegated task",
      initialPrompt: "Delegated profile instruction",
    });
    const create = vi.spyOn(daemon.daemon.agentManager, "createAgent");
    const agent = (await delegateToContainer(client, request)) as AgentSnapshotPayload;
    expect(agent).toMatchObject({
      provider: "codex",
      cwd: directory,
      workspaceId: workspace.workspace!.id,
      model: "gpt-5.4-mini",
      profile: { id: profileId, name: "Exact review" },
    });
    expect(daemon.daemon.agentManager.getAgent(agent.id)!.config).toMatchObject({
      model: "gpt-5.4-mini",
      featureValues: { test_feature: true },
      systemPrompt: expect.stringContaining("Exact preset instructions"),
      profileLaunch: { profile: { id: profileId, name: "Exact review" } },
    });
    const calls = create.mock.calls.length;
    expect(((await delegateToContainer(client, request)) as AgentSnapshotPayload).id).toBe(
      agent.id,
    );
    expect(create).toHaveBeenCalledTimes(calls);
    await expect(
      delegateToContainer(client, {
        ...request,
        profileId: sharedProfileId("codex", "other"),
      } as typeof request),
    ).rejects.toThrow("agent_request_key_conflict");
    for (const change of [
      { profileId: sharedProfileId("codex", "missing") },
      { provider: "claude" },
      { workspaceId: "missing-workspace" },
    ]) {
      await expect(
        delegateToContainer(client, {
          ...request,
          ...change,
          idempotencyKey: randomUUID(),
        } as typeof request),
      ).rejects.toThrow();
    }
    expect(create).toHaveBeenCalledTimes(calls);
    const messages = async () =>
      (await client.fetchAgentTimeline(agent.id, { limit: 0, projection: "canonical" })).entries
        .filter((entry) => entry.item.type === "user_message")
        .map((entry) => entry.item);
    await expect
      .poll(messages)
      .toEqual([
        expect.objectContaining({ text: "Delegated profile instruction", origin: "agent" }),
      ]);
    expect(await new TaskOwnerEvidenceStore(daemon.paseoHome).list(agent.id)).toEqual([]);
    const legacy = (await delegateToContainer(
      client,
      DelegationRequestSchema.parse({
        operation: "create",
        idempotencyKey: randomUUID(),
        provider: "codex",
        model: "gpt-5.4-mini",
        workspaceId: workspace.workspace!.id,
        title: "Legacy delegated task",
        initialPrompt: "Legacy instruction",
      }),
    )) as AgentSnapshotPayload;
    expect(legacy).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
      workspaceId: workspace.workspace!.id,
    });
    expect(legacy.profile).toBeUndefined();
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

interface PlacementDiagnostic {
  phase: string;
  cwd: string;
  state: "started" | "completed" | "failed";
  elapsedMs: number;
}

test.each(["create_agent_request", "agent.create.request"] as const)(
  "%s preserves legacy worktree-name and git base-ref placement",
  async (type) => {
    const directory = await mkdtemp(join(tmpdir(), "legacy-agent-placement-"));
    const daemon = await createCreationDaemon();
    const peer = await connectCreationPeer(daemon.port);
    const failures: unknown[] = [];
    const diagnostics: PlacementDiagnostic[] = [];
    const startedAt = Date.now();
    let omittedRecords = 0;
    function recordDiagnostic(phase: string, cwd: string, state: PlacementDiagnostic["state"]) {
      if (diagnostics.length === 64) {
        omittedRecords++;
        return;
      }
      diagnostics.push({ phase, cwd, state, elapsedMs: Date.now() - startedAt });
    }
    const originalStop = daemon.daemon.stop;
    daemon.daemon.stop = async (options) => {
      recordDiagnostic("daemon.stop", directory, "started");
      try {
        await originalStop({
          ...options,
          onStep(step) {
            recordDiagnostic(`daemon.stop.${step}`, directory, "started");
            options?.onStep?.(step);
          },
        });
        recordDiagnostic("daemon.stop", directory, "completed");
      } catch (error) {
        failures.push(error);
        recordDiagnostic("daemon.stop", directory, "failed");
        throw error;
      }
    };
    async function cleanup(phase: string, operation: () => Promise<void>) {
      recordDiagnostic(phase, directory, "started");
      try {
        await operation();
        recordDiagnostic(phase, directory, "completed");
      } catch (error) {
        if (!failures.includes(error)) failures.push(error);
        recordDiagnostic(phase, directory, "failed");
      }
    }
    try {
      recordDiagnostic("repository.initialize", directory, "started");
      await initializeSetupRepository(directory);
      execFileSync("git", ["checkout", "-b", "release-base"], { cwd: directory });
      await writeFile(join(directory, "base-marker"), "Selected release base");
      execFileSync("git", ["add", "base-marker"], { cwd: directory });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "Release base fixture",
        ],
        { cwd: directory },
      );
      execFileSync("git", ["checkout", "main"], { cwd: directory });
      recordDiagnostic("repository.initialize", directory, "completed");
      for (const { placement, expectedBase, expectedBranch } of [
        {
          placement: { worktreeName: "legacy-worktree" },
          expectedBase: "main",
          expectedBranch: "legacy-worktree",
        },
        {
          placement: {
            git: {
              createWorktree: true,
              createNewBranch: true,
              newBranchName: "legacy-git",
              baseBranch: "release-base",
            },
          },
          expectedBase: "release-base",
          expectedBranch: "legacy-git",
        },
      ]) {
        recordDiagnostic(`placement.${expectedBranch}`, directory, "started");
        const response = await peer.request({
          type,
          requestId: randomUUID(),
          config: { provider: "codex", cwd: directory },
          ...placement,
        });
        recordDiagnostic(`placement.${expectedBranch}`, directory, "completed");
        let agentId: string;
        if (response.type === "agent.create.response") {
          expect(response.payload.error).toBeNull();
          if (!response.payload.agent) throw new Error("Missing created agent");
          agentId = response.payload.agent.id;
          expect(response.payload.agent.cwd).not.toBe(directory);
        } else {
          if (
            response.type !== "status" ||
            response.payload.status !== "agent_created" ||
            !response.payload.agentId
          )
            throw new Error(`Unexpected legacy placement response: ${JSON.stringify(response)}`);
          agentId = response.payload.agentId;
        }
        const record = await daemon.daemon.agentStorage.get(agentId);
        if (!record) throw new Error("Missing persisted legacy agent");
        recordDiagnostic(`placement.${expectedBranch}.git-checks`, record.cwd, "started");
        expect(record.cwd).not.toBe(directory);
        expect(
          execFileSync("git", ["branch", "--show-current"], {
            cwd: record.cwd,
            encoding: "utf8",
          }).trim(),
        ).toBe(expectedBranch);
        expect(
          execFileSync("git", ["merge-base", "HEAD", expectedBase], {
            cwd: record.cwd,
            encoding: "utf8",
          }).trim(),
        ).toBe(
          execFileSync("git", ["rev-parse", expectedBase], {
            cwd: directory,
            encoding: "utf8",
          }).trim(),
        );
        recordDiagnostic(`placement.${expectedBranch}.git-checks`, record.cwd, "completed");
      }
    } catch (error) {
      failures.push(error);
      recordDiagnostic("test.body", directory, "failed");
    } finally {
      await cleanup("peer.close", () => peer.closeAndWait());
      await cleanup("daemon.close", () => daemon.close());
      await cleanup("repository.remove", () => rm(directory, { recursive: true, force: true }));
      daemon.daemon.stop = originalStop;
      if (failures.length > 0 || process.env.PASEO_TEST_PLACEMENT_DIAGNOSTICS === "1") {
        console.info(
          "LEGACY_PLACEMENT_DIAGNOSTICS",
          JSON.stringify({ type, diagnostics, omittedRecords }),
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Legacy placement or fixture cleanup failed", {
        cause: failures[0],
      });
    }
  },
);
