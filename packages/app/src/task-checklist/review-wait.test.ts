import { describe, expect, it } from "vitest";
import type { TodoEntry } from "@/types/stream";
import { reviewWaitSummary, showsReviewWait, workspaceReviewTasks } from "./review-wait";

const review = (text: string, extra: Partial<TodoEntry> = {}): TodoEntry => ({
  text,
  completed: false,
  status: "review",
  ...extra,
});

describe("waiting on review in the sidebar", () => {
  it("collects unfinished Review items from the workspace's live threads only", () => {
    const merge = review("Builds merges and publishes the change", { owner: "Vorteo :: Builds" });
    const agents = [
      {
        id: "a",
        workspaceId: "w",
        archivedAt: null,
        tasks: [
          { text: "Done", completed: true, status: "completed" as const },
          merge,
          { text: "Later", completed: false, status: "pending" as const },
        ],
      },
      { id: "b", workspaceId: "w", archivedAt: new Date(), tasks: [review("Archived")] },
      { id: "c", workspaceId: "w", archivedAt: null, tasks: [review("Archiving")] },
      { id: "d", workspaceId: "other", archivedAt: null, tasks: [review("Elsewhere")] },
    ];
    expect(workspaceReviewTasks(agents, "w", new Set(["c"]))).toEqual([merge]);
  });

  it("replaces only idle states, so urgent states still win", () => {
    expect(showsReviewWait("attention", 1)).toBe(true);
    expect(showsReviewWait("done", 1)).toBe(true);
    expect(showsReviewWait("running", 1)).toBe(false);
    expect(showsReviewWait("needs_input", 1)).toBe(false);
    expect(showsReviewWait("failed", 1)).toBe(false);
    expect(showsReviewWait("attention", 0)).toBe(false);
  });

  it("names a shared owner and shows each item's title and description", () => {
    const summary = reviewWaitSummary([
      review("Builds merges and publishes the change", {
        owner: "Vorteo :: Builds",
        description: "Waiting for Builds to merge into main and publish the interface.",
      }),
    ]);
    expect(summary).toEqual({
      heading: "Waiting on Vorteo :: Builds",
      rows: [
        {
          key: "Builds merges and publishes the change",
          title: "Builds merges and publishes the change",
          detail: "Waiting for Builds to merge into main and publish the interface.",
        },
      ],
      more: 0,
    });
  });

  it("falls back to a generic heading and bounds the rows", () => {
    const summary = reviewWaitSummary([
      review("One", { owner: "Builds" }),
      review("Two"),
      review("Three"),
      review("Four"),
    ]);
    expect(summary.heading).toBe("Waiting for review");
    expect(summary.rows.map((row) => row.title)).toEqual(["One", "Two", "Three"]);
    expect(summary.rows[1].detail).toBeNull();
    expect(summary.more).toBe(1);
  });
});
