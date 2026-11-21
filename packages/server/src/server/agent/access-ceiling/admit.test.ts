import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreateScheduleInput, StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { ScheduleService } from "../../schedule/service.js";
import { createTestAgentMessages } from "../../test-utils/agent-messages.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager } from "../agent-manager.js";
import type { AgentClient, AgentMode, AgentSession } from "../agent-sdk-types.js";
import { AgentStorage } from "../agent-storage.js";
import { createPaseoToolCatalog } from "../tools/paseo-tools.js";
import {
  ALLOWED_MESSAGE,
  deriveAssertions,
  liveModeId,
  modeAuthority,
  PERMISSION_ANSWER_MESSAGE,
  REPORT_FAILED_CODE,
  REPORT_FAILED_MESSAGE,
  SELF_CHANGE_MESSAGE,
  SELF_ESCALATION_MESSAGE,
  WOULD_REFUSE_MESSAGE,
  type CeilingAgentRecord,
} from "./admit.js";
import { compareChildAccess } from "./levels.js";

// Wrapped so one case can make the comparator throw; every other case uses the real one.
vi.mock("./levels.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./levels.js")>();
  return { ...actual, compareChildAccess: vi.fn(actual.compareChildAccess) };
});

function record(overrides: Partial<CeilingAgentRecord> = {}): CeilingAgentRecord {
  const provider = overrides.provider ?? "codex";
  return {
    id: "agent",
    provider,
    cwd: "/work",
    currentModeId: null,
    features: [],
    ...overrides,
    config: { provider, cwd: "/work", ...overrides.config },
  };
}

describe("access ceiling input derivation", () => {
  // One row per way daemon state makes a mode authoritative or not. Assertions never come from
  // tool arguments; every row is built from an agent record alone.
  it.each([
    {
      name: "codex preset applied",
      agent: record({ currentModeId: "auto", config: { modeId: "auto" } as never }),
      live: "auto",
      authority: "authoritative",
    },
    {
      name: "live mode falls back to runtime, then config",
      agent: record({ runtimeInfo: { provider: "codex", modeId: "read-only" } as never }),
      live: "read-only",
      authority: "mode-not-applied",
    },
    {
      name: "codex sandbox override",
      agent: record({
        currentModeId: "read-only",
        config: { modeId: "read-only", providerOptions: { sandbox_mode: "danger-full-access" } },
      } as never),
      live: "read-only",
      authority: "provider-option-override",
    },
    {
      name: "codex approval override",
      agent: record({
        currentModeId: "auto",
        config: { modeId: "auto", providerOptions: { approval_policy: "never" } },
      } as never),
      live: "auto",
      authority: "provider-option-override",
    },
    {
      name: "controller-registered session",
      agent: record({
        currentModeId: "auto",
        config: { modeId: "auto", controllerExecutionId: "execution" },
      } as never),
      live: "auto",
      authority: "controller-governed",
    },
    {
      name: "claude mode with no overrides",
      agent: record({
        provider: "claude",
        currentModeId: "default",
        config: { modeId: "default" },
      } as never),
      live: "default",
      authority: "authoritative",
    },
    {
      name: "claude additional directories",
      agent: record({
        provider: "claude",
        currentModeId: "default",
        config: { modeId: "default", providerOptions: { additionalDirectories: ["/other"] } },
      } as never),
      live: "default",
      authority: "provider-option-override",
    },
    {
      name: "claude preapproved tools",
      agent: record({
        provider: "claude",
        currentModeId: "default",
        config: {
          modeId: "default",
          toolPolicy: { preapproved: [{ server: "paseo", tool: "create_agent" }] },
        },
      } as never),
      live: "default",
      authority: "tool-policy-grants",
    },
    {
      name: "provider changed the mode on its own",
      agent: record({
        provider: "claude",
        currentModeId: "plan",
        config: { modeId: "default" },
      } as never),
      live: "plan",
      authority: "mode-not-applied",
    },
    {
      name: "account id that extends codex",
      agent: record({
        provider: "codex-work",
        currentModeId: "auto",
        config: { modeId: "auto" },
      } as never),
      live: "auto",
      authority: "provider-not-established",
    },
    { name: "no mode at all", agent: record(), live: null, authority: "mode-absent" },
  ])("$name", ({ agent, live, authority }) => {
    expect(liveModeId(agent)).toBe(live);
    expect(modeAuthority(agent)).toBe(authority);
    const asserted = deriveAssertions(agent, agent);
    expect(asserted).toEqual({
      supervisorModeAuthoritative: authority === "authoritative",
      childModeAuthoritative: authority === "authoritative",
      // respond_to_permission accepts any agent and nothing disables project configuration yet.
      childPromptsAnsweredBy: "supervisor",
      childLoadsSupervisorWritableConfig: true,
    });
  });
});

const CEILING_MESSAGES = [
  WOULD_REFUSE_MESSAGE,
  ALLOWED_MESSAGE,
  SELF_ESCALATION_MESSAGE,
  SELF_CHANGE_MESSAGE,
  PERMISSION_ANSWER_MESSAGE,
  REPORT_FAILED_MESSAGE,
];

/** The fake provider's test feature is not in the access table and would make every side unmapped. */
function withoutFeatures(client: AgentClient): AgentClient {
  const strip = (session: AgentSession) =>
    Object.defineProperty(session, "features", { get: () => [] });
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "createSession" && property !== "resumeSession") return value.bind(target);
      return async (...args: unknown[]) => strip(await value.apply(target, args));
    },
  });
}

function providerSnapshots() {
  const stub = createProviderSnapshotManagerStub();
  const modes: Record<string, AgentMode[]> = {
    claude: [
      { id: "default", label: "Default" },
      { id: "bypassPermissions", label: "Bypass", isUnattended: true },
    ],
    codex: [
      { id: "auto", label: "Auto" },
      { id: "full-access", label: "Full access", isUnattended: true },
    ],
  };
  const entries = Object.entries(modes).map(([provider, providerModes]) => ({
    provider,
    status: "ready" as const,
    enabled: true,
    label: provider,
    modes: providerModes,
  }));
  stub.listRegisteredProviderIds.mockReturnValue(Object.keys(modes));
  stub.hasProvider.mockImplementation((provider) => provider in modes);
  stub.listProviders.mockResolvedValue(entries);
  stub.getProvider.mockImplementation(
    async (input) => entries.find((entry) => entry.provider === input.provider)!,
  );
  stub.listModes.mockImplementation(async (input) => modes[input.provider] ?? []);
  stub.resolveCreateConfig.mockImplementation(async (input) => ({
    modeId: input.requestedMode,
    featureValues: input.featureValues,
  }));
  return stub.manager;
}

function storedSchedule(input: CreateScheduleInput): StoredSchedule {
  const now = "2026-11-20T00:00:00.000Z";
  return {
    id: "schedule-1",
    name: input.name ?? null,
    prompt: input.prompt,
    cadence: input.cadence,
    target: input.target,
    status: "active",
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: input.expiresAt ?? null,
    maxRuns: input.maxRuns ?? null,
    runs: [],
  };
}

describe("access ceiling report-only logging", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.mocked(compareChildAccess).mockImplementation(
      (await vi.importActual<typeof import("./levels.js")>("./levels.js")).compareChildAccess,
    );
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function setup(supervisorMode = "default", supervisorProvider = "claude") {
    const home = realpathSync(await mkdtemp(join(tmpdir(), "ceiling-")));
    const logger = createTestLogger();
    const storage = new AgentStorage(join(home, "agents"), logger);
    const manager = new AgentManager({
      clients: Object.fromEntries(
        Object.entries(createTestAgentClients()).map(([id, client]) => [
          id,
          withoutFeatures(client),
        ]),
      ),
      registry: storage,
      logger,
    });
    const launch = (modeId: string, provider = "claude") =>
      manager.createAgent({ provider, cwd: home, modeId }, undefined, {
        workspaceId: "wks_ceiling",
      });
    const supervisor = await launch(supervisorMode, supervisorProvider);
    const child = await launch("default");
    const catalogLogger = createTestLogger();
    const toolLogger = catalogLogger.child({});
    // pino types a child's bindings differently from its parent; the instance is the same kind.
    vi.spyOn(catalogLogger, "child").mockReturnValue(toolLogger as never);
    const spies = {
      warn: vi.spyOn(toolLogger, "warn"),
      info: vi.spyOn(toolLogger, "info"),
      debug: vi.spyOn(toolLogger, "debug"),
    };
    const createOrReplace = vi.fn(async (input: CreateScheduleInput) => storedSchedule(input));
    const scheduleService = {
      createOrReplace,
      inspect: vi.fn(async () => createOrReplace.mock.results.at(-1)!.value as StoredSchedule),
      update: vi.fn(async (input: { name?: string | null }) => ({
        ...((await createOrReplace.mock.results.at(-1)!.value) as StoredSchedule),
        name: input.name ?? null,
      })),
      resume: vi.fn(async () => {}),
    };
    const messages = createTestAgentMessages({
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    const catalog = (callerAgentId?: string) =>
      createPaseoToolCatalog({
        agentMessages: () => messages,
        agentManager: manager,
        agentStorage: storage,
        logger: catalogLogger,
        paseoHome: home,
        serverId: "server-ceiling",
        ...(callerAgentId ? { callerAgentId } : {}),
        providerSnapshotManager: providerSnapshots(),
        scheduleService: scheduleService as unknown as ScheduleService,
      });
    const lines = (message: string, level?: keyof typeof spies) =>
      Object.entries(spies)
        .filter(([name]) => !level || name === level)
        .flatMap(([, spy]) => spy.mock.calls)
        .filter((call) => call[1] === message)
        .map((call) => call[0] as unknown as Record<string, unknown>);
    /** Lines a default-level daemon log would keep. */
    const visible = () =>
      CEILING_MESSAGES.flatMap((message) => [...lines(message, "warn"), ...lines(message, "info")]);
    cleanups.push(async () => {
      await manager.flush();
      await storage.flush();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    return {
      manager,
      supervisor,
      child,
      catalog,
      spies,
      lines,
      visible,
      createOrReplace,
      scheduleService,
      messages,
    };
  }

  /** Each operation an agent can run on another, with the result it returns today. */
  const operations = [
    {
      name: "set_agent_mode",
      args: (childId: string) => ({ agentId: childId, modeId: "bypassPermissions" }),
      expected: { success: true, newMode: "bypassPermissions" },
      message: WOULD_REFUSE_MESSAGE,
    },
    {
      name: "update_agent",
      args: (childId: string) => ({ agentId: childId, settings: { modeId: "bypassPermissions" } }),
      expected: { success: true },
      message: WOULD_REFUSE_MESSAGE,
    },
    {
      name: "respond_to_permission",
      args: (childId: string) => ({
        agentId: childId,
        requestId: "request-1",
        response: { behavior: "allow" },
      }),
      expected: { success: true },
      message: PERMISSION_ANSWER_MESSAGE,
    },
    {
      // Queued: the recipient's mode is set when the batch dispatches.
      name: "send_agent_prompt",
      args: (childId: string) => ({
        agentId: childId,
        prompt: "Continue",
        sessionMode: "bypassPermissions",
        notifyOnFinish: false,
      }),
      expected: { success: true, deliveryStatus: "queued" },
      message: WOULD_REFUSE_MESSAGE,
    },
  ] as const;

  it("creates a child above its supervisor as before and logs one would-refuse line", async () => {
    const fixture = await setup();
    const result = await fixture.catalog(fixture.supervisor.id).executeTool("create_agent", {
      relationship: { kind: "subagent" },
      workspace: { kind: "current" },
      title: "Child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
      notifyOnFinish: false,
      settings: { modeId: "full-access" },
    });
    const childId = z.object({ agentId: z.string() }).parse(result.structuredContent).agentId;
    expect(result.structuredContent).toMatchObject({ currentModeId: "full-access" });
    await vi.waitFor(() => expect(fixture.lines(WOULD_REFUSE_MESSAGE)).toHaveLength(1));
    expect(fixture.lines(WOULD_REFUSE_MESSAGE)[0]).toMatchObject({
      operation: "create_agent",
      callerAgentId: fixture.supervisor.id,
      targetAgentId: childId,
      callerProvider: "claude",
      targetProvider: "codex",
      targetMode: "full-access",
      result: "refused",
      reasons: "permission:exceeds-supervisor",
      classification: "known-violation",
      assertedChildPromptsAnsweredBy: "supervisor",
      assertedChildLoadsSupervisorWritableConfig: true,
    });
  });

  it.each(operations)("$name on another agent succeeds as before and logs", async (operation) => {
    const fixture = await setup();
    vi.spyOn(fixture.manager, "respondToPermission").mockResolvedValue(undefined);
    const result = await fixture
      .catalog(fixture.supervisor.id)
      .executeTool(operation.name, operation.args(fixture.child.id));
    expect(result.structuredContent).toMatchObject(operation.expected);
    await vi.waitFor(() => expect(fixture.visible()).toHaveLength(1));
    if (operation.name !== "respond_to_permission")
      expect(fixture.manager.getAgent(fixture.child.id)?.currentModeId).toBe("bypassPermissions");
    expect(fixture.lines(operation.message)[0]).toMatchObject({
      operation: operation.name,
      callerAgentId: fixture.supervisor.id,
      targetAgentId: fixture.child.id,
      result: "refused",
      reasons: "permission:exceeds-supervisor",
    });
  });

  // Who answers prompts is the fact the ceiling depends on, so it is counted whatever the
  // comparator says, including when an unattended responder would be allowed.
  // The last row's answer raises the requester's mode, as approving a plan exit does.
  it.each([
    ["attended", "default", "deny", null],
    ["unattended", "bypassPermissions", "allow", null],
    ["raising", "bypassPermissions", "allow", "bypassPermissions"],
  ] as const)(
    "logs a %s agent's answer to another agent's prompt at info",
    async (_, mode, behavior, raisesTo) => {
      const fixture = await setup(mode);
      vi.spyOn(fixture.manager, "respondToPermission").mockImplementation(async (agentId) => {
        if (raisesTo) await fixture.manager.setAgentMode(agentId, raisesTo);
      });
      await fixture.catalog(fixture.supervisor.id).executeTool("respond_to_permission", {
        agentId: fixture.child.id,
        requestId: "request-1",
        response: { behavior },
      });
      await vi.waitFor(() =>
        expect(fixture.lines(PERMISSION_ANSWER_MESSAGE, "info")).toHaveLength(1),
      );
      expect(fixture.lines(PERMISSION_ANSWER_MESSAGE, "info")[0]).toMatchObject({
        operation: "respond_to_permission",
        callerAgentId: fixture.supervisor.id,
        targetAgentId: fixture.child.id,
        callerProvider: "claude",
        targetProvider: "claude",
        callerMode: mode,
        targetMode: raisesTo ?? "default",
        behavior,
        modeBefore: "default",
        modeAfter: raisesTo ?? "default",
        modeChanged: raisesTo !== null,
        tierBefore: "attended",
        tierAfter: raisesTo ? "unattended" : "attended",
        classBefore: "owner-gated-writes",
      });
      expect(fixture.lines(WOULD_REFUSE_MESSAGE)).toEqual([]);
    },
  );

  it("logs a self-escalation once and a self-restriction not at all", async () => {
    const fixture = await setup();
    const tools = fixture.catalog(fixture.supervisor.id);
    const self = { agentId: fixture.supervisor.id };
    await tools.executeTool("set_agent_mode", { ...self, modeId: "bypassPermissions" });
    await vi.waitFor(() => expect(fixture.visible()).toHaveLength(1));
    expect(fixture.lines(SELF_ESCALATION_MESSAGE, "warn")[0]).toMatchObject({
      operation: "self_set_agent_mode",
      agentId: fixture.supervisor.id,
      modeBefore: "default",
      modeAfter: "bypassPermissions",
      tierBefore: "attended",
      tierAfter: "unattended",
      reason: "self-escalation",
    });
    await tools.executeTool("set_agent_mode", { ...self, modeId: "default" });
    await vi.waitFor(() => expect(fixture.lines(SELF_CHANGE_MESSAGE, "debug")).toHaveLength(1));
    expect(fixture.visible()).toHaveLength(1);
    expect(fixture.lines(WOULD_REFUSE_MESSAGE)).toEqual([]);
  });

  // Each row is one change an agent makes to itself, and whether a default-level log shows it.
  it.each([
    ["opencode", "build", "full-access", "self-escalation"],
    ["opencode", "plan", "full-access", "self-escalation"],
    ["claude", "default", "acceptEdits", "self-class-escalation"],
    ["claude", "default", "auto", "self-class-escalation"],
    ["claude", "acceptEdits", "auto", "self-class-change"],
    ["claude", "acceptEdits", "default", null],
  ] as const)("%s %s to %s logs %s", async (provider, from, to, reason) => {
    const fixture = await setup(from, provider);
    await fixture
      .catalog(fixture.supervisor.id)
      .executeTool("set_agent_mode", { agentId: fixture.supervisor.id, modeId: to });
    await vi.waitFor(() =>
      expect(fixture.lines(reason ? SELF_ESCALATION_MESSAGE : SELF_CHANGE_MESSAGE)).toHaveLength(1),
    );
    expect(fixture.visible()).toHaveLength(reason ? 1 : 0);
    if (reason) {
      expect(fixture.lines(SELF_ESCALATION_MESSAGE)[0]).toMatchObject({
        operation: "self_set_agent_mode",
        modeBefore: from,
        modeAfter: to,
        reason,
      });
    }
  });

  it("logs an applied mode change when a later update step fails, and nothing for no change", async () => {
    const fixture = await setup();
    const tools = fixture.catalog(fixture.supervisor.id);
    await tools.executeTool("update_agent", {
      agentId: fixture.child.id,
      settings: { features: {} },
    });
    vi.spyOn(fixture.manager, "setAgentFeature").mockRejectedValue(new Error("feature failed"));
    await expect(
      tools.executeTool("update_agent", {
        agentId: fixture.child.id,
        settings: { modeId: "bypassPermissions", features: { fast_mode: true } },
      }),
    ).rejects.toThrow("feature failed");
    await vi.waitFor(() => expect(fixture.lines(WOULD_REFUSE_MESSAGE)).toHaveLength(1));
    expect(fixture.lines(WOULD_REFUSE_MESSAGE)[0]).toMatchObject({
      operation: "update_agent",
      change: "mode",
      targetMode: "bypassPermissions",
    });
    expect(fixture.visible()).toHaveLength(1);
  });

  it("creates a schedule exactly as before and logs its unattended future agent", async () => {
    const fixture = await setup();
    const result = await fixture.catalog(fixture.supervisor.id).executeTool("create_schedule", {
      prompt: "Nightly work",
      cron: "0 3 * * *",
    });
    expect(fixture.createOrReplace).toHaveBeenCalledTimes(1);
    const input = fixture.createOrReplace.mock.calls[0]![0];
    expect(input.target).toMatchObject({
      type: "new-agent",
      config: { provider: "claude", modeId: "default" },
    });
    expect(result.structuredContent).toMatchObject({ id: "schedule-1", status: "active" });
    await vi.waitFor(() => expect(fixture.lines(WOULD_REFUSE_MESSAGE)).toHaveLength(1));
    expect(fixture.lines(WOULD_REFUSE_MESSAGE)[0]).toMatchObject({
      operation: "create_schedule",
      callerAgentId: fixture.supervisor.id,
      targetAgentId: null,
      scheduleId: "schedule-1",
      targetProvider: "claude",
      targetMode: "default",
      requestedUnattended: true,
      result: "refused",
      reasons: "permission:exceeds-supervisor",
    });
    expect(fixture.lines(WOULD_REFUSE_MESSAGE)[0]!.childEscalations).toContain("unattended-flag");

    // A name-only update leaves the future agent alone and logs nothing; a resume logs it again.
    const tools = fixture.catalog(fixture.supervisor.id);
    await tools.executeTool("update_schedule", { id: "schedule-1", name: "Renamed" });
    expect(fixture.scheduleService.update).toHaveBeenCalledTimes(1);
    await tools.executeTool("resume_schedule", { id: "schedule-1" });
    expect(fixture.scheduleService.resume).toHaveBeenCalledWith("schedule-1");
    await vi.waitFor(() => expect(fixture.lines(WOULD_REFUSE_MESSAGE)).toHaveLength(2));
    expect(fixture.lines(WOULD_REFUSE_MESSAGE)[1]).toMatchObject({
      operation: "resume_schedule",
      scheduleId: "schedule-1",
      scheduleCreator: "not-recorded",
    });
  });

  // A failed dispatch logs only a mode change that happened: the mode is set before the run.
  it.each([
    ["the mode change is rejected", "setAgentMode", 0],
    ["the run fails after the mode is applied", "tryRunOutOfBand", 1],
  ] as const)("a sessionMode prompt whose dispatch fails because %s", async (_, step, count) => {
    const fixture = await setup();
    const failing = vi
      .spyOn(fixture.manager, step)
      .mockRejectedValueOnce(new Error("dispatch failed"));
    const result = await fixture.catalog(fixture.supervisor.id).executeTool("send_agent_prompt", {
      agentId: fixture.child.id,
      prompt: "Continue",
      sessionMode: "bypassPermissions",
      notifyOnFinish: false,
    });
    expect(result.structuredContent).toMatchObject({ success: true, deliveryStatus: "queued" });
    await fixture.messages
      .waitForDispatch(fixture.child.id, new AbortController().signal)
      .catch(() => undefined);
    expect(failing).toHaveBeenCalled();
    expect(fixture.manager.getAgent(fixture.child.id)?.currentModeId).toBe(
      count ? "bypassPermissions" : "default",
    );
    await vi.waitFor(() => expect(fixture.lines(WOULD_REFUSE_MESSAGE)).toHaveLength(count));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.lines(WOULD_REFUSE_MESSAGE)).toHaveLength(count);
    if (count)
      expect(fixture.lines(WOULD_REFUSE_MESSAGE)[0]).toMatchObject({
        operation: "send_agent_prompt",
        change: "session-mode",
        dispatch: "failed-after-mode",
        targetMode: "bypassPermissions",
      });
  });

  it("logs nothing for a prompt sent without sessionMode", async () => {
    const fixture = await setup();
    const result = await fixture.catalog(fixture.supervisor.id).executeTool("send_agent_prompt", {
      agentId: fixture.child.id,
      prompt: "Continue",
      notifyOnFinish: false,
    });
    expect(result.structuredContent).toMatchObject({ success: true, deliveryStatus: "queued" });
    await fixture.messages.waitForDispatch(fixture.child.id, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.manager.getAgent(fixture.child.id)?.currentModeId).toBe("default");
    for (const message of CEILING_MESSAGES) expect(fixture.lines(message)).toEqual([]);
  });

  it("logs nothing for a session without a calling agent", async () => {
    const fixture = await setup();
    const result = await fixture
      .catalog()
      .executeTool("set_agent_mode", { agentId: fixture.child.id, modeId: "bypassPermissions" });
    expect(result.structuredContent).toEqual({ success: true, newMode: "bypassPermissions" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const message of CEILING_MESSAGES) expect(fixture.lines(message)).toEqual([]);
  });

  it.each(["comparator", "logger"] as const)(
    "keeps every operation's result when the %s throws",
    async (failure) => {
      const fixture = await setup();
      vi.spyOn(fixture.manager, "respondToPermission").mockResolvedValue(undefined);
      if (failure === "comparator") {
        vi.mocked(compareChildAccess).mockImplementation(() => {
          throw new Error("comparator failed");
        });
      } else {
        for (const spy of Object.values(fixture.spies)) {
          spy.mockImplementation(((...args: unknown[]) => {
            if (CEILING_MESSAGES.includes(args[1] as string)) throw new Error("logger failed");
          }) as never);
        }
      }
      for (const operation of operations) {
        const result = await fixture
          .catalog(fixture.supervisor.id)
          .executeTool(operation.name, operation.args(fixture.child.id));
        expect(result.structuredContent).toMatchObject(operation.expected);
      }
      // Each failure was reached: the comparator's is logged once per operation with a fixed
      // code; the logger's is swallowed after the attempt.
      if (failure === "comparator") {
        await vi.waitFor(() =>
          expect(fixture.lines(REPORT_FAILED_MESSAGE)).toHaveLength(operations.length),
        );
        expect(fixture.lines(REPORT_FAILED_MESSAGE)[0]).toMatchObject({
          code: REPORT_FAILED_CODE,
          reason: "error",
        });
      } else {
        await vi.waitFor(() =>
          expect(
            fixture.lines(WOULD_REFUSE_MESSAGE).length +
              fixture.lines(PERMISSION_ANSWER_MESSAGE).length,
          ).toBe(operations.length),
        );
      }
    },
  );
});
