import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { UsageLimitHold } from "@getpaseo/protocol/usage-limit";
import type { AgentProfile, ProviderUsage } from "@getpaseo/protocol/messages";
import type { StoredAgentRecord } from "../agent-storage.js";
import type { TeamWorkerAccountChoice } from "../create-agent/create.js";
import { reopenWorkerAfterUsageLimit } from "./worker-recovery.js";
import {
  CONTINUED_FROM_LABEL,
  readingFromProviderUsage,
  usageLimitContinuationText,
  UsageLimitResumeService,
  type AccountUsageReading,
} from "./resume-service.js";

const logger = pino({ level: "silent" });
const MINUTE = 60_000;
const T0 = Date.parse("2026-10-22T10:00:00.000Z");

function record(
  id: string,
  usageLimitHold: UsageLimitHold | undefined,
  extra: Partial<StoredAgentRecord> = {},
): StoredAgentRecord {
  return {
    id,
    provider: "claude",
    labels: {},
    config: usageLimitHold ? { usageLimitHold } : {},
    ...extra,
  } as StoredAgentRecord;
}

function hold(overrides: Partial<UsageLimitHold> = {}): UsageLimitHold {
  return {
    stoppedAt: new Date(T0).toISOString(),
    resetsAt: new Date(T0 + 60 * MINUTE).toISOString(),
    attempts: 0,
    ...overrides,
  };
}

describe("supervisor usage-stop recovery", () => {
  const worker: AgentProfile = { id: "worker", name: "Worker", provider: "codex", model: "model" };
  const supervisor = record("supervisor", undefined, {
    config: {
      profileLaunch: { profile: { ...worker, id: "supervisor" }, workers: [worker] },
    },
  });
  const governance = {
    supervisorAgentId: supervisor.id,
    serverId: "host",
    workerProfileId: worker.id,
  };
  const input = {
    agentId: "child",
    supervisorId: supervisor.id,
    serverId: "host",
    inScope: (cwd: string) => cwd === "/team",
  };

  function recoveryHarness(
    child: StoredAgentRecord,
    choice: TeamWorkerAccountChoice = {
      provider: "alternate",
      reason: "known-headroom",
      earliestResetAt: null,
    },
  ) {
    const dependencies: Parameters<typeof reopenWorkerAfterUsageLimit>[0] = {
      agentStorage: {
        get: async (id) => {
          if (id === child.id) return child;
          if (id === supervisor.id) return supervisor;
          if (id === "unrelated-supervisor") return { ...supervisor, id };
          return null;
        },
      },
      pickTeamWorkerAccount: vi.fn(async () => choice),
      switchProfile: vi.fn(async (target, options) => {
        await options.validateScope?.({
          provider: child.provider,
          cwd: child.cwd,
          workspaceId: child.workspaceId,
        });
        return { agentId: target.agentId, outcome: "switched" };
      }),
    };
    return dependencies;
  }

  function workerRecord(proof: StoredAgentRecord["workerGovernance"]): StoredAgentRecord {
    return record(input.agentId, undefined, {
      provider: "codex",
      cwd: "/team",
      labels: { [PARENT_AGENT_ID_LABEL]: supervisor.id },
      config: { profileLaunch: { profile: worker }, usageLimitHold: hold() },
      workerGovernance: proof,
    });
  }

  it("reopens the same worker with a recorded quota switch", async () => {
    const child = workerRecord(governance);
    const dependencies = recoveryHarness(child);
    expect(await reopenWorkerAfterUsageLimit(dependencies, input)).toEqual({
      outcome: "reopened",
      provider: "alternate",
      reason: "known-headroom",
    });
    expect(dependencies.switchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: child.id, profileId: worker.id, reason: "quota" }),
      expect.objectContaining({ workerRecovery: true }),
    );
    expect(dependencies.pickTeamWorkerAccount).toHaveBeenCalledWith(
      expect.objectContaining({ worker, avoidProvider: child.provider }),
    );
  });

  it("refuses another supervisor even when its roster contains the same worker profile", async () => {
    const dependencies = recoveryHarness(workerRecord(governance));
    expect(
      await reopenWorkerAfterUsageLimit(dependencies, {
        ...input,
        supervisorId: "unrelated-supervisor",
      }),
    ).toEqual({ outcome: "refused", reason: "not-supervised-worker" });
    expect(dependencies.pickTeamWorkerAccount).not.toHaveBeenCalled();
    expect(dependencies.switchProfile).not.toHaveBeenCalled();
  });

  it.each([undefined, { ...governance, supervisorAgentId: "different-supervisor" }])(
    "refuses a matching parent label without matching daemon governance (%j)",
    async (proof) => {
      const dependencies = recoveryHarness(workerRecord(proof));
      expect(await reopenWorkerAfterUsageLimit(dependencies, input)).toEqual({
        outcome: "refused",
        reason: "not-supervised-worker",
      });
      expect(dependencies.switchProfile).not.toHaveBeenCalled();
      expect(dependencies.pickTeamWorkerAccount).not.toHaveBeenCalled();
    },
  );

  it("records an unreadable alternate and the low account skipped during recovery", async () => {
    const child = workerRecord(governance);
    const dependencies = recoveryHarness(child, {
      provider: "alternate",
      reason: "alternate-usage-unreadable",
      earliestResetAt: null,
      droppedLowProviders: ["low"],
    });
    expect(await reopenWorkerAfterUsageLimit(dependencies, input)).toEqual({
      outcome: "reopened",
      provider: "alternate",
      reason: "alternate-usage-unreadable",
      droppedLowProviders: ["low"],
    });
    expect(dependencies.switchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        explanation: expect.stringContaining("Skipped accounts at or below the quota floor: low."),
      }),
      expect.anything(),
    );
  });
});

/** A daemon stand-in: holds live on stored records, and released threads record their prompt. */
function harness(
  records: StoredAgentRecord[],
  options: {
    reading?: AccountUsageReading;
    autoResume?: boolean;
    pausedQueues?: string[];
  } = {},
) {
  let now = T0;
  const released: Array<{ id: string; text: string }> = [];
  const readings: string[] = [];
  const byId = new Map(records.map((entry) => [entry.id, entry]));
  const update = async (
    id: string,
    change: (current: UsageLimitHold | undefined) => UsageLimitHold | null | undefined,
  ) => {
    const entry = byId.get(id)!;
    const next = change(entry.config?.usageLimitHold);
    if (next === undefined) return entry.config?.usageLimitHold ?? null;
    entry.config = { ...entry.config, usageLimitHold: next ?? undefined };
    return next;
  };
  const service = new UsageLimitResumeService({
    agentStorage: { list: async () => [...byId.values()] },
    agentManager: {
      isRestartDraining: () => false,
      updateUsageLimitHold: update,
      resumeAfterUsageLimit: async (id, { text }) => {
        if (options.pausedQueues?.includes(id)) return false;
        released.push({ id, text });
        return update(id, (current) =>
          current
            ? {
                ...current,
                attempts: current.attempts + 1,
                releasedAt: new Date(now).toISOString(),
              }
            : undefined,
        );
      },
    },
    readUsage: async (provider) => {
      readings.push(provider);
      return options.reading ?? { kind: "unknown" };
    },
    autoResumeEnabled: () => options.autoResume ?? true,
    logger,
    now: () => now,
  });
  return {
    service,
    released,
    readings,
    byId,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe("UsageLimitResumeService", () => {
  it("waits for the reported reset plus a grace period, then releases one thread per account at a time", async () => {
    const h = harness([
      record("first", hold()),
      record("second", hold({ stoppedAt: new Date(T0 + MINUTE).toISOString() })),
      record("codex-thread", hold(), { provider: "codex" } as Partial<StoredAgentRecord>),
    ]);

    h.at(T0 + 61 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);

    h.at(T0 + 62 * MINUTE);
    await h.service.tick();
    expect(h.released.map((entry) => entry.id)).toEqual(["first", "codex-thread"]);
    expect(h.readings).toEqual([]);

    // The next thread on the same account waits out the stagger.
    h.at(T0 + 63 * MINUTE);
    await h.service.tick();
    expect(h.released).toHaveLength(2);
    h.at(T0 + 64 * MINUTE);
    await h.service.tick();
    expect(h.released.map((entry) => entry.id)).toEqual(["first", "codex-thread", "second"]);
    expect(h.byId.get("first")?.config?.usageLimitHold).toMatchObject({ attempts: 1 });
  });

  it("skips threads that continue elsewhere, opted out, archived or owned by another controller", async () => {
    const h = harness([
      record("continued", hold()),
      record("successor", undefined, { labels: { [CONTINUED_FROM_LABEL]: "continued" } }),
      record("opted-out", hold({ optOut: true })),
      record("archived", hold(), { archivedAt: new Date(T0).toISOString() }),
      record("controlled", hold(), { owner: { kind: "daemon" } } as Partial<StoredAgentRecord>),
    ]);
    h.at(T0 + 3 * 60 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);
  });

  it("leaves every thread waiting when the account's resume switch is off", async () => {
    const h = harness([record("thread", hold())], { autoResume: false });
    h.at(T0 + 3 * 60 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);
  });

  it("asks the usage reader when a stop reported no reset, and adopts its reset time", async () => {
    const resetsAt = new Date(T0 + 5 * 60 * MINUTE).toISOString();
    const h = harness([record("codex", hold({ resetsAt: undefined }))], {
      reading: { kind: "limited", resetsAt },
    });
    h.at(T0 + 31 * MINUTE);
    await h.service.tick();
    expect(h.readings).toEqual(["claude"]);
    expect(h.released).toEqual([]);
    expect(h.byId.get("codex")?.config?.usageLimitHold?.resetsAt).toBe(resetsAt);
  });

  it("probes an account with no usage reading after a backoff", async () => {
    const h = harness([record("probe", hold({ resetsAt: undefined }))]);
    h.at(T0 + 29 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);
    h.at(T0 + 30 * MINUTE);
    await h.service.tick();
    expect(h.released.map((entry) => entry.id)).toEqual(["probe"]);
  });

  it("stops after three automatic attempts and leaves the decision to the owner", async () => {
    const h = harness([record("stubborn", hold({ attempts: 3 }))]);
    h.at(T0 + 3 * 60 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);
    expect(h.byId.get("stubborn")?.config?.usageLimitHold).toMatchObject({ gaveUp: true });
  });

  it("passes over a paused queue and releases the next thread", async () => {
    const h = harness(
      [
        record("paused", hold()),
        record("ready", hold({ stoppedAt: new Date(T0 + MINUTE).toISOString() })),
      ],
      { pausedQueues: ["paused"] },
    );
    h.at(T0 + 3 * 60 * MINUTE);
    await h.service.tick();
    expect(h.released.map((entry) => entry.id)).toEqual(["ready"]);
    expect(h.byId.get("paused")?.config?.usageLimitHold?.releasedAt).toBeUndefined();
  });
});

describe("usage-limit helpers", () => {
  it("mentions a multi-day wait in the continuation", () => {
    const stop = hold();
    expect(usageLimitContinuationText(stop, { manual: false, now: T0 + 3 * 60 * MINUTE })).toBe(
      "Your previous turn stopped at a usage limit, which has now reset. Check what was already done, then continue the authorized work, following the owner's latest instructions.",
    );
    expect(
      usageLimitContinuationText(stop, { manual: false, now: T0 + 3 * 24 * 60 * MINUTE }),
    ).toContain("This thread waited 3 days for the reset");
    expect(usageLimitContinuationText(stop, { manual: true, now: T0 })).toMatch(
      /^The owner resumed this thread/,
    );
  });

  it("reads a used-up window as limited until its latest reset", () => {
    const usage = (windows: ProviderUsage["windows"]): ProviderUsage =>
      ({ providerId: "claude", status: "available", windows }) as ProviderUsage;
    const later = new Date(T0 + 7 * 24 * 60 * MINUTE).toISOString();
    expect(
      readingFromProviderUsage(
        usage([
          { id: "5h", label: "5h", usedPct: 100, resetsAt: new Date(T0 + MINUTE).toISOString() },
          { id: "wk", label: "Week", usedPct: 100, resetsAt: later },
        ]),
        T0,
      ),
    ).toEqual({ kind: "limited", resetsAt: later });
    expect(readingFromProviderUsage(usage([{ id: "5h", label: "5h", usedPct: 40 }]), T0)).toEqual({
      kind: "available",
    });
    expect(readingFromProviderUsage(undefined, T0)).toEqual({ kind: "unknown" });
  });
});
