import { describe, expect, it } from "vitest";
import { demoLeanStatus, demoLeanView } from "./lean-demo";
import { isLeanFactory, mapLeanView } from "./lean-factory-source";
import { leanActionBlock, leanReleases, leanRunnerRows } from "./lean-model";

describe("lean Factory gate", () => {
  it("shows lean views only when the daemon reports lean mode", () => {
    const lean = { factoryLean: true };
    expect(isLeanFactory(undefined, { mode: "lean" })).toBe(false);
    expect(isLeanFactory({}, { mode: "lean" })).toBe(false);
    expect(isLeanFactory(lean, undefined)).toBe(false);
    expect(isLeanFactory(lean, {})).toBe(false);
    expect(isLeanFactory(lean, { mode: "crew" })).toBe(false);
    expect(isLeanFactory(lean, { mode: "lean" })).toBe(true);
  });
});

describe("lean runners", () => {
  it("badges each runner with its own machine, not the issue's Builder machine", () => {
    const rows = leanRunnerRows(demoLeanStatus(), demoLeanView());
    expect(rows.map((row) => [row.issue, row.role, row.machine])).toEqual([
      [41, "builder", "Studio"],
      // Issue 41's line names Studio, but its Reviewer runs on the primary.
      [41, "reviewer", "M2"],
      [42, "reviewer", "M2"],
      [null, "delivery", "M2"],
    ]);
  });
});

describe("releases", () => {
  it("offers Promote on each beta newer than production and Roll back on earlier stable releases", () => {
    const releases = leanReleases(demoLeanView());
    expect(releases.betas.map((row) => [row.event.version, row.action?.kind ?? null])).toEqual([
      ["1.4.1-beta.2", "promote"],
      ["1.4.1-beta.1", "promote"],
    ]);
    expect(releases.earlier.map((row) => [row.event.version, row.action?.kind ?? null])).toEqual([
      ["1.3.1-beta.1", null],
      ["1.3.0", "rollback"],
    ]);
    expect(releases.betas[0]?.action).toMatchObject({
      eventId: "rel-141b2",
      expectedProduction: "rel-140",
    });
    expect(releases.earlier[1]?.action).toMatchObject({
      targetEventId: "rel-130",
      expectedProduction: "rel-140",
    });
  });
});

describe("action readiness", () => {
  it("keeps every action disabled until the daemon reports readiness, and absent means not ready", () => {
    const actions = ["hold", "promote", "rollback", "approval", "resolve", "config-save"] as const;
    const { readiness: _ready, ...wire } = demoLeanView();
    const absent = mapLeanView(wire as never).readiness;
    expect(actions.map((action) => leanActionBlock(absent, action))).toEqual([
      "owner",
      "owner",
      "owner",
      "owner",
      "owner",
      "owner",
    ]);
    const ownerOnly = { ownerActions: true, deliveryActions: false };
    expect(actions.map((action) => leanActionBlock(ownerOnly, action))).toEqual([
      "delivery",
      "delivery",
      "delivery",
      null,
      null,
      null,
    ]);
    const ready = { ownerActions: true, deliveryActions: true };
    expect(actions.every((action) => leanActionBlock(ready, action) === null)).toBe(true);
  });
});
