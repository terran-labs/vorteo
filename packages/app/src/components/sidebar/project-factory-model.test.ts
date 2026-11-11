import { QueryClient } from "@tanstack/react-query";
import { boundedFactoryRead, factoryQueueNeedsInitialRead } from "@/screens/factory/factory-reads";
import {
  factoryOverviewRoute,
  freshFactoryStatus,
  factoryModelConfiguration,
  sendThreadToFactory,
} from "./project-factory-model";
import { describe, expect, it, vi } from "vitest";
import {
  factoryActions,
  factoryRepositoryFromRemote,
  validFactoryRepository,
} from "./project-factory-model";
import {
  instructionDiff,
  reviewNeedsAttention,
  writeInstructions,
  type Instructions,
} from "./factory-instructions-model";
import { factoryRunnerTrack, factoryStageCounts } from "./factory-card-model";
import { aggregateFactories, factorySummaryState } from "./factory-global-model";
describe("Factory menu and repository dialog", () => {
  it("offers the actions appropriate to each state", () => {
    expect(factoryActions("off")).toEqual(["enable"]);
    expect(factoryActions("on")).toEqual(["pause", "disable"]);
    expect(factoryActions("paused")).toEqual(["resume", "disable"]);
    expect(factoryActions("unavailable")).toEqual([]);
  });
  it("requires owner/name and prefills only GitHub remotes", () => {
    for (const value of ["", "repo", "a/b/c", "a/ b", "https://github.com/a/b"])
      expect(validFactoryRepository(value)).toBe(false);
    expect(validFactoryRepository("terran-labs/vorteo")).toBe(true);
    expect(factoryRepositoryFromRemote("git@github.com:terran-labs/vorteo.git")).toBe(
      "terran-labs/vorteo",
    );
    expect(factoryRepositoryFromRemote("https://github.com/a/b.git")).toBe("a/b");
    expect(factoryRepositoryFromRemote("git@gitlab.com:a/b.git")).toBe("");
  });
});
describe("Factory instructions revisions and review", () => {
  const state: Instructions = {
    role: "factory-builds",
    additions: "owner rules",
    revision: 7,
    updatedAt: null,
    shippedCharter: "new",
    charterVersion: "v2",
    history: [],
    basedOn: { charterVersion: "v1", charterText: "old" },
    review: { status: "needed" },
  };
  it("retains the opening revision and draft on save conflict", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("Revision conflict"));
    await expect(
      writeInstructions(invoke, "project", state, { additions: "my draft" }),
    ).rejects.toThrow("Revision conflict");
    expect(invoke).toHaveBeenCalledWith("factory.project.instructions.set", {
      projectId: "project",
      role: "factory-builds",
      expectedRevision: 7,
      additions: "my draft",
    });
    expect(state.revision).toBe(7);
    expect(state.additions).toBe("owner rules");
  });
  it.each([true, false])("resolves the proposal with accept=%s", async (accept) => {
    const result = { ...state, revision: 8, review: { status: "none" } };
    const invoke = vi.fn().mockResolvedValue(result);
    expect(
      await writeInstructions(
        invoke,
        "project",
        {
          ...state,
          review: {
            status: "proposed",
            proposal: { text: "proposal", rationale: "reason", proposedAt: "proposal-time" },
          },
        },
        { accept },
      ),
    ).toBe(result);
    expect(invoke).toHaveBeenCalledWith("factory.project.instructions.resolve", {
      projectId: "project",
      role: "factory-builds",
      expectedRevision: 7,
      accept,
      ...(accept ? { proposedAt: "proposal-time" } : {}),
    });
  });
  it("marks needed and proposed reviews and shows both sides of changes", () => {
    expect(reviewNeedsAttention("none")).toBe(false);
    expect(reviewNeedsAttention("needed")).toBe(true);
    expect(reviewNeedsAttention("proposed")).toBe(true);
    expect(instructionDiff("old", "new")).toEqual([
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
    ]);
    expect(instructionDiff("same", "same")).toEqual([]);
  });
});

describe("Factory model, status and thread routing", () => {
  it("configures role launches, project workers and defaults", () => {
    expect(factoryModelConfiguration("p", "role", "profile", "factory-triage", "claude")).toEqual({
      projectId: "p",
      role: "factory-triage",
      provider: "claude",
      profileId: "profile",
    });
    expect(factoryModelConfiguration("p", "role", null, "factory-builds")).toEqual({
      projectId: "p",
      role: "factory-builds",
      provider: null,
      profileId: null,
    });
    expect(factoryModelConfiguration("p", "plannerProfileId", "planner")).toEqual({
      projectId: "p",
      plannerProfileId: "planner",
    });
    expect(factoryModelConfiguration("p", "workerProfileId", "worker")).toEqual({
      projectId: "p",
      workerProfileId: "worker",
    });
    expect(factoryModelConfiguration("p", "reviewerProfileId", null)).toEqual({
      projectId: "p",
      reviewerProfileId: null,
    });
  });
  it("hides status after 24 hours and refuses invalid timestamps", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(
      freshFactoryStatus({ line: "building", updatedAt: "2026-11-03T11:00:00Z" }, now)?.line,
    ).toBe("building");
    expect(
      freshFactoryStatus({ line: "stale", updatedAt: "2026-11-02T12:00:00Z" }, now),
    ).toBeNull();
    expect(freshFactoryStatus({ line: "invalid", updatedAt: "bad" }, now)).toBeNull();
  });
  it("routes a thread by exact project and agent IDs and propagates errors", async () => {
    const invoke = vi.fn().mockResolvedValue({ queued: true });
    await sendThreadToFactory(invoke, "p", "a");
    expect(invoke).toHaveBeenCalledWith("factory.project.send_thread", {
      projectId: "p",
      agentId: "a",
    });
    invoke.mockRejectedValue(new Error("Factory is off"));
    await expect(sendThreadToFactory(invoke, "p", "a")).rejects.toThrow("Factory is off");
  });
});

it("uses the existing LCS diff and collapses unchanged charter runs", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `rule ${index}`);
  const changed = [...lines];
  changed[10] = "replacement rule";
  const diff = instructionDiff(lines.join("\n"), changed.join("\n"));
  expect(diff.filter((line) => line.kind === "removed")).toEqual([
    { kind: "removed", text: "rule 10" },
  ]);
  expect(diff.filter((line) => line.kind === "added")).toEqual([
    { kind: "added", text: "replacement rule" },
  ]);
  expect(diff.filter((line) => line.kind === "context")).toHaveLength(6);
  expect(diff.filter((line) => line.kind === "collapsed").map((line) => line.count)).toEqual([
    7, 6,
  ]);
});

describe("Factory card overview routing", () => {
  const target = {
    serverId: "host",
    projectId: "project",
    installationId: "project-factory:project",
  };
  it("opens the native page without a legacy surface", () => {
    expect(factoryOverviewRoute(target, { surfaces: [] })).toEqual({
      pathname: "/h/[serverId]/factory/[projectId]",
      params: { serverId: "host", projectId: "project" },
    });
  });
  it("offers legacy navigation only when the overview surface exists", () => {
    const legacy = { ...target, installationId: "legacy" };
    expect(factoryOverviewRoute(legacy, { surfaces: [] })).toBeNull();
    expect(factoryOverviewRoute(legacy, undefined)).toBeNull();
    expect(factoryOverviewRoute(legacy, { surfaces: [{ id: "overview" }] })).toBe(
      "/h/host/plugin/factory/surface/overview?param.projectId=project",
    );
  });
});

it("counts queue stages for the card's bar and places each runner on its five-step track", () => {
  const issue = (stage: Parameters<typeof factoryRunnerTrack>[0]["stage"], number: number) => ({
    number,
    title: `Issue ${number}`,
    url: `https://example.test/${number}`,
    label: "running" as const,
    stage,
    pr: null,
    agents: [] as { role: "lead" | "worker" | "reviewer"; agentId: string; status: string }[],
  });
  const issues = [issue("queued", 1), issue("queued", 2), issue("repair", 3), issue("blocked", 4)];
  expect(factoryStageCounts(issues).map(({ segment, count }) => [segment, count])).toEqual([
    ["queued", 2],
    ["repair", 2],
  ]);
  expect(factoryRunnerTrack(issue("building", 5)).boxes).toEqual([
    "done",
    "current",
    "pending",
    "pending",
    "pending",
  ]);
  expect(factoryRunnerTrack(issue("repair", 6))).toMatchObject({
    step: "review",
    boxes: ["done", "done", "danger", "pending", "pending"],
  });
  // Blocked stops at the latest step its agents reached.
  const blocked = {
    ...issue("blocked", 7),
    agents: [{ role: "worker" as const, agentId: "a", status: "idle" }],
  };
  expect(factoryRunnerTrack(blocked).boxes).toEqual([
    "done",
    "danger",
    "pending",
    "pending",
    "pending",
  ]);
  expect(factoryRunnerTrack(issue("queued", 8))).toMatchObject({ step: null });
});

it("sums every Factory for the All Factories card", () => {
  const issue = (number: number, stage: "queued" | "building" | "blocked", label = "running") => ({
    number,
    title: `Issue ${number}`,
    url: "",
    label: label as "running" | "human-review",
    stage,
    pr: null,
    agents: [],
  });
  const factory = (
    projectId: string,
    state: "on" | "paused",
    issues: ReturnType<typeof issue>[],
  ) => ({
    serverId: "host",
    projectId,
    projectName: projectId,
    hostLabel: null,
    listed: { state, drain: null },
    issues,
  });
  const on = factory("a", "on", [issue(1, "building"), issue(2, "queued", "human-review")]);
  const aggregate = aggregateFactories([on, factory("b", "on", [issue(1, "blocked")])]);
  expect(aggregate.pill.label).toBe("on");
  expect(aggregate.runners.map((runner) => `${runner.tag}#${runner.number}`)).toEqual([
    "a#1",
    "b#1",
  ]);
  expect(aggregate.chips.map((chip) => [chip.name, chip.inFlight])).toEqual([
    ["a", 1],
    ["b", 1],
  ]);
  expect(aggregateFactories([on, factory("b", "paused", [])]).pill.label).toBe("paused");
});

it("summarizes a held Factory before any queue is read", () => {
  expect(
    factorySummaryState([
      {
        serverId: "host",
        projectId: "p",
        projectName: "Project",
        hostLabel: null,
        listed: {
          state: "paused",
          drain: { id: "hold", reason: "Update", pausedAt: "2026-11-10" },
        },
        issues: null,
      },
    ]),
  ).toEqual({ count: 1, running: 0, paused: 1, held: 1, hasQueue: false });
});

it("reads an inactive paused queue once when activated, including a pre-created cache entry", async () => {
  const client = new QueryClient();
  let attempts = 0;
  const query = client.getQueryCache().build(client, {
    queryKey: ["factoryQueue", "host", "paused"],
    queryFn: async () => {
      attempts += 1;
      return null;
    },
    retry: false,
  });
  expect(attempts).toBe(0);
  expect(factoryQueueNeedsInitialRead(query.state)).toBe(true);
  await query.fetch();
  expect(attempts).toBe(1);
  expect(factoryQueueNeedsInitialRead(query.state)).toBe(false);
  client.clear();
});

it("bounds queue reads and serves ordinary waiters while more summaries arrive", async () => {
  const releases: (() => void)[] = [];
  const order: string[] = [];
  const active = Array.from({ length: 3 }, () =>
    boundedFactoryRead(() => new Promise<void>((resolve) => releases.push(resolve))),
  );
  const ordinary = boundedFactoryRead(async () => {
    order.push("ordinary");
  });
  const summaryReads: Promise<void>[] = [];
  summaryReads.push(
    boundedFactoryRead(
      async () => {
        order.push("summary-1");
        summaryReads.push(
          boundedFactoryRead(
            async () => {
              order.push("summary-3");
            },
            { priority: "summary" },
          ),
        );
      },
      { priority: "summary" },
    ),
  );
  summaryReads.push(
    boundedFactoryRead(
      async () => {
        order.push("summary-2");
      },
      { priority: "summary" },
    ),
  );
  expect(order).toEqual([]);
  releases[0]!();
  await ordinary;
  await Promise.all(summaryReads);
  expect(order.indexOf("ordinary")).toBeLessThan(order.indexOf("summary-2"));
  releases[1]!();
  releases[2]!();
  await Promise.all(active);
});
