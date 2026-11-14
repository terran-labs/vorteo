import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  attentionKind,
  daemonObservationSource,
  hasImportantChange,
  WorkspaceObserver,
  type Cursor,
  type HistoryPage,
  type ObservationSource,
  type ObservedThread,
} from "./observer.js";
import type { DaemonAccess, ReadClient } from "./daemon.js";
import { BridgeStore } from "./store.js";
import { BridgeEvents } from "./events.js";

const baseline = {
  previousTimestamp: "2026-10-07T12:00:00Z",
  attentionTimestamp: "2026-10-07T12:00:00Z",
  attentionReason: "finished" as const,
  previouslyObserved: true,
  createdAt: "2026-10-01T12:00:00Z",
  monitoringStartedAt: "2026-10-07T00:00:00Z",
  gap: false,
};

describe("relevant notifications", () => {
  it("does not report an old completion again when a thread's other fields change", () => {
    expect(hasImportantChange(baseline)).toBe(false);
    expect(
      hasImportantChange({
        ...baseline,
        attentionReason: null,
        attentionTimestamp: "2026-10-07T12:01:00Z",
      }),
    ).toBe(false);
  });

  it("reports fresh completion and permission requests", () => {
    expect(hasImportantChange({ ...baseline, attentionTimestamp: "2026-10-07T12:01:00Z" })).toBe(
      true,
    );
    expect(
      hasImportantChange({
        ...baseline,
        attentionReason: "permission",
        attentionTimestamp: "2026-10-07T12:01:00Z",
      }),
    ).toBe(true);
    expect(attentionKind("permission", false)).toBe("permission");
  });

  it("catches a new task that completed while disconnected without importing old history as new work", () => {
    expect(
      hasImportantChange({
        ...baseline,
        attentionTimestamp: "2026-10-01T12:00:00Z",
        previouslyObserved: false,
        previousTimestamp: null,
      }),
    ).toBe(false);
    expect(
      hasImportantChange({
        ...baseline,
        previouslyObserved: false,
        previousTimestamp: null,
        createdAt: "2026-10-07T11:00:00Z",
      }),
    ).toBe(true);
  });

  it("reports missing history without claiming the task completed", () => {
    expect(hasImportantChange({ ...baseline, gap: true })).toBe(true);
    expect(attentionKind("finished", true)).toBe("gap");
  });
});

const start = "2026-11-14T12:00:00.000Z";
const later = "2026-11-14T12:01:00.000Z";

interface TimelineRequest {
  direction?: "tail" | "before" | "after";
  cursor?: Cursor;
  limit?: number;
}

// A daemon timeline with real tail/after paging over many rows. History goes
// through daemonObservationSource, so the direction it chooses is what is tested.
class LongTimeline implements ObservationSource {
  epoch = "one";
  rows = 31_000;
  offline = false;
  calls: TimelineRequest[] = [];
  agent: ObservedThread = {
    id: "long",
    status: "idle",
    title: "long",
    workspaceId: "workspace",
    createdAt: start,
    updatedAt: later,
    attentionReason: null,
    attentionTimestamp: null,
    pendingPermissions: [],
  };
  private readonly daemon = daemonObservationSource({
    readClient: async () =>
      ({
        fetchAgentTimeline: async (_id: string, request: TimelineRequest) => this.fetch(request),
      }) as unknown as ReadClient,
  } as DaemonAccess);
  async list() {
    if (this.offline) throw new Error("fixture disconnected");
    return { agents: [this.agent] };
  }
  async watch() {
    return async () => {};
  }
  history(id: string, cursor?: Cursor) {
    return this.daemon.history(id, cursor);
  }
  private fetch(request: TimelineRequest): HistoryPage {
    this.calls.push(request);
    const { cursor, direction = "tail", limit = 100 } = request;
    const stale = cursor !== undefined && cursor.epoch !== this.epoch;
    let from = Math.max(1, this.rows - limit + 1);
    if (direction === "after" && !stale) from = cursor ? cursor.seq + 1 : 1;
    const to = Math.min(this.rows, from + limit - 1);
    const entries = [];
    for (let seq = from; seq <= to; seq++)
      entries.push({ seqEnd: seq, timestamp: later, item: { type: "assistant_message" } });
    return {
      entries,
      startCursor: { epoch: this.epoch, seq: from },
      endCursor: { epoch: this.epoch, seq: to },
      hasNewer: to < this.rows,
      hasOlder: from > 1,
      gap: stale,
      staleCursor: stale,
      reset: stale,
    };
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function observe(source: ObservationSource) {
  const directory = mkdtempSync(join(tmpdir(), "nova-observer-"));
  const store = new BridgeStore(join(directory, "state.sqlite"));
  const now = () => Date.parse(start);
  const events = new BridgeEvents(store, async () => ({ status: 200, body: "" }), now);
  const observer = new WorkspaceObserver("dev", "dev-server", source, store, events, now);
  cleanups.push(async () => {
    await observer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const gaps = () =>
    store.db
      .prepare("SELECT body FROM events ORDER BY seq")
      .all()
      .map((row) => JSON.parse(String(row.body)))
      .filter((event) => event.data.threadId !== null && event.data.kind === "gap").length;
  return { observer, gaps };
}

describe("bounded history reads", () => {
  it("reads a long thread's tail on first observation and after a reset, never its head", async () => {
    const source = new LongTimeline();
    const { observer, gaps } = observe(source);
    await observer.reconcile();
    expect(source.calls).toEqual([
      { projection: "canonical", limit: 100, direction: "tail", cursor: undefined },
    ]);
    // Every row read is after monitoring start and older rows exist: unknown, not quiet.
    expect(gaps()).toBe(1);

    // A recovering scan does not read a thread whose update time and evidence are unchanged.
    source.calls = [];
    source.offline = true;
    await observer.reconcile();
    source.offline = false;
    await observer.reconcile();
    expect(source.calls).toEqual([]);

    source.epoch = "two";
    source.agent = { ...source.agent, updatedAt: "2026-11-14T12:02:00.000Z" };
    await observer.reconcile();
    expect(source.calls.map((call) => call.cursor)).toEqual([{ epoch: "one", seq: 31_000 }]);
    expect(gaps()).toBe(2);
  });

  it.each([
    { added: 2_000, gap: true },
    { added: 550, gap: false },
  ])(
    "reads at most five pages forward, then re-anchors at the tail (added $added, gap $gap)",
    async ({ added, gap }) => {
      const source = new LongTimeline();
      const { observer, gaps } = observe(source);
      await observer.reconcile();
      source.calls = [];
      source.rows += added;
      source.agent = { ...source.agent, updatedAt: "2026-11-14T12:02:00.000Z" };
      await observer.reconcile();
      expect(source.calls.map((call) => call.direction)).toEqual([
        "after",
        "after",
        "after",
        "after",
        "after",
        "tail",
      ]);
      expect(gaps()).toBe(gap ? 2 : 1);
    },
  );
});
