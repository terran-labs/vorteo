import { describe, expect, it } from "vitest";
import { loadFactoryQueue, factoryAgentStatusKey, type FactoryInvoke } from "./queue";
import { ProjectFactoryStateSchema } from "@/components/sidebar/factory-state";
import { FACTORY_LANES, factoryLanes, factoryTrack } from "./overview-model";

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
