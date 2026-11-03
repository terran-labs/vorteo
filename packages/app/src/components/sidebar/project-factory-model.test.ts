import {
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
