import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage, parseStoredAgentRecord, type StoredAgentRecord } from "../agent-storage.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createRestartRecovery } from "./index.js";

test("recovery saves intent before normalization, clears before dispatch, and resumes each agent independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const [id, lastStatus] of [
      ["broken", "running"],
      ["stuck", "running"],
      ["working", "running"],
      ["idle", "idle"],
      ["initializing", "initializing"],
    ] as const) {
      await storage.upsert(
        parseStoredAgentRecord({
          id,
          lastStatus,
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Continue verbatim.\n" }),
      eligible: async () => true,
      dispatch: async (id, prompt) => {
        expect((await storage.get(id))?.resumeOnStartup).toBe(false);
        if (id === "broken") throw new Error("unavailable");
        if (id === "stuck") return new Promise(() => {});
        dispatched.push(id + prompt);
      },
      report: () => {},
    });
    await recovery.prepareStartup();
    expect((await storage.get("working"))?.resumeOnStartup).toBe(true);
    expect((await storage.get("working"))?.lastStatus).toBe("closed");
    recovery.resumePending();
    const running = new AbortController().signal;
    await recovery.waitForResume("broken", running);
    await recovery.waitForResume("working", running);
    await recovery.waitForResume("idle", running);
    expect(dispatched).toEqual(["workingContinue verbatim.\n"]);
    const stopped = new AbortController();
    stopped.abort();
    await expect(recovery.waitForResume("stuck", stopped.signal)).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-out consumes pending recovery and excludes archived, private, owned and archived-workspace agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const extra of [
      { id: "running" },
      { id: "archived", archivedAt: "today" },
      { id: "private", internal: true },
      { id: "owned", owner: { kind: "daemon", daemonId: "hub", executionId: "run" } },
      { id: "workspace", workspaceId: "archived" },
    ]) {
      await storage.upsert(
        parseStoredAgentRecord({
          lastStatus: "running",
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...extra,
        }),
      );
    }
    let enabled = true;
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled, prompt: "Resume working." }),
      eligible: async (record) => record.workspaceId !== "archived",
      dispatch: async (id) => {
        dispatched.push(id);
      },
      report: () => {},
    });
    await recovery.captureRunningAgents();
    expect((await storage.get("running"))?.resumeOnStartup).toBe(true);
    enabled = false;
    await recovery.prepareStartup();
    enabled = true;
    recovery.resumePending();
    expect(dispatched).toEqual([]);
    expect((await storage.list()).every((record) => !record.resumeOnStartup)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class DeferredRecoveryStorage extends AgentStorage {
  nextRecoveryWrite: {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  } | null = null;

  override async updateRestartRecovery(
    expected: StoredAgentRecord,
    update: Parameters<AgentStorage["updateRestartRecovery"]>[1],
  ): Promise<StoredAgentRecord | null> {
    const gate = this.nextRecoveryWrite;
    this.nextRecoveryWrite = null;
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    return super.updateRestartRecovery(expected, update);
  }
}

test.each(
  (["resume", "startup normalization", "shutdown capture"] as const).flatMap((phase) =>
    (["queue goal hold", "usage hold", "quota pause", "archive", "owner", "config"] as const).map(
      (change) => ({ phase, change }),
    ),
  ),
)(
  "$phase preserves a newer durable $change across its metadata write",
  async ({ phase, change }) => {
    const root = await mkdtemp(join(tmpdir(), "restart-recovery-custody-"));
    const storage = new DeferredRecoveryStorage(root, createTestLogger());
    const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    let operation: Promise<void> | undefined;
    try {
      await storage.upsert(
        parseStoredAgentRecord({
          id: "agent",
          provider: "codex",
          cwd: root,
          lastStatus: "running",
          resumeOnStartup: false,
          config: { model: "frozen-model" },
          createdAt: "2026-11-01T00:00:00Z",
          updatedAt: "2026-11-01T00:00:00Z",
        }),
      );
      const dispatched: string[] = [];
      const reported: unknown[] = [];
      const recovery = createRestartRecovery({
        storage,
        settings: () => ({ enabled: true, prompt: "Continue" }),
        eligible: async (record) =>
          !record.queueGoalHold && !record.config?.quotaPausedAt && !record.config?.usageLimitHold,
        dispatch: async (id) => {
          dispatched.push(id);
        },
        report: (_id, error) => {
          reported.push(error);
        },
      });
      if (phase === "resume") await recovery.prepareStartup();
      storage.nextRecoveryWrite = gate;
      if (phase === "resume") {
        recovery.resumePending();
        operation = recovery.waitForResume("agent", new AbortController().signal);
      } else if (phase === "startup normalization") operation = recovery.prepareStartup();
      else operation = recovery.captureRunningAgents();
      await gate.entered.promise;
      const beforeOwnerWrite = (await storage.get("agent"))!;
      if (change === "queue goal hold") {
        await storage.updateQueueGoalHold("agent", {
          phase: "held",
          reason: "restart",
          restartRequestId: "newer-exact-restart",
          goal: {
            threadId: "native-thread",
            objective: "Keep the owner's paused work",
            status: "blocked",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        });
      } else {
        const next = structuredClone(beforeOwnerWrite);
        if (change === "archive") next.archivedAt = "2026-11-01T01:00:00Z";
        else if (change === "owner")
          next.owner = { kind: "daemon", daemonId: "new-owner", executionId: "new-execution" };
        else if (change === "usage hold")
          next.config = {
            ...next.config,
            usageLimitHold: { stoppedAt: "2026-11-01T01:00:00Z", attempts: 0 },
          };
        else if (change === "quota pause")
          next.config = { ...next.config, quotaPausedAt: "2026-11-01T01:00:00Z" };
        else next.config = { ...next.config, model: "new-owner-model" };
        await storage.upsert(next);
      }
      const newest = structuredClone((await storage.get("agent"))!);
      gate.release.resolve();
      await operation;
      recovery.resumePending();
      await recovery.waitForResume("agent", new AbortController().signal);
      expect(dispatched).toEqual([]);
      expect(reported).toEqual([]);
      expect(await storage.get("agent")).toEqual(newest);
      const reopened = new AgentStorage(root, createTestLogger());
      expect(await reopened.get("agent")).toEqual(
        parseStoredAgentRecord(JSON.parse(JSON.stringify(newest))),
      );
    } finally {
      gate.release.resolve();
      await operation;
      await storage.flush();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("recovery metadata compares custody inside the serialized owner-write lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-storage-lane-"));
  const storage = new AgentStorage(root, createTestLogger());
  try {
    await storage.upsert(
      parseStoredAgentRecord({
        id: "agent",
        provider: "codex",
        cwd: root,
        lastStatus: "running",
        resumeOnStartup: false,
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
      }),
    );
    const before = structuredClone((await storage.get("agent"))!);
    const prepared = await storage.updateRestartRecovery(before, {
      resumeOnStartup: true,
      lastStatus: "closed",
    });
    expect(prepared).toEqual({ ...before, resumeOnStartup: true, lastStatus: "closed" });
    const expected = structuredClone((await storage.get("agent"))!);
    const ownerWrite = storage.updateQueueGoalHold("agent", {
      phase: "held",
      reason: "restart",
      restartRequestId: "exact-owner-restart",
      goal: {
        threadId: "native-thread",
        objective: "Preserve serialized custody",
        status: "blocked",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const recoveryWrite = storage.updateRestartRecovery(expected, { resumeOnStartup: false });
    await ownerWrite;
    const newest = structuredClone((await storage.get("agent"))!);
    expect(await recoveryWrite).toBeNull();
    expect(await storage.get("agent")).toEqual(newest);
    expect(newest.queueGoalHold?.restartRequestId).toBe("exact-owner-restart");
    expect(newest.resumeOnStartup).toBe(true);
    const reopened = new AgentStorage(root, createTestLogger());
    expect(await reopened.get("agent")).toEqual(
      parseStoredAgentRecord(JSON.parse(JSON.stringify(newest))),
    );
  } finally {
    await storage.flush();
    await rm(root, { recursive: true, force: true });
  }
});
