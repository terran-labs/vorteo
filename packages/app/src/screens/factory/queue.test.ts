import { describe, expect, it } from "vitest";
import {
  factoryQueueRefreshInterval,
  loadFactoryQueue,
  factoryAgentStatusKey,
  type FactoryInvoke,
} from "./queue";
import { ProjectFactoryStateSchema } from "@/components/sidebar/factory-state";
import { FACTORY_LANES, factoryLanes, factoryTrack, shownReports } from "./overview-model";
import {
  activeDrains,
  aggregateStageCounts,
  canResumeHost,
  canStopHost,
  hostStopState,
  selectFreshTargets,
} from "./all-factories-model";
import { OWNER_STOP_REASON } from "./factory-reads";

const emptyQueue = { fetchedAt: "2026-11-04T12:00:00Z", error: null, issues: [] };
const oldState = {
  schemaVersion: 1,
  serverId: "host",
  projectId: "project",
  state: "on",
  repository: "owner/repo",
  reason: null,
  workers: { workerProfileId: null, reviewerProfileId: null },
  roles: [],
};

describe("Factory overview daemon compatibility", () => {
  it("checks a cold paused refresh until it settles and preserves overview cadence", () => {
    expect(
      factoryQueueRefreshInterval({
        queue: { ...emptyQueue, refreshing: true },
        enabled: true,
        polling: false,
      }),
    ).toBe(2_000);
    expect(factoryQueueRefreshInterval({ queue: emptyQueue, enabled: true, polling: false })).toBe(
      false,
    );
    expect(
      factoryQueueRefreshInterval({
        queue: emptyQueue,
        enabled: true,
        polling: true,
        steadyMs: 30_000,
      }),
    ).toBe(30_000);
  });

  it("retains stage and drain controls only when the daemon supplies them", () => {
    const old = ProjectFactoryStateSchema.parse(oldState);
    expect(old.workers.plannerProfileId).toBeUndefined();
    expect(old.drain).toBeUndefined();
    const drain = { id: "drain", reason: "update", pausedAt: "2026-11-04T12:00:00Z" };
    const current = ProjectFactoryStateSchema.parse({
      ...oldState,
      drain,
      workers: { ...oldState.workers, plannerProfileId: "planner", planning: false },
    });
    expect(current.workers).toEqual({
      ...oldState.workers,
      plannerProfileId: "planner",
      planning: false,
    });
    expect(current.drain).toEqual(drain);
  });

  it("loads issue, review, check and thread targets from the queue", async () => {
    const issue = {
      number: 12,
      title: "Fix navigation",
      url: "https://github.com/owner/repo/issues/12",
      label: "running",
      stage: "review",
      pr: {
        number: 13,
        url: "https://github.com/owner/repo/pull/13",
        headSha: "head",
        checks: "passing",
        reviewDecision: null,
      },
      agents: [{ role: "reviewer", agentId: "reviewer-thread", status: "running" }],
    };
    const invoke: FactoryInvoke = async (method, input) => {
      expect(method).toBe("factory.project.queue");
      expect(input).toEqual({ projectId: "project" });
      return { ...emptyQueue, issues: [issue] };
    };
    expect(await loadFactoryQueue(invoke, "project")).toEqual({ ...emptyQueue, issues: [issue] });
    const malformedLinks = { ...issue, url: "bad url", pr: { ...issue.pr, url: "bad pr url" } };
    expect(
      await loadFactoryQueue(async () => ({ ...emptyQueue, issues: [malformedLinks] }), "project"),
    ).toEqual({ ...emptyQueue, issues: [malformedLinks] });
  });

  it.each([
    "Unknown Factory method: factory.project.queue",
    "Unknown RPC method: factory.project.queue",
    "Plugin factory does not contribute RPC factory.project.queue",
  ])("hides the queue for older daemons reporting %s", async (message) => {
    const invoke: FactoryInvoke = async () => {
      throw new Error(message);
    };
    expect(await loadFactoryQueue(invoke, "project")).toBeNull();
  });

  it("preserves GitHub failures and rejects transport failures instead of claiming idle", async () => {
    const errorQueue = { ...emptyQueue, error: "GitHub authentication failed" };
    expect(await loadFactoryQueue(async () => errorQueue, "project")).toEqual(errorQueue);
    await expect(
      loadFactoryQueue(async () => {
        throw new Error("Disconnected");
      }, "project"),
    ).rejects.toThrow("Disconnected");
    await expect(
      loadFactoryQueue(async () => ({ ...emptyQueue, issues: [{}] }), "project"),
    ).rejects.toThrow();
  });
});

it("localizes known agent statuses and hides unknown wire values", () => {
  expect(factoryAgentStatusKey("running")).toBe("projectFactory.agentStatuses.running");
  expect(factoryAgentStatusKey("future_internal_status")).toBe(
    "projectFactory.agentStatuses.unknown",
  );
});

it("places repair work in the Review lane and maps each stage onto the five-box track", () => {
  const stages = [
    "queued",
    "planning",
    "building",
    "review",
    "repair",
    "merging",
    "blocked",
  ] as const;
  const issues = stages.map((stage, index) => ({
    number: index,
    title: stage,
    url: `https://github.com/owner/repo/issues/${index}`,
    label: "running" as const,
    stage,
    pr: null,
    agents: [],
  }));
  const lanes = factoryLanes(issues);
  expect(aggregateStageCounts([issues, null, undefined])).toEqual({
    queued: 1,
    planning: 1,
    building: 1,
    review: 2,
    merging: 1,
    blocked: 1,
  });
  expect(lanes.map((group) => group.lane)).toEqual([...FACTORY_LANES]);
  expect(
    lanes.find((group) => group.lane === "review")?.issues.map((issue) => issue.stage),
  ).toEqual(["review", "repair"]);
  expect(issues.map((issue) => factoryTrack(issue).join(","))).toEqual([
    "pending,pending,pending,pending,pending",
    "active,pending,pending,pending,pending",
    "done,active,pending,pending,pending",
    "done,done,active,pending,pending",
    "done,done,failed,pending,pending",
    "done,done,done,active,pending",
    "blocked,pending,pending,pending,pending",
  ]);
  expect(
    factoryTrack({
      stage: "blocked",
      pr: { number: 1, url: "", headSha: "", checks: null, reviewDecision: null },
    }),
  ).toEqual(["done", "done", "blocked", "pending", "pending"]);
});

it("shows one stop per host and reason, however many per-project drain ids it holds", () => {
  const entry = (projectId: string, serverId: string, drain: object | null) => ({
    key: `${serverId}:${projectId}`,
    serverId,
    projectId,
    name: projectId,
    hostLabel: null,
    state: null,
    status: "paused" as const,
    drain: drain as { id: string; reason: string; pausedAt: string } | null,
    issues: [],
  });
  const ours = (id: string, pausedAt: string) => ({ id, reason: OWNER_STOP_REASON, pausedAt });
  const entries = [
    entry("a", "host", ours("drain-a", "2026-11-07T10:00:02Z")),
    entry("b", "host", ours("drain-b", "2026-11-07T10:00:01Z")),
    entry("c", "other", {
      id: "drain-c",
      reason: "drain before restart",
      pausedAt: "2026-11-07T09:00:00Z",
    }),
    entry("d", "other", null),
  ];
  expect(activeDrains(entries)).toEqual([
    expect.objectContaining({
      serverId: "host",
      projects: 2,
      owner: true,
      pausedAt: "2026-11-07T10:00:01Z",
    }),
    expect.objectContaining({ serverId: "other", projects: 1, owner: false }),
  ]);
  // A host anyone else holds is never resumed or stopped on top; ours resumes, running ones stop.
  const host = hostStopState(entries.filter((item) => item.serverId === "host"));
  const other = hostStopState(entries.filter((item) => item.serverId === "other"));
  expect([canResumeHost(host), canStopHost(host)]).toEqual([true, false]);
  expect([canResumeHost(other), canStopHost(other)]).toEqual([false, false]);
  expect(canStopHost(hostStopState([{ status: "on", drain: null }]))).toBe(true);
  // A host whose fresh read failed is left alone; the others still act or are skipped.
  const running = { projects: [{ state: "on", drain: null }] };
  const held = { projects: [{ state: "paused", drain: { reason: "drain before restart" } }] };
  expect(
    selectFreshTargets(
      ["a", "b", "c"],
      [
        { status: "rejected", reason: new Error("offline") },
        { status: "fulfilled", value: running },
        { status: "fulfilled", value: held },
      ],
      canStopHost,
    ),
  ).toEqual({ act: ["b"], unreadable: ["a"], skipped: ["c"] });
});

it("shows no sample-backed report in Live mode and every report in Sample factory mode", () => {
  const kpis = ["inFlight", "merged7d", "cycleTime", "tokens", "monthCap", "queueAge"] as const;
  expect(shownReports(kpis, false)).toEqual(["inFlight", "tokens"]);
  expect(shownReports(kpis, true)).toEqual([...kpis]);
  const panels = [{ report: "velocityChart" }, { report: "quota" }, { report: "budgets" }] as const;
  expect(shownReports(panels, false).map((panel) => panel.report)).toEqual(["quota"]);
});
