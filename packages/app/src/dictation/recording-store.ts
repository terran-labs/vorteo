/**
 * Keeps captured dictation audio on the device until a transcript is confirmed.
 *
 * Segments are written as they are recorded, so a reload, a composer unmount, an app kill or a
 * Host restart cannot lose them. A recording is deleted only after its transcript is applied or
 * the owner discards it. Storage is bounded by total bytes and age, evicting oldest first.
 *
 * A missing or failing backend never blocks dictation: the store reports itself unavailable and
 * the stream sender's in-memory buffer remains the only copy.
 */

export interface StoredDictationRecording {
  id: string;
  /** Thread and draft the recording belongs to, so it is offered back in the same composer. */
  scope: string;
  format: string;
  createdAt: number;
  updatedAt: number;
  segmentCount: number;
  /** Stored size of the base64 segments, in UTF-16 code units (one per base64 character). */
  bytes: number;
}

export interface DictationRecordingBackend {
  listRecordings(): Promise<StoredDictationRecording[]>;
  putRecording(recording: StoredDictationRecording): Promise<void>;
  putSegment(id: string, seq: number, base64Pcm: string): Promise<void>;
  readSegments(id: string, segmentCount: number): Promise<string[]>;
  deleteRecording(id: string): Promise<void>;
}

export interface PendingDictationRecording {
  recording: StoredDictationRecording;
  segments: string[];
}

/**
 * About 50 minutes of 16 kHz 16-bit mono audio in base64; a 4 minute recording is about 10 MB.
 */
export const DICTATION_RECORDING_MAX_BYTES = 128 * 1024 * 1024;
export const DICTATION_RECORDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface DictationRecordingStoreOptions {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
  createId?: () => string;
}

function defaultCreateId(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class DictationRecordingStore {
  private readonly backend: DictationRecordingBackend | null;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  private queue: Promise<void> = Promise.resolve();
  /** One shared load of the stored index; concurrent first callers must not get separate maps. */
  private known: Promise<Map<string, StoredDictationRecording>> | null = null;
  /** Recordings this store instance is writing; never evicted or offered back while active. */
  private readonly active = new Set<string>();
  private failure: Error | null = null;

  constructor(
    backend: DictationRecordingBackend | null,
    options: DictationRecordingStoreOptions = {},
  ) {
    this.backend = backend;
    this.maxBytes = options.maxBytes ?? DICTATION_RECORDING_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? DICTATION_RECORDING_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? defaultCreateId;
  }

  /** False once the device store is missing, full or failing; audio then lives in memory only. */
  get isAvailable(): boolean {
    return this.backend !== null && this.failure === null;
  }

  get lastFailure(): Error | null {
    return this.failure;
  }

  /** Starts a stored recording and returns its id, or null when nothing can be stored. */
  begin(scope: string, format: string): string | null {
    if (!this.isAvailable) {
      return null;
    }
    const id = this.createId();
    const now = this.now();
    const recording: StoredDictationRecording = {
      id,
      scope,
      format,
      createdAt: now,
      updatedAt: now,
      segmentCount: 0,
      bytes: 0,
    };
    this.active.add(id);
    this.enqueue(async (backend, known) => {
      await this.prune(backend, known);
      known.set(id, recording);
      await backend.putRecording(recording);
    });
    return id;
  }

  /** Appends one segment. Segments must arrive in order; seq is the recording's segment count. */
  append(id: string, base64Pcm: string): void {
    if (!this.isAvailable) {
      return;
    }
    this.enqueue(async (backend, known) => {
      const recording = known.get(id);
      if (!recording) {
        return;
      }
      if (this.totalBytes(known) + base64Pcm.length > this.maxBytes) {
        await this.evictOldest(backend, known, base64Pcm.length);
      }
      if (this.totalBytes(known) + base64Pcm.length > this.maxBytes) {
        throw new Error("Dictation recording storage is full");
      }
      const seq = recording.segmentCount;
      await backend.putSegment(id, seq, base64Pcm);
      const next: StoredDictationRecording = {
        ...recording,
        segmentCount: seq + 1,
        bytes: recording.bytes + base64Pcm.length,
        updatedAt: this.now(),
      };
      known.set(id, next);
      await backend.putRecording(next);
    });
  }

  /** Marks a recovered recording as in use by this composer so no other one offers it too. */
  adopt(id: string): void {
    this.active.add(id);
  }

  /** Stops treating the recording as in progress, so a later mount may offer it back. */
  release(id: string): void {
    this.active.delete(id);
  }

  /** Deletes a recording after its transcript was applied or the owner discarded it. */
  async delete(id: string): Promise<void> {
    this.active.delete(id);
    if (!this.backend) {
      return;
    }
    // Deletion runs even after a write failure so a confirmed transcript never leaves audio behind.
    const backend = this.backend;
    const run = this.queue.then(() => this.deleteNow(backend, id));
    this.queue = run.catch((error: unknown) => {
      console.warn("[DictationRecordingStore] Failed to delete recording", error);
    });
    await this.queue;
  }

  /** Newest unfinished recording for the scope that this store is not currently writing. */
  async findPending(scope: string): Promise<PendingDictationRecording | null> {
    if (!this.backend) {
      return null;
    }
    await this.flush();
    try {
      const known = await this.loadKnown(this.backend);
      await this.prune(this.backend, known);
      const candidates = [...known.values()]
        .filter(
          (recording) =>
            recording.scope === scope &&
            recording.segmentCount > 0 &&
            !this.active.has(recording.id),
        )
        .sort((left, right) => right.updatedAt - left.updatedAt);
      const recording = candidates[0];
      if (!recording) {
        return null;
      }
      const segments = await this.backend.readSegments(recording.id, recording.segmentCount);
      return { recording: { ...recording, segmentCount: segments.length }, segments };
    } catch (error) {
      console.warn("[DictationRecordingStore] Failed to read stored recordings", error);
      return null;
    }
  }

  /** Resolves once every queued write has settled. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue(
    task: (
      backend: DictationRecordingBackend,
      known: Map<string, StoredDictationRecording>,
    ) => Promise<void>,
  ): void {
    const backend = this.backend;
    if (!backend) {
      return;
    }
    this.queue = this.queue.then(() => this.runTask(backend, task));
  }

  private async runTask(
    backend: DictationRecordingBackend,
    task: (
      backend: DictationRecordingBackend,
      known: Map<string, StoredDictationRecording>,
    ) => Promise<void>,
  ): Promise<void> {
    if (this.failure) {
      return;
    }
    try {
      await task(backend, await this.loadKnown(backend));
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      console.warn(
        "[DictationRecordingStore] Device storage unavailable; keeping dictation audio in memory only",
        this.failure,
      );
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
    }
  }
}

/** In-memory backend for tests and platforms without device storage. */
export class MemoryDictationRecordingBackend implements DictationRecordingBackend {
  readonly recordings = new Map<string, StoredDictationRecording>();
  readonly segments = new Map<string, string[]>();

  async listRecordings(): Promise<StoredDictationRecording[]> {
    return [...this.recordings.values()].map((recording) => structuredClone(recording));
  }

  async putRecording(recording: StoredDictationRecording): Promise<void> {
    this.recordings.set(recording.id, { ...recording });
  }

  async putSegment(id: string, seq: number, base64Pcm: string): Promise<void> {
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
}
