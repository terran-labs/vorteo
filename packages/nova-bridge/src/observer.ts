import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { Environment } from "./config.js";
import type { DaemonAccess } from "./daemon.js";
import { BridgeStore } from "./store.js";
import { BridgeEvents, type Attention } from "./events.js";

export interface Cursor {
  epoch: string;
  seq: number;
}
export type ObservedThread = Pick<
  AgentSnapshotPayload,
  | "id"
  | "status"
  | "title"
  | "workspaceId"
  | "updatedAt"
  | "createdAt"
  | "archivedAt"
  | "attentionReason"
  | "attentionTimestamp"
  | "tasks"
  | "journal"
  | "pendingPermissions"
>;
export interface HistoryPage {
  entries: { seqEnd: number; timestamp: string; item: { type: string } }[];
  endCursor: Cursor | null;
  /** First row of the page. Absent from older sources. */
  startCursor?: Cursor | null;
  hasNewer: boolean;
  /** True when retained rows exist before this page. Absent from older sources. */
  hasOlder?: boolean;
  gap: boolean;
  staleCursor: boolean;
  reset: boolean;
}
export interface ObservationSource {
  list(cursor?: string): Promise<{ agents: ObservedThread[]; next?: string }>;
  history(threadId: string, cursor?: Cursor): Promise<HistoryPage>;
  watch(
    onChange: (thread: ObservedThread) => void,
    onError: () => void,
  ): Promise<() => Promise<void>>;
}

export function daemonObservationSource(connection: DaemonAccess): ObservationSource {
  return {
    async list(cursor) {
      const client = await connection.readClient();
      const page = await client.fetchAgents({
        filter: { includeArchived: true },
        page: { limit: 200, cursor },
      });
      return {
        agents: page.entries.map((entry) => entry.agent),
        next: page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined,
      };
    },
    async history(threadId, cursor) {
      const client = await connection.readClient();
      // Without a trusted position, read only the newest page. Paging from the
      // retained head made the daemon load whole histories (tens of thousands of
      // rows) for every thread after a restart. The observer reports a gap when
      // this window cannot reach back to monitoring start.
      return client.fetchAgentTimeline(threadId, {
        projection: "canonical",
        limit: HISTORY_PAGE_LIMIT,
        direction: cursor ? "after" : "tail",
        cursor,
      });
    },
    async watch(onChange, onError) {
      const client = await connection.readClient();
      const subscription = client.observeAgents({
        filter: { includeArchived: true },
        page: { limit: 200 },
      });
      subscription.subscribe({
        snapshot: (snapshot) => {
          for (const entry of snapshot.entries) onChange(entry.agent);
        },
        update: (message) => {
          if (message.type === "agent_update" && message.payload.kind === "upsert")
            onChange(message.payload.agent);
        },
        error: onError,
      });
      try {
        await subscription.ready;
      } catch (error) {
        await subscription.release();
        throw error;
      }
      return () => subscription.release();
    },
  };
}

const HISTORY_PAGE_LIMIT = 100;
// Pages read forward from a saved cursor in one observation. A thread that
// outran this window is re-anchored at its tail and reported as a gap.
const MAX_HISTORY_PAGES = 5;

const SavedSchema = z.object({
  updatedAt: z.string(),
  attentionTimestamp: z.string().nullable(),
  attentionReason: z.string().nullable().optional(),
  evidence: z.string().optional(),
  cursor: z.object({ epoch: z.string(), seq: z.number() }).nullable(),
});
type Saved = z.infer<typeof SavedSchema>;

function evidenceChanged(
  agent: ObservedThread,
  saved: Saved | null,
  evidence: string,
  startedAt: string,
): boolean {
  if (saved) return saved.evidence !== evidence;
  return (
    agent.updatedAt >= startedAt &&
    ((agent.tasks?.length ?? 0) > 0 ||
      (agent.journal?.length ?? 0) > 0 ||
      agent.pendingPermissions.length > 0)
  );
}

export function attentionKind(
  reason: AgentSnapshotPayload["attentionReason"],
  gap: boolean,
): Attention["kind"] {
  if (gap) return "gap";
  if (reason === "finished") return "completed";
  if (reason === "error") return "failed";
  if (reason === "permission") return "permission";
  return "changed";
}

export function hasImportantChange(input: {
  previousTimestamp: string | null;
  attentionTimestamp: string | null;
  attentionReason: AgentSnapshotPayload["attentionReason"];
  previouslyObserved: boolean;
  createdAt: string;
  monitoringStartedAt: string;
  gap: boolean;
}): boolean {
  const relevant =
    input.previouslyObserved ||
    input.createdAt >= input.monitoringStartedAt ||
    (input.attentionTimestamp !== null && input.attentionTimestamp >= input.monitoringStartedAt);
  return (
    relevant &&
    (input.gap ||
      (input.attentionReason != null &&
        input.attentionTimestamp !== null &&
        input.previousTimestamp !== input.attentionTimestamp))
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class WorkspaceObserver {
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private release: (() => Promise<void>) | null = null;
  private busy = Promise.resolve();
  private online: boolean | null = null;
  private watchFailed = false;
  private readonly startedAt: string;
  private readonly source: ObservationSource;

  constructor(
    private readonly environment: Environment,
    private readonly serverId: string,
    connection: DaemonAccess | ObservationSource,
    private readonly store: BridgeStore,
    private readonly events: BridgeEvents,
    private readonly now: () => number = Date.now,
  ) {
    this.source = "readClient" in connection ? daemonObservationSource(connection) : connection;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS observation_errors (environment TEXT NOT NULL, thread_id TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(environment, thread_id));
      CREATE TABLE IF NOT EXISTS observations (environment TEXT NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(environment, thread_id));
      CREATE TABLE IF NOT EXISTS observer_start (environment TEXT PRIMARY KEY, started_at TEXT NOT NULL);
    `);
    // Server identity belongs in the key: replacement daemons must not inherit a
    // previous daemon's cursor merely because both are labelled "dev".
    store.db
      .prepare("INSERT OR IGNORE INTO observer_start (environment, started_at) VALUES (?, ?)")
      .run(this.key, new Date(this.now()).toISOString());
    this.startedAt = z
      .object({ started_at: z.string() })
      .parse(
        store.db.prepare("SELECT started_at FROM observer_start WHERE environment=?").get(this.key),
      ).started_at;
    if (store.db.prepare("SELECT 1 FROM observer_start WHERE environment=?").get(environment)) {
      events.publish(`legacy-observation:${this.key}`, {
        environment,
        serverId,
        workspaceId: null,
        threadId: null,
        kind: "gap",
        summary:
          "Legacy observation cursors were not bound to server identity. A fresh baseline is being established; earlier events remain in retained history.",
        occurredAt: this.startedAt,
      });
    }
  }

  private get key(): string {
    return `${this.environment}:${this.serverId}`;
  }

  start(): void {
    const tick = async () => {
      await this.reconcile();
      if (!this.disposed)
        this.timer = setTimeout(() => {
          void tick();
        }, 5000);
    };
    void tick();
  }

  // A serialized full scan covers threads beyond the live subscription's first
  // page. Exposed so isolated acceptance can drive reconnects without real clocks.
  reconcile(): Promise<void> {
    return this.enqueue(() => this.scan());
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.busy = this.busy
      .then(async () => {
        if (!this.disposed) await work();
        return undefined;
      })
      .catch(() => this.markOffline());
    return this.busy;
  }

  private markOffline(): void {
    if (this.online !== false)
      this.environmentEvent(
        "offline",
        "Vorteo observation is unavailable. Current workspace information may be stale.",
      );
    this.online = false;
  }

  private async scan(): Promise<void> {
    if (this.watchFailed && this.release) {
      await this.release();
      this.release = null;
    }
    if (!this.release) {
      this.watchFailed = false;
      this.release = await this.source.watch(
        (agent) => {
          void this.enqueue(() => this.observeSafely(agent, false));
        },
        () => {
          this.watchFailed = true;
          this.markOffline();
        },
      );
    }
    const recovering = this.online !== true;
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.source.list(cursor);
      for (const agent of page.agents) {
        if (this.disposed) return;
        await this.observeSafely(agent, recovering);
      }
      cursor = page.next;
      if (cursor && seen.has(cursor)) throw new Error("Repeated inventory cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (!this.online)
      this.environmentEvent(
        "recovered",
        "Vorteo inventory reconciled. Per-thread history gaps may remain.",
      );
    this.online = true;
  }

  private environmentEvent(kind: "offline" | "recovered", summary: string): void {
    const occurredAt = new Date(this.now()).toISOString();
    this.events.publish(`${this.key}:${kind}:${occurredAt}`, {
      environment: this.environment,
      serverId: this.serverId,
      workspaceId: null,
      threadId: null,
      kind,
      summary,
      occurredAt,
    });
  }

  private async observeSafely(agent: ObservedThread, recovering: boolean): Promise<void> {
    try {
      await this.observe(agent, recovering);
      this.store.db
        .prepare("DELETE FROM observation_errors WHERE environment=? AND thread_id=?")
        .run(this.key, agent.id);
    } catch {
      const occurredAt = new Date(this.now()).toISOString();
      this.store.db
        .prepare(
          "INSERT INTO observation_errors (environment, thread_id, observed_at) VALUES (?, ?, ?) ON CONFLICT(environment, thread_id) DO UPDATE SET observed_at=excluded.observed_at",
        )
        .run(this.key, agent.id, occurredAt);
      this.events.publish(`history-unavailable:${this.key}:${agent.id}:${agent.updatedAt}`, {
        environment: this.environment,
        serverId: this.serverId,
        workspaceId: agent.workspaceId ?? null,
        threadId: agent.id,
        kind: "gap",
        summary:
          "Thread history is unavailable. Other threads remain observed; this thread will be retried.",
        occurredAt,
      });
    }
  }

  private async history(threadId: string, previous: Cursor | null) {
    const result = {
      cursor: previous,
      changed: false,
      gap: false,
      errors: [] as { cursor: Cursor; timestamp: string }[],
      lastTimestamp: null as string | null,
    };
    const consume = (page: HistoryPage, skipBefore: string | null, readThrough?: Cursor) => {
      for (const entry of page.entries) {
        if (skipBefore !== null && entry.timestamp < skipBefore) continue;
        if (
          readThrough &&
          readThrough.epoch === page.endCursor?.epoch &&
          entry.seqEnd <= readThrough.seq
        )
          continue;
        result.changed = true;
        result.lastTimestamp = entry.timestamp;
        if (entry.item.type === "error" && page.endCursor)
          result.errors.push({
            cursor: { epoch: page.endCursor.epoch, seq: entry.seqEnd },
            timestamp: entry.timestamp,
          });
      }
      result.cursor = page.endCursor ?? result.cursor;
    };
    if (!previous) {
      // First observation: one bounded tail page. If older rows exist and even
      // the oldest row read is after monitoring start, work may hide before the
      // window, so report a gap instead of claiming nothing else happened.
      const page = await this.source.history(threadId);
      consume(page, this.startedAt);
      const oldest = page.entries[0];
      result.gap =
        page.gap ||
        page.staleCursor ||
        page.reset ||
        (page.hasOlder === true && (!oldest || oldest.timestamp >= this.startedAt));
      return result;
    }
    let cursor = previous;
    const seen = new Set<string>();
    for (let pages = 1; !this.disposed; pages++) {
      const page = await this.source.history(threadId, cursor);
      consume(page, null);
      // On a stale cursor, gap or reset the daemon already answers with its tail.
      if (page.gap || page.staleCursor || page.reset) {
        result.gap = true;
        break;
      }
      if (!page.hasNewer) break;
      const key = JSON.stringify(page.endCursor);
      if (!page.endCursor || seen.has(key)) throw new Error("Timeline made no progress");
      seen.add(key);
      cursor = page.endCursor;
      if (pages >= MAX_HISTORY_PAGES) {
        // Re-anchor at the tail. It is a gap only if rows between the last row
        // read and the tail's first row were skipped.
        const tail = await this.source.history(threadId);
        const first = tail.startCursor;
        result.gap = !first || first.epoch !== cursor.epoch || first.seq > cursor.seq + 1;
        consume(tail, null, cursor);
        break;
      }
    }
    return result;
  }

  private async observe(agent: ObservedThread, recovering: boolean): Promise<void> {
    const raw = this.store.db
      .prepare("SELECT state FROM observations WHERE environment=? AND thread_id=?")
      .get(this.key, agent.id);
    const saved = raw
      ? SavedSchema.parse(JSON.parse(z.object({ state: z.string() }).parse(raw).state))
      : null;
    const evidence = fingerprint({
      tasks: agent.tasks ?? [],
      journal: agent.journal ?? [],
      permissions: agent.pendingPermissions.map((permission) => permission.id),
    });
    // Unchanged threads need no history, even while recovering: reading every
    // thread's timeline after a reconnect burst requests at the daemon.
    if (saved?.updatedAt === agent.updatedAt && saved.evidence === evidence) return;
    const untouched = !saved && agent.updatedAt < this.startedAt;
    if (untouched && agent.archivedAt) return;
    // Baseline an untouched older thread without reading history: nothing in it
    // is newer than monitoring start. Its first change reads the tail.
    const history = untouched
      ? { cursor: null, changed: false, gap: false, errors: [], lastTimestamp: null }
      : await this.history(agent.id, saved?.cursor ?? null);
    const notifications = this.notifications(agent, saved, evidence, history, recovering);
    const state: Saved = {
      updatedAt: agent.updatedAt,
      attentionTimestamp: agent.attentionTimestamp ?? null,
      attentionReason: agent.attentionReason ?? null,
      evidence,
      cursor: history.cursor,
    };
    this.events.publishBatch(notifications, () => {
      this.store.db
        .prepare(
          "INSERT INTO observations (environment, thread_id, state) VALUES (?, ?, ?) ON CONFLICT(environment, thread_id) DO UPDATE SET state=excluded.state",
        )
        .run(this.key, agent.id, JSON.stringify(state));
    });
  }

  private notifications(
    agent: ObservedThread,
    saved: Saved | null,
    evidence: string,
    history: Awaited<ReturnType<WorkspaceObserver["history"]>>,
    recovering: boolean,
  ) {
    const results: { id: string; data: Attention }[] = [];
    const publish = (
      kind: Attention["kind"],
      identity: unknown,
      occurredAt: string,
      summary: string,
      cursor = history.cursor,
    ) => {
      results.push({
        id: fingerprint([this.key, agent.id, kind, identity]),
        data: {
          environment: this.environment,
          serverId: this.serverId,
          workspaceId: agent.workspaceId ?? null,
          threadId: agent.id,
          kind,
          summary,
          occurredAt,
          ...(cursor ? { sourceCursor: cursor } : {}),
          operationIds: this.store.relatedOperations(this.environment, this.serverId, agent.id),
        },
      });
    };
    if (history.gap)
      publish(
        "gap",
        [saved?.cursor, history.cursor],
        agent.updatedAt,
        "Retained timeline has a gap or reset. Missed transitions are unknown.",
      );
    for (const error of history.errors)
      publish(
        "failed",
        error.cursor,
        error.timestamp,
        "Retained timeline contains an error. Current task state may have changed.",
        error.cursor,
      );
    const timestamp = agent.attentionTimestamp ?? null;
    const reasonChanged = saved?.attentionReason !== (agent.attentionReason ?? null);
    if (
      hasImportantChange({
        previousTimestamp: reasonChanged ? null : (saved?.attentionTimestamp ?? null),
        attentionTimestamp: timestamp,
        attentionReason: agent.attentionReason,
        previouslyObserved: saved !== null,
        createdAt: agent.createdAt,
        monitoringStartedAt: this.startedAt,
        gap: false,
      })
    ) {
      publish(
        attentionKind(agent.attentionReason, false),
        [agent.attentionReason, timestamp],
        timestamp ?? agent.updatedAt,
        `Thread has ${attentionKind(agent.attentionReason, false)} activity.`,
      );
    }
    if (evidenceChanged(agent, saved, evidence, this.startedAt))
      publish(
        "changed",
        evidence,
        agent.updatedAt,
        "Thread checklist, journal or pending input changed.",
      );
    if (history.changed && (recovering || !saved || agent.status !== "running"))
      publish(
        "changed",
        history.cursor,
        history.lastTimestamp ?? agent.updatedAt,
        "Work changed during catch-up. Timeline rows do not record every lifecycle transition.",
      );
    return results;
  }

  async close(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.busy;
    if (this.release) await this.release();
  }
}
