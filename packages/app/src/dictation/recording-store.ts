/**
 * Keeps captured dictation audio on the device until a transcript is confirmed.
 *
 * Segments are written as they are recorded, so a reload, a composer unmount, an app kill or a
 * Host restart cannot lose them. A recording is deleted only after a non-empty final transcript
 * is applied or the owner presses Discard. Storage is bounded by total bytes and age, evicting
 * oldest first.
 *
 * A missing or failing backend never blocks dictation: the stream sender's in-memory buffer keeps
 * the full recording either way. A recording whose segments could not all be written is marked
 * incomplete so a restore never presents a partial copy as the whole recording.
 */

export interface StoredDictationRecording {
  id: string;
  /** Thread and draft the recording belongs to, so it is offered back in the same composer. */
  scope: string;
  /** Host the recording was made against; removing that host deletes it. */
  serverId?: string;
  format: string;
  createdAt: number;
  /** Refreshed by every write; doubles as the writer's heartbeat for other tabs. */
  updatedAt: number;
  segmentCount: number;
  /** Stored size of the base64 segments, in UTF-16 code units (one per base64 character). */
  bytes: number;
  /** Some segments could not be stored; the stored copy is not the whole recording. */
  incomplete?: boolean;
}

/** Releases a claim on a recording. */
export type DictationRecordingClaimRelease = () => void;

export interface DictationRecordingBackend {
  listRecordings(): Promise<StoredDictationRecording[]>;
  putRecording(recording: StoredDictationRecording): Promise<void>;
  putSegment(id: string, seq: number, base64Pcm: string): Promise<void>;
  readSegments(id: string, segmentCount: number): Promise<string[]>;
  deleteRecording(id: string): Promise<void>;
  /**
   * Claims a recording for this tab or app instance, or returns null when another one holds it.
   * Backends without other instances to coordinate with may omit it.
   */
  claim?(id: string): Promise<DictationRecordingClaimRelease | null>;
}

/** What the store tells the interface, so it never claims audio is safe when it is not. */
export type DictationRecordingStoreEvent =
  | { kind: "evicted"; recording: StoredDictationRecording; reason: "space" | "age" }
  | { kind: "unavailable"; error: Error }
  | { kind: "incomplete"; id: string }
  /** More of a recording reached the device; the persistence state may have changed. */
  | { kind: "written"; id: string };

/**
 * Where a recording's audio currently lives. "stored" is positive evidence: every segment the
 * caller holds is durably on the device. "saving" means writes are still queued.
 */
export type DictationRecordingPersistence = "stored" | "saving" | "memory-only" | "incomplete";

export interface PendingDictationRecording {
  recording: StoredDictationRecording;
  segments: string[];
  /**
   * The audio came from a composer's memory, not the device: the device copy is missing or
   * incomplete, so the notice must not say it is kept. recording.id is the incomplete device row
   * when there is one, or a placeholder id that no device row uses.
   */
  fromMemory?: boolean;
}

/** Audio a closing composer could not leave on the device, kept for the next mount. */
export interface RetainedDictationRecording {
  segments: string[];
  createdAt: number;
  format: string;
  /** The device row holding part of it, if any; adopting the audio adopts this row too. */
  storedId: string | null;
  serverId?: string;
}

const MEMORY_RECORDING_PREFIX = "memory-";

type RetainedEntry = RetainedDictationRecording & { retainedAt: number };

/**
 * About 50 minutes of 16 kHz 16-bit mono audio in base64; a 4 minute recording is about 10 MB.
 */
export const DICTATION_RECORDING_MAX_BYTES = 128 * 1024 * 1024;
export const DICTATION_RECORDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A recording another tab wrote this recently is treated as live even without a claim API. */
export const DICTATION_RECORDING_LIVE_WINDOW_MS = 15_000;
const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_DELAY_MS = 200;

export interface DictationRecordingStoreOptions {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
  createId?: () => string;
  retryDelayMs?: number;
}

function defaultCreateId(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type StoreTask = (
  backend: DictationRecordingBackend,
  known: Map<string, StoredDictationRecording>,
) => Promise<void>;

export class DictationRecordingStore {
  private readonly backend: DictationRecordingBackend | null;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly retryDelayMs: number;

  private queue: Promise<void> = Promise.resolve();
  /** One shared load of the stored index; concurrent first callers must not get separate maps. */
  private known: Promise<Map<string, StoredDictationRecording>> | null = null;
  /** Recordings this instance owns; never evicted or offered back while owned. */
  private readonly active = new Set<string>();
  private readonly claims = new Map<string, DictationRecordingClaimRelease>();
  /** Recordings with at least one segment that could not be stored. */
  private readonly incomplete = new Set<string>();
  private failure: Error | null = null;
  /** Audio left by closing composers that is not (wholly) on the device, newest last. */
  private readonly retained = new Map<string, RetainedEntry[]>();
  /** Handovers registered by closing composers whose stop has not finished yet. */
  private readonly handovers = new Map<string, Set<Promise<void>>>();
  /** Segments of each recording durably written, counted only after the write succeeded. */
  private readonly durable = new Map<string, number>();
  private readonly listeners = new Set<(event: DictationRecordingStoreEvent) => void>();

  constructor(
    backend: DictationRecordingBackend | null,
    options: DictationRecordingStoreOptions = {},
  ) {
    this.backend = backend;
    this.maxBytes = options.maxBytes ?? DICTATION_RECORDING_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? DICTATION_RECORDING_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? defaultCreateId;
    this.retryDelayMs = options.retryDelayMs ?? WRITE_RETRY_DELAY_MS;
  }

  subscribe(listener: (event: DictationRecordingStoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Where a recording's audio lives, given how many segments the caller holds. Reports "stored"
   * only when the device holds every one of them.
   */
  persistence(id: string | null, segmentCount: number): DictationRecordingPersistence {
    if (!id || !this.backend || id.startsWith(MEMORY_RECORDING_PREFIX)) {
      return "memory-only";
    }
    if (this.incomplete.has(id)) {
      return "incomplete";
    }
    const written = this.durable.get(id);
    if (written === segmentCount) {
      return "stored";
    }
    return this.isAvailable ? "saving" : "memory-only";
  }

  private emit(event: DictationRecordingStoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn("[DictationRecordingStore] Listener failed", error);
      }
    }
  }

  /** False while the device store is missing or could not be opened. */
  get isAvailable(): boolean {
    return this.backend !== null && this.failure === null;
  }

  get lastFailure(): Error | null {
    return this.failure;
  }

  /** True when every segment appended so far is on the device. */
  isComplete(id: string): boolean {
    return !this.incomplete.has(id);
  }

  /** Starts a stored recording and returns its id, or null when nothing can be stored. */
  begin(scope: string, format: string, serverId?: string): string | null {
    if (!this.backend) {
      // No device storage at all: tell the owner once per recording.
      this.emit({ kind: "unavailable", error: new Error("Device storage is unavailable") });
      return null;
    }
    // A failure to open storage is retried with each new recording rather than for the session.
    this.failure = null;
    const id = this.createId();
    const now = this.now();
    const recording: StoredDictationRecording = {
      id,
      scope,
      ...(serverId ? { serverId } : {}),
      format,
      createdAt: now,
      updatedAt: now,
      segmentCount: 0,
      bytes: 0,
    };
    this.active.add(id);
    this.enqueue(id, async (backend, known) => {
      await this.claimFor(backend, id);
      if (!this.active.has(id)) {
        // Released before this queued claim ran; do not hold the lock until the tab closes.
        this.release(id);
      }
      await this.prune(backend, known);
      known.set(id, recording);
      try {
        await this.withRetry(() => backend.putRecording(recording));
      } catch (error) {
        await this.markIncomplete(backend, known, recording, error);
        return;
      }
      this.durable.set(id, 0);
    });
    return id;
  }

  /** Appends one segment. Segments must arrive in order; seq is the recording's segment count. */
  append(id: string, base64Pcm: string): void {
    if (!this.backend) {
      return;
    }
    this.enqueue(id, async (backend, known) => {
      const recording = known.get(id);
      if (!recording || this.incomplete.has(id)) {
        // A gap cannot be repaired later, so stop writing after the first lost segment.
        if (!recording) {
          this.incomplete.add(id);
          this.emit({ kind: "incomplete", id });
        }
        return;
      }
      if (this.totalBytes(known) + base64Pcm.length > this.maxBytes) {
        await this.evictOldest(backend, known, base64Pcm.length);
      }
      const seq = recording.segmentCount;
      try {
        if (this.totalBytes(known) + base64Pcm.length > this.maxBytes) {
          throw new Error("Dictation recording storage is full");
        }
        await this.withRetry(() => backend.putSegment(id, seq, base64Pcm));
      } catch (error) {
        await this.markIncomplete(backend, known, recording, error);
        return;
      }
      const next: StoredDictationRecording = {
        ...recording,
        segmentCount: seq + 1,
        bytes: recording.bytes + base64Pcm.length,
        updatedAt: this.now(),
      };
      known.set(id, next);
      try {
        await this.withRetry(() => backend.putRecording(next));
      } catch (error) {
        await this.markIncomplete(backend, known, next, error);
        return;
      }
      this.durable.set(id, seq + 1);
      this.emit({ kind: "written", id });
    });
  }

  /**
   * Registers that a composer for this scope is closing and may hand over audio. A mount for the
   * same scope waits for it in findPending, so the audio is never missed or offered twice. The
   * caller must call the returned function once the handover is done.
   */
  beginHandover(scope: string): () => void {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = this.handovers.get(scope) ?? new Set<Promise<void>>();
    pending.add(done);
    this.handovers.set(scope, pending);
    return () => {
      pending.delete(done);
      if (pending.size === 0 && this.handovers.get(scope) === pending) {
        this.handovers.delete(scope);
      }
      finish();
    };
  }

  /**
   * Keeps audio a closing composer could not leave on the device for the next mount of its
   * scope, for as long as the page lives. The device row it partly fills, if any, stays owned by
   * this instance so another tab is never offered the incomplete copy meanwhile.
   */
  retainInMemory(scope: string, recording: RetainedDictationRecording): void {
    if (recording.segments.length === 0) {
      return;
    }
    if (recording.storedId) {
      this.active.add(recording.storedId);
    }
    const list = this.retained.get(scope) ?? [];
    const entry: RetainedEntry = { ...recording, retainedAt: this.now() };
    list.push(entry);
    this.retained.set(scope, list);
    this.boundRetained(entry);
  }

  /**
   * Keeps memory-held audio within the same byte budget as the device store, dropping the
   * oldest first. Every drop is reported as an eviction, so the owner is told; a dropped entry's
   * partial device row is released and stays on the device. The entry being retained now is
   * never dropped: it is that recording's only copy, so retention may exceed the budget by it.
   */
  private boundRetained(justRetained: RetainedEntry): void {
    const entries: { scope: string; entry: RetainedEntry; bytes: number }[] = [];
    let total = 0;
    for (const [scope, list] of this.retained) {
      for (const entry of list) {
        const bytes = entry.segments.reduce((sum, segment) => sum + segment.length, 0);
        entries.push({ scope, entry, bytes });
        total += bytes;
      }
    }
    entries.sort((left, right) => left.entry.retainedAt - right.entry.retainedAt);
    for (const { scope, entry, bytes } of entries) {
      if (total <= this.maxBytes) {
        return;
      }
      if (entry === justRetained) {
        continue;
      }
      this.dropRetained(scope, entry, "space");
      total -= bytes;
    }
  }

  private dropRetained(scope: string, entry: RetainedEntry, reason: "space" | "host"): void {
    const list = this.retained.get(scope);
    if (!list) {
      return;
    }
    const index = list.indexOf(entry);
    if (index >= 0) {
      list.splice(index, 1);
    }
    if (list.length === 0) {
      this.retained.delete(scope);
    }
    if (entry.storedId) {
      this.release(entry.storedId);
    }
    if (reason === "space") {
      this.emit({ kind: "evicted", recording: this.describeRetained(scope, entry), reason });
    }
  }

  private describeRetained(scope: string, entry: RetainedEntry): StoredDictationRecording {
    return {
      id: entry.storedId ?? `${MEMORY_RECORDING_PREFIX}${this.createId()}`,
      scope,
      ...(entry.serverId ? { serverId: entry.serverId } : {}),
      format: entry.format,
      createdAt: entry.createdAt,
      updatedAt: entry.retainedAt,
      segmentCount: entry.segments.length,
      bytes: entry.segments.reduce((total, segment) => total + segment.length, 0),
      incomplete: true,
    };
  }

  /** Records the Host the audio is delivered to, when a draft switches Host. */
  restamp(id: string, serverId: string | undefined): void {
    if (!serverId || id.startsWith(MEMORY_RECORDING_PREFIX)) {
      return;
    }
    this.enqueue(id, async (backend, known) => {
      const recording = known.get(id);
      if (!recording || recording.serverId === serverId) {
        return;
      }
      const next = { ...recording, serverId };
      known.set(id, next);
      await this.withRetry(() => backend.putRecording(next));
    });
  }

  /** Gives up ownership so a later mount or another tab may offer the recording back. */
  release(id: string): void {
    this.active.delete(id);
    this.claims.get(id)?.();
    this.claims.delete(id);
  }

  /**
   * Deletes a recording. Call only after a non-empty final transcript was applied or the owner
   * pressed Discard.
   */
  async delete(id: string): Promise<void> {
    if (!this.backend) {
      this.release(id);
      return;
    }
    const backend = this.backend;
    // Deletion runs even after a write failure so applied audio never lingers on the device.
    await this.exclusive(() => this.deleteNow(backend, id)).catch((error: unknown) => {
      console.warn("[DictationRecordingStore] Failed to delete recording", error);
    });
    this.incomplete.delete(id);
    this.durable.delete(id);
    this.release(id);
  }

  /** Deletes every recording made against a host, for host removal. */
  async deleteForServer(serverId: string): Promise<void> {
    // Memory-held audio for the removed Host goes too; it is private to that Host.
    // Copied first: dropping an entry changes the map and the list being walked.
    for (const [scope, list] of Array.from(this.retained)) {
      for (const entry of Array.from(list)) {
        if (entry.serverId === serverId) {
          this.dropRetained(scope, entry, "host");
        }
      }
    }
    const backend = this.backend;
    if (!backend) {
      return;
    }
    await this.exclusive(async () => {
      const known = await this.loadKnown(backend);
      for (const recording of known.values()) {
        if (recording.serverId === serverId) {
          known.delete(recording.id);
          this.release(recording.id);
          await backend.deleteRecording(recording.id);
        }
      }
    }).catch((error: unknown) => {
      console.warn("[DictationRecordingStore] Failed to delete a removed host's recordings", error);
    });
  }

  /**
   * Claims and returns the newest complete recording for the scope that no tab or composer owns.
   * The caller owns the result and must call release() if it does not use it.
   */
  async findPending(scope: string): Promise<PendingDictationRecording | null> {
    // A composer for this scope may still be closing; wait until it has handed over.
    const handovers = this.handovers.get(scope);
    if (handovers && handovers.size > 0) {
      await Promise.all(handovers);
    }
    const memory = this.takeRetained(scope);
    if (memory) {
      return memory;
    }
    const backend = this.backend;
    if (!backend) {
      return null;
    }
    return this.exclusive(() => this.findPendingNow(backend, scope));
  }

  /** Newest audio retained in memory for the scope, adopted by the caller. */
  private takeRetained(scope: string): PendingDictationRecording | null {
    const list = this.retained.get(scope);
    const entry = list?.pop();
    if (list && list.length === 0) {
      this.retained.delete(scope);
    }
    if (!entry) {
      return null;
    }
    const id = entry.storedId ?? `${MEMORY_RECORDING_PREFIX}${this.createId()}`;
    if (entry.storedId) {
      // Still owned by this instance since the handover; the caller now holds it.
      this.active.add(entry.storedId);
    }
    return {
      recording: {
        id,
        scope,
        ...(entry.serverId ? { serverId: entry.serverId } : {}),
        format: entry.format,
        createdAt: entry.createdAt,
        updatedAt: this.now(),
        segmentCount: entry.segments.length,
        bytes: entry.segments.reduce((total, segment) => total + segment.length, 0),
        incomplete: true,
      },
      segments: entry.segments,
      fromMemory: true,
    };
  }

  private async findPendingNow(
    backend: DictationRecordingBackend,
    scope: string,
  ): Promise<PendingDictationRecording | null> {
    try {
      // Re-read: another tab may have written since this instance loaded the index.
      this.known = null;
      const known = await this.loadKnown(backend);
      await this.prune(backend, known);
      const liveCutoff = this.now() - DICTATION_RECORDING_LIVE_WINDOW_MS;
      const candidates = [...known.values()]
        .filter(
          (recording) =>
            recording.scope === scope &&
            recording.segmentCount > 0 &&
            // Incomplete copies wait for the recordings list in the follow-up interface.
            !recording.incomplete &&
            !this.active.has(recording.id),
        )
        .sort((left, right) => right.updatedAt - left.updatedAt);
      for (const recording of candidates) {
        const claimed = await this.claimFor(backend, recording.id);
        if (!claimed) {
          continue;
        }
        if (!backend.claim && recording.updatedAt > liveCutoff) {
          // Without a claim API, a fresh heartbeat means another tab is still writing it.
          this.release(recording.id);
          continue;
        }
        this.active.add(recording.id);
        let segments: string[];
        try {
          segments = await backend.readSegments(recording.id, recording.segmentCount);
        } catch (error) {
          this.release(recording.id);
          throw error;
        }
        if (segments.length !== recording.segmentCount) {
          this.release(recording.id);
          continue;
        }
        this.durable.set(recording.id, segments.length);
        return { recording, segments };
      }
      return null;
    } catch (error) {
      console.warn("[DictationRecordingStore] Failed to read stored recordings", error);
      return null;
    }
  }

  /** Resolves once every queued write has settled. */
  async flush(): Promise<void> {
    await this.queue;
  }

  /** Runs work in the queue, so reads and deletes never interleave with writes. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private enqueue(id: string, task: StoreTask): void {
    const backend = this.backend;
    if (!backend) {
      return;
    }
    this.queue = this.queue.then(() => this.runTask(backend, id, task));
  }

  private async runTask(
    backend: DictationRecordingBackend,
    id: string,
    task: StoreTask,
  ): Promise<void> {
    let known: Map<string, StoredDictationRecording>;
    try {
      known = await this.loadKnown(backend);
    } catch (error) {
      const wasFailing = this.failure !== null;
      this.failure = error instanceof Error ? error : new Error(String(error));
      // The write this task carried is lost, so the device copy now has a gap.
      if (!this.incomplete.has(id)) {
        this.incomplete.add(id);
        this.emit({ kind: "incomplete", id });
      }
      // Tell the owner on the transition into failure only, not once per segment.
      if (!wasFailing) {
        this.emit({ kind: "unavailable", error: this.failure });
        console.warn(
          "[DictationRecordingStore] Device storage unavailable; keeping dictation audio in memory only",
          this.failure,
        );
      }
      return;
    }
    try {
      await task(backend, known);
    } catch (error) {
      console.warn("[DictationRecordingStore] Dictation storage write failed", error);
    }
  }

  private async withRetry(write: () => Promise<void>): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      try {
        await write();
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < WRITE_ATTEMPTS) {
          await delay(this.retryDelayMs);
        }
      }
    }
    throw lastError;
  }

  private async markIncomplete(
    backend: DictationRecordingBackend,
    known: Map<string, StoredDictationRecording>,
    recording: StoredDictationRecording,
    error: unknown,
  ): Promise<void> {
    this.incomplete.add(recording.id);
    this.emit({ kind: "incomplete", id: recording.id });
    console.warn(
      "[DictationRecordingStore] Could not store every dictation segment; the full recording stays in memory",
      error,
    );
    const marked = { ...recording, incomplete: true, updatedAt: this.now() };
    known.set(recording.id, marked);
    try {
      await backend.putRecording(marked);
    } catch {
      // Unmarked metadata still counts fewer segments than were recorded; restore compares them.
    }
  }

  private async claimFor(backend: DictationRecordingBackend, id: string): Promise<boolean> {
    if (this.claims.has(id)) {
      return true;
    }
    if (!backend.claim) {
      return true;
    }
    try {
      const release = await backend.claim(id);
      if (!release) {
        return false;
      }
      this.claims.set(id, release);
      return true;
    } catch {
      return true;
    }
  }

  private async deleteNow(backend: DictationRecordingBackend, id: string): Promise<void> {
    const known = await this.loadKnown(backend);
    known.delete(id);
    await backend.deleteRecording(id);
  }

  private async loadKnown(
    backend: DictationRecordingBackend,
  ): Promise<Map<string, StoredDictationRecording>> {
    this.known ??= backend.listRecordings().then(
      (recordings) => new Map(recordings.map((recording) => [recording.id, recording])),
      (error: unknown) => {
        this.known = null;
        throw error;
      },
    );
    return this.known;
  }

  private totalBytes(known: Map<string, StoredDictationRecording>): number {
    let total = 0;
    for (const recording of known.values()) {
      total += recording.bytes;
    }
    return total;
  }

  private async prune(
    backend: DictationRecordingBackend,
    known: Map<string, StoredDictationRecording>,
  ): Promise<void> {
    const cutoff = this.now() - this.maxAgeMs;
    // Deleting the current entry while iterating a Map is safe.
    for (const recording of known.values()) {
      if (!this.active.has(recording.id) && recording.updatedAt < cutoff) {
        known.delete(recording.id);
        await backend.deleteRecording(recording.id);
        this.emit({ kind: "evicted", recording, reason: "age" });
      }
    }
    await this.evictOldest(backend, known, 0);
  }

  private async evictOldest(
    backend: DictationRecordingBackend,
    known: Map<string, StoredDictationRecording>,
    incomingBytes: number,
  ): Promise<void> {
    const oldestFirst = [...known.values()]
      .filter((recording) => !this.active.has(recording.id))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const recording of oldestFirst) {
      if (this.totalBytes(known) + incomingBytes <= this.maxBytes) {
        return;
      }
      known.delete(recording.id);
      await backend.deleteRecording(recording.id);
      this.emit({ kind: "evicted", recording, reason: "space" });
    }
  }
}

/** In-memory backend for tests; pass a shared lock set to model two tabs. */
export class MemoryDictationRecordingBackend implements DictationRecordingBackend {
  readonly recordings = new Map<string, StoredDictationRecording>();
  readonly segments = new Map<string, string[]>();
  failNextSegmentWrites = 0;

  constructor(private readonly locks: Set<string> | null = null) {}

  async listRecordings(): Promise<StoredDictationRecording[]> {
    return [...this.recordings.values()].map((recording) => structuredClone(recording));
  }

  async putRecording(recording: StoredDictationRecording): Promise<void> {
    this.recordings.set(recording.id, structuredClone(recording));
  }

  async putSegment(id: string, seq: number, base64Pcm: string): Promise<void> {
    if (this.failNextSegmentWrites > 0) {
      this.failNextSegmentWrites -= 1;
      throw new Error("QuotaExceededError");
    }
    const list = this.segments.get(id) ?? [];
    list[seq] = base64Pcm;
    this.segments.set(id, list);
  }

  async readSegments(id: string, segmentCount: number): Promise<string[]> {
    return (this.segments.get(id) ?? []).slice(0, segmentCount);
  }

  async deleteRecording(id: string): Promise<void> {
    this.recordings.delete(id);
    this.segments.delete(id);
  }

  claim = async (id: string): Promise<DictationRecordingClaimRelease | null> => {
    const locks = this.locks;
    if (!locks) {
      return () => undefined;
    }
    if (locks.has(id)) {
      return null;
    }
    locks.add(id);
    return () => {
      locks.delete(id);
    };
  };
}
