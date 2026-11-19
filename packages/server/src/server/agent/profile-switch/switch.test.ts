import { expect, test } from "vitest";
import { createAgentCommand } from "../create-agent/create.js";
import { buildClaudeFeatures } from "../providers/claude/feature-definitions.js";
import { getClaudeManifestModels } from "../providers/claude/model-manifest.js";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SwitchHistoryStore } from "./history-store.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { resolveAndValidateCreateAgentMode } from "../create-agent-mode.js";
import { AgentManager } from "../agent-manager.js";
import { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { claudeProjectDirSync } from "../providers/claude/project-dir.js";
import { selectProfileSwitchCandidates, switchAgentProfileCommand } from "./command.js";
import { MessageQueueService } from "../../message-queue/service.js";
import { MessageQueueStore } from "../../message-queue/store.js";
import { QueueAttachmentStore } from "../../message-queue/attachments.js";
import { AgentStorage } from "../agent-storage.js";
import type {
  AgentClient,
  AgentPromptInput,
  ProviderCatalog,
  AgentFeature,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class FakeSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();

  private mode: string | null;

  constructor(
    readonly provider: AgentProvider,
    private readonly history: AgentTimelineItem[],
    private readonly config?: AgentSessionConfig,
    readonly features: AgentFeature[] = [],
    private readonly runtimeThinkingOptionId?: string | null,
    private readonly runtimeModel?: string | null,
    private readonly onProviderCall: () => void = () => {},
  ) {
    this.mode = config?.modeId ?? null;
  }

  async run() {
    this.onProviderCall();
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnId: string | undefined;

  async startTurn(prompt: AgentPromptInput) {
    this.onProviderCall();
    if (typeof prompt === "string") this.history.push({ type: "user_message", text: prompt });
    this.turnId = randomUUID();
    for (const listener of this.listeners)
      listener({ type: "turn_started", provider: this.provider, turnId: this.turnId });
    return { turnId: this.turnId };
  }

  completeTurn(text?: string): void {
    if (!this.turnId) return;
    if (text) {
      const item: AgentTimelineItem = { type: "assistant_message", text };
      this.history.push(item);
      for (const listener of this.listeners)
        listener({ type: "timeline", provider: this.provider, item });
    }
    for (const listener of this.listeners)
      listener({ type: "turn_completed", provider: this.provider, turnId: this.turnId });
    this.turnId = undefined;
  }

  subscribe(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    this.onProviderCall();
    for (const item of this.history) yield { type: "timeline", provider: this.provider, item };
  }

  async getRuntimeInfo() {
    this.onProviderCall();
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.runtimeModel === undefined ? (this.config?.model ?? null) : this.runtimeModel,
      modeId: this.mode,
      thinkingOptionId:
        this.runtimeThinkingOptionId === undefined
          ? this.config?.thinkingOptionId
          : this.runtimeThinkingOptionId,
    };
  }

  async listCommands() {
    this.onProviderCall();
    return [];
  }

  async getAvailableModes() {
    this.onProviderCall();
    return [];
  }

  async getCurrentMode() {
    this.onProviderCall();
    return this.mode;
  }

  async setMode(modeId: string): Promise<void> {
    this.onProviderCall();
    this.mode = modeId;
  }

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  beforeClose?: () => Promise<void>;

  async close(): Promise<void> {
    this.onProviderCall();
    await this.beforeClose?.();
  }
}

class FakeClient implements AgentClient {
  readonly capabilities = CAPABILITIES;
  readonly created: AgentSessionConfig[] = [];
  readonly sessions: FakeSession[] = [];
  readonly resumed: AgentPersistenceHandle[] = [];
  history: AgentTimelineItem[] = [];
  catalog: ProviderCatalog = { models: [], modes: [] };
  features: AgentFeature[] = [];
  availabilityCalls = 0;
  providerCalls = 0;
  modelDependentFeatures = false;
  createError: Error | null = null;
  runtimeThinkingOptionId?: string | null;
  runtimeModel?: string | null;
  beforeCatalog?: () => Promise<void>;

  constructor(readonly provider: AgentProvider) {}

  async isAvailable() {
    this.availabilityCalls += 1;
    this.providerCalls += 1;
    return true;
  }

  async fetchCatalog(): Promise<ProviderCatalog> {
    this.providerCalls += 1;
    await this.beforeCatalog?.();
    return this.catalog;
  }

  async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    this.providerCalls += 1;
    if (this.modelDependentFeatures) {
      return buildClaudeFeatures({
        modelId: config.model,
        fastModeEnabled: config.featureValues?.fast_mode === true,
        chromeAvailable: true,
        chromeEnabled: config.featureValues?.chrome === true,
      });
    }
    return this.features;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.providerCalls += 1;
    if (this.createError) throw this.createError;
    this.created.push(config);
    const session = new FakeSession(
      this.provider,
      [],
      config,
      structuredClone(await this.listFeatures(config)),
      this.runtimeThinkingOptionId,
      this.runtimeModel,
      () => {
        this.providerCalls += 1;
      },
    );
    this.sessions.push(session);
    return session;
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    this.providerCalls += 1;
    this.resumed.push(handle);
    return new FakeSession(this.provider, this.history);
  }
}

class TestSwitchHistory extends SwitchHistoryStore {
  beforeWrite?: () => Promise<void>;

  override async writeSegment(...args: Parameters<SwitchHistoryStore["writeSegment"]>) {
    await this.beforeWrite?.();
    return super.writeSegment(...args);
  }
}

class TestStorage extends AgentStorage {
  override readonly switchHistory: TestSwitchHistory;

  constructor(directory: string, logger: ReturnType<typeof createTestLogger>) {
    super(directory, logger);
    this.switchHistory = new TestSwitchHistory({
      directory: (agentId) => join(directory, "..", "agent-switch-history", agentId),
      logger,
    });
  }

  journalError: Error | null = null;

  override async appendJournal(...args: Parameters<AgentStorage["appendJournal"]>) {
    if (this.journalError) throw this.journalError;
    return super.appendJournal(...args);
  }
}

async function fixture() {
  const workdir = mkdtempSync(join(tmpdir(), "profile-switch-"));
  const logger = createTestLogger();
  const storage = new TestStorage(join(workdir, "agents"), logger);
  await storage.initialize();
  const codex = new FakeClient("codex");
  const claude = new FakeClient("claude");
  const second = new FakeClient("codex-second");
  for (const client of [codex, second]) {
    client.catalog.models = [
      { provider: client.provider, id: "model", label: "Model", isDefault: true },
    ];
  }
  const manager = new AgentManager({
    clients: { codex, claude, "codex-second": second },
    providerDefinitions: {
      codex: { enabled: true },
      "codex-second": { enabled: true, derivedFromProviderId: "codex" },
    },
    registry: storage,
    logger,
  });
  return {
    workdir,
    storage,
    codex,
    claude,
    second,
    manager,
    cleanup: () => rmSync(workdir, { recursive: true, force: true }),
  };
}

test.each([
  { configured: undefined, runtime: "high" },
  { configured: "high", runtime: null },
  { configured: "high", runtime: "low" },
])(
  "coordinator preserves configured thinking $configured over runtime $runtime",
  async ({ configured, runtime }) => {
    const { workdir, storage, manager, codex, second, cleanup } = await fixture();
    try {
      codex.runtimeThinkingOptionId = runtime;
      second.runtimeThinkingOptionId = "low";
      second.catalog = {
        models: [
          {
            provider: "codex-second",
            id: "model",
            label: "Model",
            isDefault: true,
            thinkingOptions: [
              { id: "high", label: "High" },
              { id: "low", label: "Low" },
            ],
          },
        ],
        modes: [{ id: "acceptEdits", label: "Accept File Edits" }],
      };
      const agent = await manager.createAgent(
        { provider: "codex", cwd: workdir, modeId: "acceptEdits", thinkingOptionId: configured },
        undefined,
        { workspaceId: undefined },
      );
      await manager.flush();
      const result = await switchAgentProfileCommand(
        {
          agentManager: manager,
          agentStorage: storage,
          logger: createTestLogger(),
          getAgentProfiles: () => [
            { id: "target", name: "Target", provider: "codex-second", thinkingOptionId: "low" },
          ],
          providerSnapshotManager: {
            async resolveCreateConfig(
              input: Parameters<ProviderSnapshotManager["resolveCreateConfig"]>[0],
            ) {
              return { modeId: input.requestedMode, featureValues: input.featureValues };
            },
            async *readSessionHistory() {},
          },
        },
        {
          agentId: agent.id,
          provider: "codex-second",
          profileId: "target",
          explanation: "Continue work",
        },
        { includeResult: true },
      );
      const scenario = JSON.stringify({ configured: configured ?? null, runtime });
      expect(result.outcome, scenario).toBe("switched");
      expect(second.created[0]?.thinkingOptionId, scenario).toBe(configured);
      expect(manager.getAgent(agent.id)?.config.thinkingOptionId, scenario).toBe(configured);
      expect(manager.getAgent(agent.id)?.runtimeInfo?.thinkingOptionId, scenario).toBe("low");
      await manager.flush();
      expect((await storage.get(agent.id))?.config?.thinkingOptionId ?? null, scenario).toBe(
        configured ?? null,
      );
      await manager.closeAgent(agent.id);
    } finally {
      cleanup();
    }
  },
);

test("an unloaded stored-unset mode preserves the known effective permission mode", async () => {
  const { workdir, storage, manager, second, cleanup } = await fixture();
  const reader = new AgentManager({
    clients: { "codex-second": second },
    registry: storage,
    providerDefinitions: {
      codex: { enabled: true },
      "codex-second": { enabled: true, derivedFromProviderId: "codex" },
    },
    logger: createTestLogger(),
  });
  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, thinkingOptionId: "high" },
      undefined,
      { workspaceId: undefined },
    );
    await manager.closeAgent(agent.id);
    const record = await storage.get(agent.id);
    if (!record) throw new Error("Missing source record");
    expect(record.config?.modeId).toBeUndefined();
    await storage.upsert({ ...record, lastModeId: "acceptEdits" });
    second.catalog = {
      models: [
        {
          provider: "codex-second",
          id: "model",
          label: "Model",
          isDefault: true,
          thinkingOptions: [{ id: "high", label: "High" }],
        },
      ],
      modes: [
        { id: "acceptEdits", label: "Accept File Edits" },
        { id: "bypassPermissions", label: "Bypass" },
      ],
    };
    const result = await switchAgentProfileCommand(
      {
        agentManager: reader,
        agentStorage: storage,
        logger: createTestLogger(),
        getAgentProfiles: () => [
          {
            id: "target",
            name: "Target",
            provider: "codex-second",
            modeId: "bypassPermissions",
            thinkingOptionId: "high",
          },
        ],
        providerSnapshotManager: {
          async resolveCreateConfig(
            input: Parameters<ProviderSnapshotManager["resolveCreateConfig"]>[0],
          ) {
            return { modeId: input.requestedMode, featureValues: input.featureValues };
          },
          async *readSessionHistory(): AsyncGenerator<AgentStreamEvent> {
            yield {
              type: "timeline",
              provider: "codex",
              item: { type: "user_message", text: "Keep this work" },
            };
          },
        },
      },
      {
        agentId: agent.id,
        provider: "codex-second",
        profileId: "target",
        explanation: "Continue work",
      },
      { includeResult: true },
    );
    expect(result).toMatchObject({ outcome: "switched", modeId: "acceptEdits" });
    expect(second.created[0]?.modeId).toBe("acceptEdits");
    await reader.flush();
    expect((await storage.get(agent.id))?.config?.modeId).toBe("acceptEdits");
    await reader.closeAgent(agent.id);
  } finally {
    cleanup();
  }
});

test.each([
  {
    scenario: "unknown-mode",
    provider: "codex-second",
    sourceMode: undefined,
    targetMode: "default",
    thinking: "high",
    runtimeThinking: undefined,
    providerCalls: 1,
  },
  {
    scenario: "unsupported-mode",
    provider: "codex-second",
    sourceMode: "acceptEdits",
    targetMode: "default",
    thinking: "high",
    runtimeThinking: undefined,
    providerCalls: 1,
  },
  {
    scenario: "cross-family",
    provider: "claude",
    sourceMode: "acceptEdits",
    targetMode: "default",
    thinking: "high",
    runtimeThinking: undefined,
    providerCalls: 0,
  },
  {
    scenario: "unsupported-thinking",
    provider: "codex-second",
    sourceMode: "acceptEdits",
    targetMode: "acceptEdits",
    thinking: "unsupported",
    runtimeThinking: "low",
    providerCalls: 1,
  },
])(
  "coordinator refuses $scenario before mode admission without changing the source",
  async ({ provider, sourceMode, targetMode, thinking, runtimeThinking, providerCalls }) => {
    const { workdir, storage, manager, codex, second, claude, cleanup } = await fixture();
    try {
      const targetClient = provider === "claude" ? claude : second;
      codex.runtimeThinkingOptionId = runtimeThinking;
      targetClient.catalog = {
        models: [
          {
            provider: targetClient.provider,
            id: "model",
            label: "Model",
            isDefault: true,
            thinkingOptions: [
              { id: "high", label: "High" },
              { id: "low", label: "Low" },
            ],
          },
        ],
        modes: [{ id: targetMode, label: "Target mode" }],
      };
      const agent = await manager.createAgent(
        {
          provider: "codex",
          cwd: workdir,
          thinkingOptionId: thinking,
          modeId: sourceMode,
        },
        undefined,
        { workspaceId: undefined },
      );
      await manager.appendTimelineItem(agent.id, { type: "user_message", text: "Keep this work" });
      await manager.appendJournal(agent.id, { entryId: randomUUID(), text: "Keep this decision" });
      await manager.flush();
      const before = await storage.get(agent.id);
      const config = structuredClone(agent.config);
      const session = agent.session;
      const timeline = await manager.getTimelineRows(agent.id);
      const journal = await manager.readJournal(agent.id);
      let admissionCalls = 0;
      let catalogCalls = 0;
      let closes = 0;
      codex.sessions[0]!.beforeClose = async () => {
        closes += 1;
      };
      targetClient.beforeCatalog = async () => {
        catalogCalls += 1;
      };
      const result = await switchAgentProfileCommand(
        {
          agentManager: manager,
          agentStorage: storage,
          logger: createTestLogger(),
          providerSnapshotManager: {
            async resolveCreateConfig(
              input: Parameters<ProviderSnapshotManager["resolveCreateConfig"]>[0],
            ) {
              admissionCalls += 1;
              return {
                modeId: resolveAndValidateCreateAgentMode({
                  requestedMode: input.requestedMode,
                  targetProvider: input.provider,
                  parent: input.parent,
                  unattended: input.unattended,
                  availableModes: targetClient.catalog.modes.map((mode) => mode.id),
                  targetUnattendedMode: undefined,
                }),
                featureValues: input.featureValues,
              };
            },
            async *readSessionHistory() {},
          },
        },
        { agentId: agent.id, provider: targetClient.provider, explanation: "Move approved work" },
        { includeResult: true },
      );
      expect(result).toMatchObject({ outcome: "refused", refusalCode: "incompatible-target" });
      expect(admissionCalls).toBe(0);
      expect(catalogCalls).toBe(providerCalls);
      expect(targetClient.availabilityCalls).toBe(providerCalls);
      expect(targetClient.created).toEqual([]);
      expect(closes).toBe(0);
      expect(manager.getAgent(agent.id)?.session).toBe(session);
      expect(manager.getAgent(agent.id)?.config).toEqual(config);
      expect(manager.getAgent(agent.id)?.provider).toBe("codex");
      expect(await manager.getTimelineRows(agent.id)).toEqual(timeline);
      expect(await manager.readJournal(agent.id)).toEqual(journal);
      await manager.flush();
      expect(await storage.get(agent.id)).toEqual(before);
      await manager.closeAgent(agent.id);
    } finally {
      cleanup();
    }
  },
);

test("coordinator switching keeps ordinary unset thinking and the current permission mode", async () => {
  const { workdir, storage, manager, codex, second, cleanup } = await fixture();
  try {
    codex.features = [{ type: "toggle", id: "fast", label: "Fast", value: true }];
    second.features = structuredClone(codex.features);
    second.catalog = {
      models: [
        {
          provider: "codex-second",
          id: "model",
          label: "Model",
          isDefault: true,
          thinkingOptions: [
            { id: "high", label: "High" },
            { id: "low", label: "Low" },
          ],
        },
      ],
      modes: [
        { id: "bypassPermissions", label: "Bypass" },
        { id: "acceptEdits", label: "Accept File Edits" },
      ],
    };
    const dependencies = {
      agentManager: manager,
      agentStorage: storage,
      logger: createTestLogger(),
      getAgentProfiles: () => [
        {
          id: "target",
          name: "Target",
          provider: "codex-second",
          model: "model",
          modeId: "bypassPermissions",
        },
      ],
      providerSnapshotManager: {
        async resolveCreateConfig(
          input: Parameters<ProviderSnapshotManager["resolveCreateConfig"]>[0],
        ) {
          return { modeId: input.requestedMode, featureValues: input.featureValues };
        },
        async *readSessionHistory() {},
      },
    };
    for (const modeId of ["bypassPermissions", "acceptEdits"]) {
      const agent = await manager.createAgent(
        { provider: "codex", cwd: workdir, modeId: "bypassPermissions" },
        undefined,
        { workspaceId: undefined },
      );
      if (modeId === "acceptEdits") await manager.setAgentMode(agent.id, modeId);
      const result = await switchAgentProfileCommand(
        dependencies,
        {
          agentId: agent.id,
          provider: "codex-second",
          profileId: "target",
          explanation: "Continue on the second account",
        },
        { includeResult: true },
      );
      expect(result.outcome).toBe("switched");
      expect(second.created.at(-1)).toMatchObject({ modeId, featureValues: { fast: true } });
      expect(second.created.at(-1)?.thinkingOptionId).toBeUndefined();
      expect(manager.getAgent(agent.id)?.config.thinkingOptionId).toBeUndefined();
      await manager.flush();
      expect((await storage.get(agent.id))?.config?.thinkingOptionId ?? null).toBeNull();
      await manager.closeAgent(agent.id);
    }
  } finally {
    cleanup();
  }
});

test("switch preparation preserves effective settings over target profile defaults or refuses before mutation", async () => {
  const { workdir, storage, manager, codex, second, cleanup } = await fixture();
  try {
    const preserved = {
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
      featureValues: { fast: true, quality: "high" },
    };
    codex.features = [
      { type: "toggle", id: "fast", label: "Fast", value: true },
      {
        type: "select",
        id: "quality",
        label: "Quality",
        value: "high",
        options: [
          { id: "high", label: "High" },
          { id: "low", label: "Low" },
        ],
      },
    ];
    second.features = structuredClone(codex.features);
    second.catalog = {
      models: [
        {
          provider: "codex-second",
          id: "model",
          label: "Model",
          thinkingOptions: [{ id: "high", label: "High" }],
        },
      ],
      modes: [],
    };
    const agent = await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
        model: "model",
        ...preserved,
        featureValues: { fast: null, quality: null },
      },
      undefined,
      { workspaceId: undefined },
    );
    const dependencies = {
      agentManager: manager,
      agentStorage: storage,
      logger: createTestLogger(),
      getAgentProfiles: () => [
        {
          id: "target",
          name: "Target defaults",
          provider: "codex-second",
          model: "model",
          modeId: "default",
          thinkingOptionId: "low",
          featureValues: { fast: false, quality: "low" },
        },
      ],
      providerSnapshotManager: {
        async resolveCreateConfig(
          input: Parameters<ProviderSnapshotManager["resolveCreateConfig"]>[0],
        ) {
          expect(input.requestedMode).toBe(preserved.modeId);
          expect(input.featureValues).toEqual(preserved.featureValues);
          return { modeId: input.requestedMode, featureValues: input.featureValues };
        },
        async *readSessionHistory() {},
      },
    };
    const target = {
      agentId: agent.id,
      provider: "codex-second",
      profileId: "target",
      explanation: "Continue on the second account",
    };
    await expect(switchAgentProfileCommand(dependencies, target)).rejects.toMatchObject({
      code: "incompatible-target",
    });
    expect(second.created).toEqual([]);
    expect((await storage.get(agent.id))?.profileSwitches ?? []).toEqual([]);
    second.catalog.modes = [{ id: "bypassPermissions", label: "Bypass" }];
    expect(
      await switchAgentProfileCommand(
        dependencies,
        { ...target, dryRun: true },
        { includeResult: true },
      ),
    ).toEqual({
      agentId: agent.id,
      outcome: "refused",
      error: expect.any(String),
      preview: { sourceEligible: true, targetChecked: false },
    });
    expect(second.created).toEqual([]);
    await switchAgentProfileCommand(dependencies, target);
    expect(second.created[0]).toMatchObject(preserved);
    // Coordinator requests never infer permission equivalence across provider families.
    await expect(
      switchAgentProfileCommand(dependencies, {
        ...target,
        provider: "claude",
        profileId: undefined,
      }),
    ).rejects.toMatchObject({ code: "incompatible-target" });
    expect(manager.getAgent(agent.id)?.provider).toBe("codex-second");
    // App switches carry no explanation and keep switching across provider families.
    await switchAgentProfileCommand(
      {
        ...dependencies,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return { modeId: undefined, featureValues: undefined };
          },
          async *readSessionHistory() {},
        },
      },
      { agentId: agent.id, provider: "claude" },
    );
    expect(manager.getAgent(agent.id)?.provider).toBe("claude");
    await manager.closeAgent(agent.id);
  } finally {
    cleanup();
  }
});

test("batch candidates use workspace membership and exact source account", () => {
  const agents = [
    { id: "selected", provider: "source", workspaceId: "one" },
    { id: "other-account", provider: "other", workspaceId: "one" },
    { id: "same-project", provider: "source", workspaceId: "two" },
    { id: "other-project", provider: "source", workspaceId: "three" },
    { id: "unassigned", provider: "source" },
  ];
  const workspaces = [
    { workspaceId: "one", projectId: "project" },
    { workspaceId: "two", projectId: "project" },
    { workspaceId: "three", projectId: "other" },
  ];
  expect(
    selectProfileSwitchCandidates({
      agents,
      workspaces,
      selection: { sourceProvider: "source", workspaceId: "one" },
    }),
  ).toEqual(["selected"]);
  expect(
    selectProfileSwitchCandidates({
      agents,
      workspaces,
      selection: { sourceProvider: "source", projectId: "project" },
    }),
  ).toEqual(["selected", "same-project"]);
  expect(() =>
    selectProfileSwitchCandidates({ agents, workspaces, selection: { sourceProvider: "source" } }),
  ).toThrow("exactly one");
});

test("an eligible switch preview leaves sessions, history, journal and timeline unchanged", async () => {
  const { workdir, storage, codex, second, manager, cleanup } = await fixture();
  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Review work" },
      undefined,
      {
        workspaceId: undefined,
      },
    );
    await manager.appendTimelineItem(agent.id, { type: "user_message", text: "Keep this work" });
    await manager.appendJournal(agent.id, { entryId: randomUUID(), text: "Approved scope" });
    await manager.flush();
    const before = await storage.get(agent.id);
    expect(before?.persistence).toMatchObject({ provider: "codex" });
    const timeline = await manager.getTimelineRows(agent.id);
    const journal = await manager.readJournal(agent.id);
    const filesBefore = readdirSync(workdir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [
        join(entry.parentPath, entry.name),
        readFileSync(join(entry.parentPath, entry.name), "utf8"),
      ]);
    let runtimeStarts = 0;
    second.beforeCatalog = async () => {
      runtimeStarts += 1;
      await second.createSession({ provider: "codex-second", cwd: workdir });
    };
    const dependencies = {
      agentManager: manager,
      agentStorage: storage,
      logger: createTestLogger(),
      providerSnapshotManager: {
        async resolveCreateConfig() {
          return { modeId: undefined, featureValues: undefined };
        },
        async *readSessionHistory() {},
      },
    };
    const target = {
      agentId: agent.id,
      provider: "codex-second",
      explanation: "Move the approved work",
    };
    const options = {
      includeResult: true as const,
      actor: { kind: "agent" as const, id: agent.id },
    };
    const preview = await switchAgentProfileCommand(
      dependencies,
      { ...target, dryRun: true },
      options,
    );
    expect(runtimeStarts).toBe(0);
    // A dry run reports source eligibility only, with no settings that could pass for the target's.
    expect(preview).toEqual({
      agentId: agent.id,
      outcome: "refused",
      error: expect.any(String),
      preview: { sourceEligible: true, targetChecked: false },
    });
    expect(
      await switchAgentProfileCommand(
        dependencies,
        { ...target, dryRun: true },
        {
          ...options,
          validateScope: async () => {
            throw new Error("Outside the selection");
          },
        },
      ),
    ).toEqual({
      agentId: agent.id,
      outcome: "refused",
      error: "Outside the selection",
      refusalCode: "out-of-scope",
      preview: { sourceEligible: false, targetChecked: false },
    });
    expect(second.created).toEqual([]);
    const unloadedManager = new AgentManager({
      clients: { codex, "codex-second": second },
      registry: storage,
      logger: createTestLogger(),
    });
    expect(unloadedManager.getAgent(agent.id)).toBeNull();
    const unloadedPreview = await switchAgentProfileCommand(
      {
        ...dependencies,
        agentManager: unloadedManager,
        providerSnapshotManager: {
          ...dependencies.providerSnapshotManager,
          async *readSessionHistory() {
            runtimeStarts += 1;
            await codex.resumeSession({ provider: "codex", sessionId: agent.id });
            yield { type: "user_message" as const, text: "Saved history" };
          },
        },
      },
      { ...target, dryRun: true },
      options,
    );
    expect(unloadedPreview).toMatchObject({ preview: { sourceEligible: true } });
    expect(runtimeStarts).toBe(0);
    expect(codex.resumed).toEqual([]);
    const restrictedPreview = await switchAgentProfileCommand(
      {
        ...dependencies,
        getAgentProfiles: () => [
          {
            id: "restricted",
            name: "Restricted skills",
            provider: "codex",
            model: "model",
            skillPolicy: { mode: "inherit" as const, include: [], exclude: ["excluded-skill"] },
          },
        ],
      },
      { ...target, provider: "codex", profileId: "restricted", dryRun: true },
      options,
    );
    expect(codex.created).toHaveLength(1);
    expect(second.created).toEqual([]);
    expect(restrictedPreview).toMatchObject({
      preview: { sourceEligible: true, targetChecked: false },
    });
    await manager.flush();
    expect(codex.created).toHaveLength(1);
    expect(second.created).toEqual([]);
    expect(await storage.get(agent.id)).toEqual(before);
    expect(await manager.readJournal(agent.id)).toEqual(journal);
    expect(await manager.getTimelineRows(agent.id)).toEqual(timeline);
    const filesAfter = readdirSync(workdir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [
        join(entry.parentPath, entry.name),
        readFileSync(join(entry.parentPath, entry.name), "utf8"),
      ]);
    expect(filesAfter).toEqual(filesBefore);
    second.beforeCatalog = undefined;
    expect(
      await switchAgentProfileCommand(dependencies, { ...target, dryRun: false }, options),
    ).toMatchObject({ outcome: "switched" });
    const afterJournal = await manager.readJournal(agent.id);
    expect(afterJournal).toHaveLength(2);
    expect(JSON.parse(afterJournal[1]?.machineContext ?? "null")).toMatchObject({
      actor: options.actor,
      reason: target.explanation,
      from: "codex",
      to: "codex-second",
    });
    storage.journalError = new Error("Journal unavailable");
    expect(
      await switchAgentProfileCommand(
        dependencies,
        { ...target, provider: "codex", dryRun: false },
        options,
      ),
    ).toMatchObject({ outcome: "switched", provider: "codex", auditError: "Journal unavailable" });
    expect(manager.getAgent(agent.id)?.provider).toBe("codex");
    storage.journalError = null;
    expect(second.created).toHaveLength(1);
    await manager.closeAgent(agent.id);
  } finally {
    cleanup();
  }
});

test("a restriction queued during history writing applies to the replacement session", async () => {
  const { workdir, storage, codex, second, manager, cleanup } = await fixture();
  const writing = Promise.withResolvers<void>();
  const finishWriting = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const finishClosing = Promise.withResolvers<void>();
  try {
    second.catalog = {
      models: second.catalog.models,
      modes: [{ id: "bypassPermissions", label: "Bypass" }],
    };
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "bypassPermissions" },
      undefined,
      { workspaceId: undefined },
    );
    const sourceSession = codex.sessions[0]!;
    sourceSession.beforeClose = async () => {
      closing.resolve();
      await finishClosing.promise;
    };
    storage.switchHistory.beforeWrite = async () => {
      writing.resolve();
      await finishWriting.promise;
    };
    const switched = switchAgentProfileCommand(
      {
        agentManager: manager,
        agentStorage: storage,
        logger: createTestLogger(),
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return { modeId: "bypassPermissions", featureValues: undefined };
          },
          async *readSessionHistory() {},
        },
      },
      { agentId: agent.id, provider: "codex-second", explanation: "Continue elsewhere" },
    );
    await writing.promise;
    const restriction = manager.setAgentMode(agent.id, "default");
    finishWriting.resolve();
    await closing.promise;
    finishClosing.resolve();
    await switched;
    await restriction;
    expect(manager.getAgent(agent.id)?.currentModeId).toBe("default");
    expect(await second.sessions[0]?.getCurrentMode()).toBe("default");
    expect(await sourceSession.getCurrentMode()).toBe("bypassPermissions");
    await manager.closeAgent(agent.id);
  } finally {
    finishWriting.resolve();
    finishClosing.resolve();
    cleanup();
  }
});

test.each([false, true])(
  "a settings change during target resolution refuses the switch before replacement (structured: %s)",
  async (structured) => {
    const { workdir, storage, codex, manager, cleanup } = await fixture();
    try {
      codex.catalog = {
        models: codex.catalog.models,
        modes: [{ id: "default", label: "Default" }],
      };
      const agent = await manager.createAgent(
        { provider: "codex", cwd: workdir, modeId: "default" },
        undefined,
        { workspaceId: undefined },
      );
      const attempt = switchAgentProfileCommand(
        {
          agentManager: manager,
          agentStorage: storage,
          logger: createTestLogger(),
          providerSnapshotManager: {
            async resolveCreateConfig() {
              await manager.setAgentMode(agent.id, "bypassPermissions");
              return { modeId: "default", featureValues: undefined };
            },
            async *readSessionHistory() {},
          },
        },
        { agentId: agent.id, provider: "codex", explanation: "Continue elsewhere" },
        { includeResult: structured },
      );
      if (structured) {
        await expect(attempt).resolves.toMatchObject({
          outcome: "refused",
          modeId: "default",
          refusalCode: "source-changed",
        });
      } else {
        await expect(attempt).rejects.toMatchObject({ code: "source-changed" });
      }
      expect(codex.created).toHaveLength(1);
      expect(manager.getAgent(agent.id)?.config.modeId).toBe("bypassPermissions");
      expect((await storage.get(agent.id))?.profileSwitches ?? []).toEqual([]);
      await manager.closeAgent(agent.id);
    } finally {
      cleanup();
    }
  },
);

test("a switch keeps the thread, carries recorded context and replays every segment", async () => {
  const { workdir, storage, codex, claude, manager, cleanup } = await fixture();
  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, quotaPausedAt: "2026-10-22T00:00:00.000Z" },
      undefined,
      { workspaceId: undefined },
    );
    await manager.appendTimelineItem(agent.id, { type: "user_message", text: "fix the parser" });
    await manager.appendTimelineItem(agent.id, {
      type: "assistant_message",
      text: "parser fixed on codex",
    });

    const context = await manager.readSwitchContext(agent.id);
    expect(context).toBe(
      "user_message:\nfix the parser\n\nassistant_message:\nparser fixed on codex",
    );
    const switched = await manager.switchAgentProfile(agent.id, {
      config: { provider: "claude", cwd: workdir, systemPrompt: `carried: ${context}` },
      reason: "quota",
      carriedContextChars: context.length,
    });

    expect(switched.id).toBe(agent.id);
    expect(switched.provider).toBe("claude");
    expect(switched.config.quotaPausedAt).toBeUndefined();
    expect(claude.created.at(-1)?.systemPrompt).toContain("parser fixed on codex");
    const marker = (await manager.getTimelineRows(agent.id)).at(-1)?.item;
    expect(marker).toMatchObject({
      type: "profile_switch",
      reason: "quota",
      from: { provider: "codex" },
      to: { provider: "claude" },
      carriedContextChars: context.length,
    });
    await manager.flush();
    const record = await storage.get(agent.id);
    expect(record?.provider).toBe("claude");
    expect(record?.persistence?.provider).toBe("claude");
    expect(record?.profileSwitches?.map((entry) => entry.marker)).toEqual([marker]);

    // A reload replays retained history first, then only the new account's session.
    claude.history = [
      { type: "user_message", text: "continue" },
      { type: "assistant_message", text: "continued on claude" },
    ];
    await manager.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
    await manager.hydrateTimelineFromProvider(agent.id);
    expect(claude.resumed.at(-1)?.provider).toBe("claude");
    expect(codex.resumed).toEqual([]);
    expect((await manager.getTimelineRows(agent.id)).map((row) => row.item)).toEqual([
      { type: "user_message", text: "fix the parser" },
      { type: "assistant_message", text: "parser fixed on codex" },
      marker,
      { type: "user_message", text: "continue" },
      { type: "assistant_message", text: "continued on claude" },
    ]);

    // A second switch stores only what followed the first marker, chained to its segment.
    await manager.switchAgentProfile(agent.id, {
      config: { provider: "codex", cwd: workdir },
      reason: "manual",
      carriedContextChars: 0,
    });
    await manager.flush();
    const switches = (await storage.get(agent.id))?.profileSwitches ?? [];
    const second = switches.at(-1)?.marker;
    const historyDir = join(workdir, "agent-switch-history", agent.id);
    const segment = readFileSync(join(historyDir, `${second?.switchId}.segment.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(segment[0]).toMatchObject({
      previousSwitchId: marker?.type === "profile_switch" ? marker.switchId : "",
    });
    expect(segment.slice(1).map((event) => event.item)).toEqual([
      { type: "user_message", text: "continue" },
      { type: "assistant_message", text: "continued on claude" },
      second,
    ]);
    codex.history = [{ type: "assistant_message", text: "back on codex" }];
    await manager.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
    await manager.hydrateTimelineFromProvider(agent.id);
    expect((await manager.getTimelineRows(agent.id)).map((row) => row.item)).toEqual([
      { type: "user_message", text: "fix the parser" },
      { type: "assistant_message", text: "parser fixed on codex" },
      marker,
      { type: "user_message", text: "continue" },
      { type: "assistant_message", text: "continued on claude" },
      second,
      { type: "assistant_message", text: "back on codex" },
    ]);
  } finally {
    await manager.flush();
    cleanup();
  }
});

test.each(["permission", "running"])("a switch refuses while busy (%s)", async (busy) => {
  const { workdir, manager, codex, cleanup } = await fixture();
  let run: Promise<unknown> | undefined;
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    if (busy === "running") {
      run = manager.runAgent(agent.id, "Keep running until the fixture completes the turn");
      await manager.waitForAgentRunStart(agent.id);
      expect(manager.hasInFlightRun(agent.id)).toBe(true);
    } else
      manager.getAgent(agent.id)?.pendingPermissions.set("permission", {
        id: "permission",
        provider: "codex",
        name: "Bash",
        kind: "tool",
      });
    await expect(
      manager.switchAgentProfile(agent.id, {
        config: { provider: "claude", cwd: workdir },
        reason: "manual",
        carriedContextChars: 0,
      }),
    ).rejects.toThrow("Wait for the current turn");
  } finally {
    for (const session of codex.sessions) session.completeTurn();
    await run;
    await manager.flush();
    cleanup();
  }
});

test("a thread whose retained history is missing still loads with its switch marker", async () => {
  const { workdir, claude, manager, cleanup } = await fixture();
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.appendTimelineItem(agent.id, { type: "user_message", text: "earlier" });
    await manager.switchAgentProfile(agent.id, {
      config: { provider: "claude", cwd: workdir },
      reason: "manual",
      carriedContextChars: 0,
    });
    const marker = (await manager.getTimelineRows(agent.id)).at(-1)?.item;
    await manager.flush();
    rmSync(join(workdir, "agent-switch-history"), { recursive: true, force: true });

    claude.history = [{ type: "assistant_message", text: "later" }];
    await manager.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
    await manager.hydrateTimelineFromProvider(agent.id);
    expect((await manager.getTimelineRows(agent.id)).map((row) => row.item)).toEqual([
      marker,
      { type: "assistant_message", text: "later" },
    ]);
  } finally {
    await manager.flush();
    cleanup();
  }
});

test("an unloaded thread switches without the previous provider and retains its history", async () => {
  const { workdir, storage, manager, claude, cleanup } = await fixture();
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: "original-workspace",
      labels: { purpose: "recovery" },
    });
    await manager.closeAgent(agent.id);
    const record = await storage.get(agent.id);
    if (!record) throw new Error("Missing source record");
    const reader = new AgentManager({
      clients: { claude },
      registry: storage,
      logger: createTestLogger(),
    });
    const rows = [
      {
        seq: 1,
        timestamp: record.createdAt,
        item: { type: "user_message" as const, text: "Keep the existing plan" },
      },
    ];
    const switched = await reader.switchAgentProfile(agent.id, {
      config: { provider: "claude", cwd: workdir },
      reason: "manual",
      carriedContextChars: 22,
      storedSource: { record, rows },
    });
    expect(switched).toMatchObject({
      id: agent.id,
      provider: "claude",
      workspaceId: "original-workspace",
      labels: { purpose: "recovery" },
    });
    expect((await reader.getTimelineRows(agent.id)).map((row) => row.item)).toEqual([
      rows[0].item,
      expect.objectContaining({
        type: "profile_switch",
        from: expect.objectContaining({ provider: "codex" }),
      }),
    ]);
    await reader.flush();
    await reader.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
    await reader.hydrateTimelineFromProvider(agent.id);
    expect((await reader.getTimelineRows(agent.id))[0]?.item).toEqual(rows[0].item);
    await reader.closeAgent(agent.id);
  } finally {
    await manager.flush();
    cleanup();
  }
});

test.each([false, true])(
  "recovery reads a disabled Claude account transcript (removed: %s)",
  async (removed) => {
    const { workdir, storage, codex, cleanup, manager } = await fixture();
    const configDir = join(workdir, "old-claude-account");
    const transcriptDir = claudeProjectDirSync(workdir, { configDir });
    mkdirSync(transcriptDir, { recursive: true });
    const sessionId = randomUUID();
    const userMessageId = randomUUID();
    writeFileSync(
      join(transcriptDir, `${sessionId}.jsonl`),
      [
        {
          type: "user",
          uuid: userMessageId,
          sessionId,
          cwd: workdir,
          message: { role: "user", content: "Preserve my approved plan" },
        },
        {
          type: "assistant",
          uuid: randomUUID(),
          sessionId,
          cwd: workdir,
          message: { role: "assistant", content: "The next step is validation" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const provider = "claude-retired";
    const snapshots = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        [provider]: {
          extends: "claude",
          label: "Retired account",
          enabled: false,
          removed,
          env: { CLAUDE_CONFIG_DIR: configDir },
        },
      },
      extraClients: { codex },
    });
    const reader = new AgentManager({
      clients: { codex },
      registry: storage,
      logger: createTestLogger(),
    });
    try {
      expect(snapshots.listRegisteredProviderIds({ enabledOnly: true })).not.toContain(provider);
      const id = randomUUID();
      const now = new Date().toISOString();
      await storage.upsert({
        id,
        provider,
        cwd: workdir,
        workspaceId: "retained-workspace",
        title: "Original task",
        labels: {},
        createdAt: now,
        updatedAt: now,
        lastStatus: "closed",
        config: null,
        persistence: { provider, sessionId, metadata: { cwd: workdir } },
        tasks: [
          { id: "task", text: "Validate", completed: false, source: "vorteo", status: "pending" },
        ],
        journal: [{ id: randomUUID(), sequence: 1, timestamp: now, text: "Approved scope" }],
      });
      const queueRoot = join(workdir, "queue");
      const queueStore = new MessageQueueStore(queueRoot);
      await queueStore.mutate(id, {
        kind: "enqueue",
        operationId: "enqueue",
        messageId: "pending",
        text: "Preserve my approved plan",
        attachments: [],
      });
      await queueStore.claim(id);
      await queueStore.recordProviderMessageId({
        agentId: id,
        messageId: "pending",
        providerMessageId: userMessageId,
      });
      const queue = new MessageQueueService(queueStore, new QueueAttachmentStore(queueRoot));
      // Cover both an uninitialized delivery and a recovered uncertain delivery.
      if (removed) await queue.read(id);
      let queueChanges = 0;
      queue.subscribe(id, () => queueChanges++);
      reader.setMessageQueueControl(queue);
      const queueBefore = await queueStore.read(id);
      const queueFilesBefore = readdirSync(queueRoot).map((file) =>
        readFileSync(join(queueRoot, file), "utf8"),
      );
      const before = await storage.get(id);
      if (!before?.persistence) throw new Error("Missing saved thread");
      const loadHistory = () =>
        reader.readStoredSwitchHistory(
          before,
          snapshots.readSessionHistory(before.persistence!, { provider, cwd: workdir }),
        );
      const tail = await reader.fetchSavedTimeline(id, { limit: 1 }, loadHistory);
      expect(tail.rows.map((row) => row.item)).toMatchObject([
        { type: "assistant_message", text: "The next step is validation" },
      ]);
      const older = await reader.fetchSavedTimeline(
        id,
        {
          direction: "before",
          cursor: { epoch: tail.epoch, seq: tail.startSeq! },
          limit: 1,
        },
        loadHistory,
      );
      expect(older.epoch).toBe(tail.epoch);
      expect(older.staleCursor).toBe(false);
      expect(older.rows.map((row) => row.item)).toMatchObject([
        { type: "user_message", text: "Preserve my approved plan" },
      ]);
      expect(reader.getAgent(id)).toBeNull();
      expect(await storage.get(id)).toEqual(before);
      expect(codex.created).toHaveLength(0);
      expect(codex.resumed).toHaveLength(0);
      expect(queueChanges).toBe(0);
      expect(await queueStore.read(id)).toEqual(queueBefore);
      expect(
        readdirSync(queueRoot).map((file) => readFileSync(join(queueRoot, file), "utf8")),
      ).toEqual(queueFilesBefore);
      appendFileSync(
        join(transcriptDir, `${sessionId}.jsonl`),
        "\n" +
          JSON.stringify({
            type: "assistant",
            uuid: randomUUID(),
            sessionId,
            cwd: workdir,
            message: { role: "assistant", content: "New saved result" },
          }),
      );
      const changed = await reader.fetchSavedTimeline(
        id,
        {
          direction: "before",
          cursor: { epoch: tail.epoch, seq: tail.startSeq! },
          limit: 1,
        },
        loadHistory,
      );
      expect(changed.epoch).not.toBe(tail.epoch);
      expect(changed.staleCursor).toBe(true);
      expect(changed.reset).toBe(true);
      expect(changed.rows.map((row) => row.item)).toMatchObject([
        { type: "assistant_message", text: "New saved result" },
      ]);
      expect(queueChanges).toBe(0);
      expect(await queueStore.read(id)).toEqual(queueBefore);
      // Positive control: these same rows really can reconcile the uncertain message.
      await queue.read(id);
      const reconciliation = await queueStore.reconcileHistory(
        id,
        (await loadHistory()).map((row) => ({
          type: "timeline",
          provider,
          item: row.item,
          timestamp: row.timestamp,
        })),
      );
      expect(reconciliation.changed).toBe(true);
      codex.createError = new Error("Replacement failed");
      await expect(
        switchAgentProfileCommand(
          {
            agentManager: reader,
            agentStorage: storage,
            providerSnapshotManager: snapshots,
            logger: createTestLogger(),
          },
          { agentId: id, provider: "codex" },
        ),
      ).rejects.toThrow("Replacement failed");
      expect(await storage.get(id)).toEqual(before);
      codex.createError = null;
      await switchAgentProfileCommand(
        {
          agentManager: reader,
          agentStorage: storage,
          providerSnapshotManager: snapshots,
          logger: createTestLogger(),
        },
        { agentId: id, provider: "codex" },
        { standingInstructions: "You are the Foreman." },
      );
      // Standing instructions, such as a Factory charter, lead the new session's prompt.
      expect(codex.created.at(-1)?.systemPrompt).toMatch(/^You are the Foreman\.\n\n/);
      expect(codex.created.at(-1)?.systemPrompt).toContain("Preserve my approved plan");
      expect(codex.created.at(-1)?.systemPrompt).toContain("The next step is validation");
      expect(reader.getAgent(id)).toMatchObject({
        workspaceId: "retained-workspace",
        tasks: before?.tasks,
        journal: before?.journal,
      });
      expect(await storage.get(id)).toMatchObject({
        title: "Original task",
        provider: "codex",
        tasks: before?.tasks,
        journal: before?.journal,
      });
      expect(
        (await snapshots.listProviders()).find((entry) => entry.provider === provider)?.enabled,
      ).not.toBe(true);
      await reader.closeAgent(id);
    } finally {
      await snapshots.shutdown();
      await manager.flush();
      cleanup();
    }
  },
);

test("recovery refuses a stale source and unreadable transcript without changing the thread", async () => {
  const { workdir, storage, manager, claude, cleanup } = await fixture();
  const reader = new AgentManager({
    clients: { claude },
    registry: storage,
    logger: createTestLogger(),
  });
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.closeAgent(agent.id);
    const record = await storage.get(agent.id);
    if (!record) throw new Error("Missing record");
    await expect(reader.readStoredSwitchHistory(record, (async function* () {})())).rejects.toThrow(
      "transcript could not be read",
    );
    await storage.setTitle(agent.id, "Changed while selecting");
    await expect(
      reader.switchAgentProfile(agent.id, {
        config: { provider: "claude", cwd: workdir },
        reason: "manual",
        carriedContextChars: 0,
        storedSource: { record, rows: [] },
      }),
    ).rejects.toThrow("thread changed");
    expect(claude.created).toHaveLength(0);
    expect((await storage.get(agent.id))?.provider).toBe("codex");
  } finally {
    await manager.flush();
    cleanup();
  }
});

test.each(["opencode", "opencode-retired"])(
  "refuses unsafe native history for %s before creating a client",
  async (provider) => {
    const snapshots = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "opencode-retired": {
          extends: "opencode",
          label: "Retired OpenCode",
          enabled: false,
          removed: true,
        },
      },
    });
    try {
      const history = snapshots.readSessionHistory(
        { provider, sessionId: "must-not-resume" },
        { provider, cwd: "/nonexistent-history-reader" },
      );
      await expect(history.next()).rejects.toThrow("Saved OpenCode history cannot be read safely");
    } finally {
      await snapshots.shutdown();
    }
  },
);

test("legacy switch snapshots migrate to verified segments without deleting any original", async () => {
  const { workdir, storage, cleanup } = await fixture();
  try {
    const marker = (switchId: string) => ({
      type: "profile_switch" as const,
      switchId,
      reason: "manual" as const,
      from: { provider: "codex" },
      to: { provider: "claude" },
      carriedContextChars: 0,
    });
    const at = "2026-11-01T00:00:00.000Z";
    const events = [
      { timestamp: at, item: { type: "user_message", text: "first ✓ {not a brace}" } },
      { timestamp: at, item: marker("one") },
      { timestamp: at, turnId: "t", item: { type: "assistant_message", text: 'quoted "]" text' } },
      { timestamp: at, item: marker("two") },
    ];
    const dir = join(workdir, "agent-switch-history", "legacy-agent");
    mkdirSync(dir, { recursive: true });
    const write = (name: string, value: unknown) =>
      writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
    // "zero" holds history the newest snapshot lacks, as when a thread loaded marker-only.
    write("zero.json", {
      switchId: "zero",
      events: [
        { timestamp: at, item: { type: "user_message", text: "lost" } },
        { timestamp: at, item: marker("zero") },
      ],
    });
    write("one.json", { switchId: "one", events: events.slice(0, 2) });
    write("two.json", { switchId: "two", events });
    writeFileSync(join(dir, "stale.segment.jsonl.migrating"), "partial");

    // A truncated newest snapshot leaves every original snapshot and no segments, and is not
    // retried until the daemon restarts.
    const intact = readFileSync(join(dir, "two.json"), "utf8");
    writeFileSync(join(dir, "two.json"), intact.slice(0, intact.length / 2));
    expect(await storage.switchHistory.read("legacy-agent", "two")).toBeNull();
    // A stale staging file from an earlier crash is cleared before staging begins.
    expect(readdirSync(dir).sort()).toEqual(["one.json", "two.json", "zero.json"]);
    writeFileSync(join(dir, "two.json"), intact);
    expect(await storage.switchHistory.read("legacy-agent", "two")).toBeNull();

    const restarted = new AgentStorage(join(workdir, "agents"), createTestLogger());
    const read = async (switchId: string) => {
      const replayed = [];
      for await (const event of (await restarted.switchHistory.read("legacy-agent", switchId)) ??
        [])
        replayed.push(event);
      return replayed;
    };
    expect(await read("two")).toEqual(events);
    expect(readdirSync(dir).sort()).toEqual([
      "one.json",
      "one.segment.jsonl",
      "two.json",
      "two.segment.jsonl",
      "zero.json",
    ]);
    // The record lists "zero", which the chain lacks, so nothing may be pruned.
    const all = ["zero", "one", "two"];
    expect(await restarted.switchHistory.inspectChain("legacy-agent", all)).toEqual({
      switchIds: ["one", "two"],
      complete: false,
    });
    await restarted.switchHistory.pruneUnreferenced("legacy-agent", all);
    expect(readdirSync(dir)).toContain("zero.json");

    // After a rollback an older daemon wrote "three" with only the "two" marker before it.
    // Migration chains onto the existing "two" segment instead of overwriting it.
    const twoSegment = readFileSync(join(dir, "two.segment.jsonl"), "utf8");
    const later = [
      { timestamp: at, item: marker("two") },
      { timestamp: at, item: { type: "assistant_message", text: "after rollback" } },
      { timestamp: at, item: marker("three") },
    ];
    write("three.json", { switchId: "three", events: later });
    expect(await read("three")).toEqual([...events, ...later.slice(1)]);
    expect(readFileSync(join(dir, "two.segment.jsonl"), "utf8")).toBe(twoSegment);
  } finally {
    cleanup();
  }
});

const SOURCE_MODEL = "claude-opus-5-5";
const TARGET_DEFAULT = "claude-sonnet-5";

function modelCatalog(provider: string): ProviderCatalog {
  return {
    models: getClaudeManifestModels().map((model) =>
      Object.assign(model, { provider, isDefault: model.id === TARGET_DEFAULT }),
    ),
    modes: [
      { id: "acceptEdits", label: "Accept File Edits" },
      { id: "bypassPermissions", label: "Bypass" },
    ],
  };
}

function switchDependencies(manager: AgentManager, storage: AgentStorage) {
  return {
    agentManager: manager,
    agentStorage: storage,
    logger: createTestLogger(),
    providerSnapshotManager: {
      async resolveCreateConfig(
        input: Parameters<ProviderSnapshotManager["resolveCreateConfig"]>[0],
      ) {
        return { modeId: input.requestedMode, featureValues: input.featureValues };
      },
      async *readSessionHistory(): AsyncGenerator<AgentStreamEvent> {
        yield {
          type: "timeline",
          provider: "codex",
          item: { type: "user_message", text: "Retained work" },
        };
      },
    },
  };
}

test("account-only model-dependent features preserve the created and stored source model", async () => {
  const { workdir, storage, manager, codex, second, cleanup } = await fixture();
  try {
    codex.catalog = modelCatalog(codex.provider);
    second.catalog = modelCatalog(second.provider);
    codex.modelDependentFeatures = second.modelDependentFeatures = true;
    const agent = await manager.createAgent(
      {
        provider: codex.provider,
        cwd: workdir,
        model: SOURCE_MODEL,
        modeId: "acceptEdits",
        featureValues: { fast_mode: false, chrome: false },
      },
      undefined,
      { workspaceId: undefined },
    );
    const result = await switchAgentProfileCommand(
      switchDependencies(manager, storage),
      {
        agentId: agent.id,
        provider: second.provider,
        explanation: "Continue execution",
      },
      { includeResult: true },
    );
    expect(result).toMatchObject({
      outcome: "switched",
      model: SOURCE_MODEL,
      modeId: "acceptEdits",
      features: { fast_mode: false, chrome: false },
    });
    expect(second.created[0]?.model).toBe(SOURCE_MODEL);
    await manager.flush();
    expect((await storage.get(agent.id))?.config?.model).toBe(SOURCE_MODEL);
    await manager.closeAgent(agent.id);
  } finally {
    cleanup();
  }
});

test.each([
  {
    scenario: "thinking supported only by source",
    sourceModel: SOURCE_MODEL,
    thinking: "xhigh",
    outcome: "switched",
  },
  {
    scenario: "thinking supported only by default",
    sourceModel: SOURCE_MODEL,
    thinking: "off",
    outcome: "refused",
  },
  {
    scenario: "missing carried model",
    sourceModel: SOURCE_MODEL,
    thinking: undefined,
    outcome: "refused",
  },
])("account-only $scenario", async ({ scenario, sourceModel, thinking, outcome }) => {
  const { workdir, storage, manager, codex, second, cleanup } = await fixture();
  try {
    codex.catalog = modelCatalog(codex.provider);
    second.catalog = modelCatalog(second.provider);
    // Sonnet 4.6 has standard effort, Opus 5.5 has xhigh but no disabled thinking.
    if (scenario === "thinking supported only by source") {
      second.catalog.models = second.catalog.models.map((model) => ({
        ...model,
        isDefault: model.id === "claude-sonnet-4-6",
      }));
    }
    if (scenario === "missing carried model")
      second.catalog.models = second.catalog.models.filter((model) => model.id !== sourceModel);
    const agent = await manager.createAgent(
      {
        provider: codex.provider,
        cwd: workdir,
        model: sourceModel,
        modeId: "acceptEdits",
        thinkingOptionId: thinking,
      },
      undefined,
      { workspaceId: undefined },
    );
    await manager.flush();
    const before = await storage.get(agent.id);
    const timeline = await manager.getTimelineRows(agent.id);
    const journal = await manager.readJournal(agent.id);
    const session = agent.session;
    let closes = 0;
    codex.sessions[0]!.beforeClose = async () => {
      closes += 1;
    };
    const result = await switchAgentProfileCommand(
      switchDependencies(manager, storage),
      {
        agentId: agent.id,
        provider: second.provider,
        explanation: "Continue execution",
      },
      { includeResult: true },
    );
    expect(result.outcome).toBe(outcome);
    if (outcome === "refused") {
      expect(result.refusalCode).toBe("incompatible-target");
      expect(closes).toBe(0);
      expect(second.created).toEqual([]);
      expect(manager.getAgent(agent.id)?.session).toBe(session);
      await manager.flush();
      expect(await storage.get(agent.id)).toEqual(before);
      expect(await manager.getTimelineRows(agent.id)).toEqual(timeline);
      expect(await manager.readJournal(agent.id)).toEqual(journal);
    } else {
      expect(second.created[0]).toMatchObject({ model: sourceModel, thinkingOptionId: thinking });
      await manager.flush();
      expect((await storage.get(agent.id))?.config?.model).toBe(sourceModel);
    }
    await manager.closeAgent(agent.id);
  } finally {
    cleanup();
  }
});

test.each([
  {
    scenario: "stored beats runtime",
    stored: SOURCE_MODEL,
    runtime: TARGET_DEFAULT,
    unloaded: false,
  },
  { scenario: "unset uses runtime", stored: undefined, runtime: SOURCE_MODEL, unloaded: false },
  {
    scenario: "unloaded uses persisted runtime",
    stored: undefined,
    runtime: SOURCE_MODEL,
    unloaded: true,
  },
  {
    scenario: "unknown ignores frozen profile and defaults",
    stored: undefined,
    runtime: null,
    unloaded: false,
  },
  {
    scenario: "unloaded unknown ignores frozen profile and defaults",
    stored: undefined,
    runtime: null,
    unloaded: true,
  },
])("account-only source resolution: $scenario", async ({ stored, runtime, unloaded }) => {
  const { workdir, storage, manager, codex, second, cleanup } = await fixture();
  let active = manager;
  try {
    codex.catalog = modelCatalog(codex.provider);
    codex.runtimeModel = runtime;
    second.catalog = modelCatalog(second.provider);
    const agent = await manager.createAgent(
      {
        provider: codex.provider,
        cwd: workdir,
        model: SOURCE_MODEL,
        modeId: "acceptEdits",
        profileLaunch: {
          profile: { id: "frozen", name: "Frozen", provider: codex.provider, model: SOURCE_MODEL },
        },
      },
      undefined,
      { workspaceId: undefined },
    );
    const live = manager.getAgent(agent.id);
    if (!live) throw new Error("Missing live source");
    live.config.model = stored;
    expect(live.runtimeInfo?.model).toBe(runtime);
    if (unloaded) {
      await manager.closeAgent(agent.id);
      const record = await storage.get(agent.id);
      if (!record) throw new Error("Missing stored source");
      expect(record.runtimeInfo?.model).toBe(runtime);
      expect(record.config?.model).toBe(stored);
      active = new AgentManager({
        clients: { "codex-second": second },
        registry: storage,
        providerDefinitions: {
          codex: { enabled: true },
          "codex-second": { enabled: true, derivedFromProviderId: "codex" },
        },
        logger: createTestLogger(),
      });
    }
    await active.flush();
    const before = await storage.get(agent.id);
    const result = await switchAgentProfileCommand(
      switchDependencies(active, storage),
      {
        agentId: agent.id,
        provider: second.provider,
        explanation: "Continue execution",
      },
      { includeResult: true },
    );
    if (runtime === null) {
      expect(result).toMatchObject({ outcome: "refused", refusalCode: "incompatible-target" });
      expect(second.created).toEqual([]);
      await active.flush();
      expect(await storage.get(agent.id)).toEqual(before);
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: "switched" });
      expect(second.created[0]?.model).toBe(SOURCE_MODEL);
      await active.flush();
      expect((await storage.get(agent.id))?.config?.model).toBe(SOURCE_MODEL);
    }
    await active.closeAgent(agent.id);
  } finally {
    cleanup();
  }
});

test.each([
  {
    scenario: "explicit beats profile",
    explicit: SOURCE_MODEL,
    profile: TARGET_DEFAULT,
    expected: SOURCE_MODEL,
  },
  {
    scenario: "profile beats source",
    explicit: undefined,
    profile: TARGET_DEFAULT,
    expected: TARGET_DEFAULT,
  },
  { scenario: "source fallback", explicit: undefined, profile: undefined, expected: SOURCE_MODEL },
])("coordinator model precedence: $scenario", async ({ explicit, profile, expected }) => {
  const { workdir, storage, manager, codex, second, cleanup } = await fixture();
  try {
    codex.catalog = modelCatalog(codex.provider);
    second.catalog = modelCatalog(second.provider);
    const agent = await manager.createAgent(
      { provider: codex.provider, cwd: workdir, model: SOURCE_MODEL, modeId: "acceptEdits" },
      undefined,
      { workspaceId: undefined },
    );
    const result = await switchAgentProfileCommand(
      {
        ...switchDependencies(manager, storage),
        getAgentProfiles: () => [
          { id: "target", name: "Target", provider: second.provider, model: profile },
        ],
      },
      {
        agentId: agent.id,
        provider: second.provider,
        model: explicit,
        profileId: profile ? "target" : undefined,
        explanation: "Continue execution",
      },
      { includeResult: true },
    );
    expect(result.outcome).toBe("switched");
    expect(second.created[0]?.model).toBe(expected);
    await manager.flush();
    expect((await storage.get(agent.id))?.config?.model).toBe(expected);
    await manager.closeAgent(agent.id);
  } finally {
    cleanup();
  }
});

test.each([
  {
    scenario: "same family without profile",
    cross: false,
    profile: false,
    explicit: false,
    unset: false,
  },
  {
    scenario: "same family with profile",
    cross: false,
    profile: true,
    explicit: true,
    unset: false,
  },
  {
    scenario: "cross family without model or thinking",
    cross: true,
    profile: false,
    explicit: false,
    unset: false,
  },
  {
    scenario: "cross family with model and thinking",
    cross: true,
    profile: false,
    explicit: true,
    unset: false,
  },
  {
    scenario: "same family source model unset",
    cross: false,
    profile: false,
    explicit: false,
    unset: true,
  },
])("app comparison: $scenario", async ({ cross, profile, explicit, unset }) => {
  const { workdir, storage, manager, codex, claude, second, cleanup } = await fixture();
  try {
    const target = cross ? claude : second;
    codex.catalog = modelCatalog(codex.provider);
    target.catalog = modelCatalog(target.provider);
    const agent = await manager.createAgent(
      {
        provider: codex.provider,
        cwd: workdir,
        model: SOURCE_MODEL,
        modeId: "acceptEdits",
        thinkingOptionId: "high",
        featureValues: { fast_mode: false, chrome: false },
      },
      undefined,
      { workspaceId: undefined },
    );
    if (unset) {
      const live = manager.getAgent(agent.id);
      if (!live) throw new Error("Missing source");
      live.config.model = undefined;
      expect(live.runtimeInfo?.model).toBe(SOURCE_MODEL);
    }
    const result = await switchAgentProfileCommand(
      {
        ...switchDependencies(manager, storage),
        getAgentProfiles: () => [
          {
            id: "target",
            name: "Target",
            provider: target.provider,
            model: TARGET_DEFAULT,
            modeId: "bypassPermissions",
            thinkingOptionId: "low",
            featureValues: { chrome: true },
          },
        ],
      },
      {
        agentId: agent.id,
        provider: target.provider,
        profileId: profile ? "target" : undefined,
        model: explicit ? SOURCE_MODEL : undefined,
        thinkingOptionId: explicit ? "high" : undefined,
      },
      { includeResult: true },
    );
    const expectedModel = explicit && !profile ? SOURCE_MODEL : TARGET_DEFAULT;
    let expectedThinking: string | null = null;
    if (explicit) expectedThinking = "high";
    if (profile) expectedThinking = "low";
    const expectedMode = profile ? "bypassPermissions" : null;
    const expectedFeatures = profile ? { chrome: true } : {};
    const observed = {
      outcome: result.outcome,
      provider: result.provider,
      model: result.model,
      mode: result.modeId,
      thinking: result.thinkingOptionId,
      features: result.features,
      refusalCode: result.refusalCode ?? null,
    };
    expect(observed).toEqual({
      outcome: "switched",
      provider: target.provider,
      model: expectedModel,
      mode: expectedMode,
      thinking: expectedThinking,
      features: expectedFeatures,
      refusalCode: null,
    });
    const created = target.created[0];
    expect(created).toMatchObject({ model: expectedModel });
    await manager.flush();
    const stored = (await storage.get(agent.id))?.config;
    assertAppConfig(created, expectedModel, expectedMode, expectedThinking, expectedFeatures);
    assertAppConfig(stored, expectedModel, expectedMode, expectedThinking, expectedFeatures);
    await manager.closeAgent(agent.id);
  } finally {
    cleanup();
  }
});

test("realistic fake lifecycle carries the model in both directions including an unloaded source", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "claude-account-switch-"));
  const logger = createTestLogger();
  const storage = new TestStorage(join(workdir, "agents"), logger);
  await storage.initialize();
  const source = new FakeClient("claude");
  const target = new FakeClient("claude-second");
  for (const client of [source, target]) {
    client.catalog = modelCatalog(client.provider);
    client.modelDependentFeatures = true;
  }
  const managerOptions = {
    clients: { claude: source, "claude-second": target },
    registry: storage,
    logger,
    providerDefinitions: {
      claude: { enabled: true },
      "claude-second": { enabled: true, derivedFromProviderId: "claude" },
    },
  };
  let manager = new AgentManager(managerOptions);
  let agentId: string | undefined;
  let run: ReturnType<AgentManager["runAgent"]> | undefined;
  try {
    const dependencies = {
      ...switchDependencies(manager, storage),
      getAgentProfiles: () => [
        {
          id: "source",
          name: "Source",
          provider: source.provider,
          model: SOURCE_MODEL,
          modeId: "bypassPermissions",
          featureValues: { fast_mode: false, chrome: false },
        },
      ],
    };
    const { snapshot } = await createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: source.provider, cwd: workdir, profileId: "source" },
      workspaceId: "fake-workspace",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
    });
    agentId = snapshot.id;
    expect(source.created[0]).toMatchObject({ model: SOURCE_MODEL, modeId: "bypassPermissions" });
    expect(snapshot.config.thinkingOptionId).toBeUndefined();
    run = manager.runAgent(agentId, "Remember the first turn");
    await manager.waitForAgentRunStart(agentId);
    source.sessions[0]!.completeTurn("The first turn completed");
    await run;
    run = undefined;
    await manager.setAgentMode(agentId, "acceptEdits");
    expect(await source.sessions[0]!.getCurrentMode()).toBe("acceptEdits");
    await manager.closeAgent(agentId);
    manager = new AgentManager(managerOptions);
    expect(manager.getAgent(agentId)).toBeNull();
    let historyCalls = 0;
    const switchedDependencies = {
      ...switchDependencies(manager, storage),
      providerSnapshotManager: {
        ...dependencies.providerSnapshotManager,
        async *readSessionHistory(): AsyncGenerator<AgentStreamEvent> {
          historyCalls += 1;
          yield* source.sessions[0]!.streamHistory();
        },
      },
    };
    const beforeCalls = [
      source.providerCalls,
      target.providerCalls,
      source.created.length,
      target.created.length,
    ];
    const preview = await switchAgentProfileCommand(
      switchedDependencies,
      {
        agentId,
        provider: target.provider,
        explanation: "Continue approved work",
        dryRun: true,
      },
      { includeResult: true },
    );
    expect(preview.preview).toEqual({ sourceEligible: true, targetChecked: false });
    expect([
      source.providerCalls,
      target.providerCalls,
      source.created.length,
      target.created.length,
    ]).toEqual(beforeCalls);
    expect(historyCalls).toBe(0);
    expect(source.resumed).toEqual([]);
    const actor = { kind: "principal" as const, id: "owner" };
    for (const client of [target, source]) {
      const result = await switchAgentProfileCommand(
        switchedDependencies,
        {
          agentId,
          provider: client.provider,
          explanation: "Continue approved work",
        },
        { includeResult: true, actor },
      );
      expect(result).toMatchObject({
        outcome: "switched",
        provider: client.provider,
        model: SOURCE_MODEL,
        modeId: "acceptEdits",
        thinkingOptionId: null,
        features: { fast_mode: false, chrome: false },
      });
      expect(result.refusalCode).toBeUndefined();
      expect(client.created.at(-1)).toMatchObject({
        model: SOURCE_MODEL,
        modeId: "acceptEdits",
        featureValues: { fast_mode: false, chrome: false },
      });
      expect(client.created.at(-1)?.thinkingOptionId).toBeUndefined();
      expect(client.created.at(-1)?.systemPrompt).toContain("Remember the first turn");
      expect(await client.sessions.at(-1)?.getCurrentMode()).toBe("acceptEdits");
      await manager.flush();
      expect((await storage.get(agentId))?.config).toMatchObject({
        model: SOURCE_MODEL,
        modeId: "acceptEdits",
        featureValues: { fast_mode: false, chrome: false },
      });
      expect((await storage.get(agentId))?.config?.thinkingOptionId ?? null).toBeNull();
      const journal = await manager.readJournal(agentId);
      expect(JSON.parse(journal.at(-1)?.machineContext ?? "null")).toMatchObject({
        actor,
        reason: "Continue approved work",
        to: client.provider,
      });
      if (client === source) {
        expect(client.created.at(-1)?.systemPrompt).toContain("The second turn completed");
      }
      if (client === target) {
        run = manager.runAgent(agentId, "Continue the second turn");
        await manager.waitForAgentRunStart(agentId);
        target.sessions.at(-1)!.completeTurn("The second turn completed");
        await run;
        run = undefined;
      }
    }
    expect((await storage.get(agentId))?.profileSwitches).toHaveLength(2);
  } finally {
    for (const session of [...source.sessions, ...target.sessions]) session.completeTurn();
    await run;
    if (agentId) await manager.closeAgent(agentId);
    rmSync(workdir, { recursive: true, force: true });
  }
});

function assertAppConfig(
  config:
    | Pick<AgentSessionConfig, "model" | "modeId" | "thinkingOptionId" | "featureValues">
    | undefined,
  model: string,
  mode: string | null,
  thinking: string | null,
  features: Record<string, boolean>,
) {
  expect(config?.model).toBe(model);
  expect(config?.modeId ?? null).toBe(mode);
  expect(config?.thinkingOptionId ?? null).toBe(thinking);
  expect(config?.featureValues ?? {}).toEqual(features);
}

test.each([false, true, null])(
  "coordinator refuses absent or unknown feature value %s without mutation",
  async (value) => {
    const { workdir, storage, manager, codex, second, cleanup } = await fixture();
    try {
      const agent = await manager.createAgent(
        {
          provider: codex.provider,
          cwd: workdir,
          model: "model",
          featureValues: { fast_mode: value },
        },
        undefined,
        { workspaceId: undefined },
      );
      await manager.flush();
      const before = await storage.get(agent.id);
      const timeline = await manager.getTimelineRows(agent.id);
      const journal = await manager.readJournal(agent.id);
      let closes = 0;
      codex.sessions[0]!.beforeClose = async () => {
        closes += 1;
      };
      const result = await switchAgentProfileCommand(
        switchDependencies(manager, storage),
        {
          agentId: agent.id,
          provider: second.provider,
          explanation: "Continue execution",
        },
        { includeResult: true },
      );
      const refusalCode = value === null ? "unknown-setting" : "incompatible-target";
      expect(result).toMatchObject({ outcome: "refused", refusalCode });
      expect(closes).toBe(0);
      expect(second.created).toEqual([]);
      expect(manager.getAgent(agent.id)?.session).toBe(agent.session);
      await manager.flush();
      expect(await storage.get(agent.id)).toEqual(before);
      expect(await manager.getTimelineRows(agent.id)).toEqual(timeline);
      expect(await manager.readJournal(agent.id)).toEqual(journal);
      await manager.closeAgent(agent.id);
    } finally {
      cleanup();
    }
  },
);
