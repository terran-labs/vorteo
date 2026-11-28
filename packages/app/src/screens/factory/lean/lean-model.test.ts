import { describe, expect, it } from "vitest";
import { demoLeanStatus, demoLeanView, demoRelease } from "./lean-demo";
import { isLeanFactory, mapLeanView } from "./lean-factory-source";
import {
  leanActionBlock,
  leanNeedsYou,
  leanReleases,
  leanRunnerRows,
  leanTiles,
} from "./lean-model";

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

  it("opens no runner row for the delivery executor or a wire string holder", () => {
    const lock = { holder: "srv_m2/mira", batch: "Batch 12", expiresAt: "2026-11-27T20:00:00Z" };
    const wire = (holderInfo?: object) =>
      mapLeanView({
        ...demoLeanView(),
        health: { alerts: [], deliveryLock: { ...lock, ...(holderInfo ? { holderInfo } : {}) } },
      } as never);
    const delivery = (view: ReturnType<typeof wire>) =>
      leanRunnerRows(null, view).filter((row) => row.role === "delivery");
    expect(delivery(wire())).toEqual([]);
    expect(delivery(wire({ kind: "executor", installationId: "srv_m2/mira" }))).toEqual([]);
    expect(
      delivery(wire({ kind: "runner", agentId: "agent-d", installationId: "srv_m2/mira" })),
    ).toHaveLength(1);
  });
});

describe("Needs you", () => {
  it("lists a pending beta notice, an approval, questions and the promote decision in that order", () => {
    const view = demoLeanView({
      pendingBeta: {
        eventId: "rel-142b1",
        version: "1.4.2-beta.1",
        shipsAt: "2026-11-27T20:10:00Z",
        held: false,
      },
      delivery: {
        state: "awaiting-approval",
        jobId: "job-9",
        kind: "promote",
        version: null,
        approvalUrl: null,
        waitingOn: null,
        failureKind: null,
        failureReason: null,
      },
    });
    const items = leanNeedsYou(demoLeanStatus(), view);
    expect(items.map((item) => item.kind)).toEqual([
      "beta-notice",
      "approval",
      "question",
      "promote",
    ]);
    expect(items.at(-1)).toMatchObject({ version: "1.4.1-beta.2", count: 2 });
  });

  it("puts a failed or unknown delivery first, and never a cancelled one", () => {
    const delivery = (failureKind: string) =>
      mapLeanView({
        ...demoLeanView(),
        delivery: {
          state: "failed",
          jobId: "run-7",
          kind: "rollback",
          version: "1.3.0",
          approvalUrl: null,
          waitingOn: null,
          failureKind,
          failureReason: "The deploy step's outcome is unknown.",
        },
      } as never);
    const first = leanNeedsYou(demoLeanStatus(), delivery("unknown"))[0];
    expect(first).toMatchObject({
      kind: "delivery-failed",
      jobId: "run-7",
      deliveryKind: "rollback",
      failureKind: "unknown",
    });
    const cancelled = leanNeedsYou(demoLeanStatus(), delivery("cancelled"));
    expect(cancelled.some((item) => item.kind === "delivery-failed")).toBe(false);
  });

  it("keeps a pending beta whose version is not known yet, so the owner can still hold it", () => {
    const view = demoLeanView({
      pendingBeta: {
        eventId: "rel-next",
        version: null,
        shipsAt: "2026-11-27T20:10:00Z",
        held: false,
      },
    });
    expect(leanNeedsYou(null, view)[0]).toMatchObject({
      kind: "beta-notice",
      eventId: "rel-next",
      version: null,
    });
  });

  it("offers no promote decision when no beta is newer than production", () => {
    const view = demoLeanView({ betas: [] });
    const items = leanNeedsYou(demoLeanStatus({ escalations: [] }), view);
    expect(items).toEqual([]);
  });
});

describe("Lead and Mechanic tiles", () => {
  const chip = (key: string, label: string) => ({
    key,
    label,
    entry: null,
    status: undefined,
    isRole: true,
  });

  it("puts the intake role first as the Lead, then the Mechanic, and drops other roles", () => {
    const tiles = leanTiles([
      chip("factory-mechanic", "Mechanic"),
      chip("factory-builds", "Builds"),
      chip("factory-intake", "Foreman"),
    ]);
    expect(tiles.map((tile) => tile.key)).toEqual(["factory-intake", "factory-mechanic"]);
  });

  it("keeps both tiles, without a conversation to open, when lean mode has no records yet", () => {
    const tiles = leanTiles([]);
    expect(tiles.map((tile) => [tile.key, tile.entry])).toEqual([
      ["factory-intake", null],
      ["factory-mechanic", null],
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

  it("offers no Promote for a beta older than production or failed, and no Roll back without production", () => {
    const view = demoLeanView({
      production: null,
      betas: [
        demoRelease({ id: "old", version: "1.4.0-beta.9", at: "2026-11-24T00:00:00Z" }),
        demoRelease({
          id: "bad",
          kind: "failed",
          version: "1.4.1-beta.3",
          at: "2026-11-27T19:00:00Z",
        }),
      ],
    });
    const releases = leanReleases(view);
    expect(releases.betas.map((row) => row.action?.kind ?? null)).toEqual([null, "promote"]);
    expect(releases.earlier.every((row) => row.action === null)).toBe(true);
    expect(
      leanReleases(
        demoLeanView({
          betas: [demoRelease({ id: "old", version: "1.3.9", at: "2026-11-24T00:00:00Z" })],
        }),
      ).betas,
    ).toEqual([]);
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
