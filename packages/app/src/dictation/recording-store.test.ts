import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIndexedDbDictationRecordingBackend } from "./recording-backend.web";
import {
  DictationRecordingStore,
  MemoryDictationRecordingBackend,
  type DictationRecordingStoreEvent,
} from "./recording-store";
import { wavParts } from "./recording-wav";

const FORMAT = "audio/pcm;rate=16000;bits=16";

/** A tab's IndexedDB backend; the claim models the Web Lock a closed tab no longer holds. */
function indexedDbBackend(factory: IDBFactory) {
  return {
    ...createIndexedDbDictationRecordingBackend(factory, IDBKeyRange),
    claim: async () => () => undefined,
  };
}

describe("DictationRecordingStore", () => {
  it("keeps segments across a reload over IndexedDB and deletes them once applied", async () => {
    const factory = new IDBFactory();
    const first = new DictationRecordingStore(indexedDbBackend(factory));
    const id = first.begin("host:agent", FORMAT);
    expect(id).not.toBeNull();
    for (let seq = 0; seq < 12; seq += 1) {
      first.append(id!, `segment-${seq}`);
    }
    await first.flush();

    // A reload is a new store over the same database; nothing in memory survives.
    const reloaded = new DictationRecordingStore(indexedDbBackend(factory));
    expect(await reloaded.findPending("other:thread")).toBeNull();
    const pending = await reloaded.findPending("host:agent");
    expect(pending?.recording.id).toBe(id);
    expect(pending?.segments).toEqual(Array.from({ length: 12 }, (_, seq) => `segment-${seq}`));

    await reloaded.delete(id!);
    const afterConfirm = new DictationRecordingStore(indexedDbBackend(factory));
    expect(await afterConfirm.findPending("host:agent")).toBeNull();
  });

  it("evicts the oldest recordings first when the byte cap is reached", async () => {
    let clock = 1_000;
    const store = new DictationRecordingStore(new MemoryDictationRecordingBackend(), {
      maxBytes: 30,
      now: () => clock,
    });
    const events: DictationRecordingStoreEvent[] = [];
    store.subscribe((event) => events.push(event));
    const oldest = store.begin("a", FORMAT)!;
    store.append(oldest, "x".repeat(10));
    await store.flush();
    clock += 1;
    const middle = store.begin("b", FORMAT)!;
    store.append(middle, "y".repeat(10));
    await store.flush();
    store.release(oldest);
    store.release(middle);
    clock += 1;
    const newest = store.begin("c", FORMAT)!;
    store.append(newest, "z".repeat(15));
    await store.flush();

    expect(store.isComplete(newest)).toBe(true);
    // The owner is told that an older unsent recording was removed.
    expect(events.filter((event) => event.kind === "evicted")).toEqual([
      expect.objectContaining({
        kind: "evicted",
        reason: "space",
        recording: expect.objectContaining({ id: oldest }),
      }),
    ]);
    expect(await store.findPending("a")).toBeNull();
    expect((await store.findPending("b"))?.segments).toEqual(["y".repeat(10)]);
  });

  it("retries a failed write, and never offers a recording with a lost segment as whole", async () => {
    const backend = new MemoryDictationRecordingBackend();
    const store = new DictationRecordingStore(backend, { retryDelayMs: 0 });
    const recovered = store.begin("retried", FORMAT)!;
    backend.failNextSegmentWrites = 2;
    store.append(recovered, "r0");
    await store.flush();
    expect(store.isComplete(recovered)).toBe(true);

    const broken = store.begin("broken", FORMAT)!;
    store.append(broken, "b0");
    backend.failNextSegmentWrites = 3;
    store.append(broken, "b1");
    store.append(broken, "b2");
    await store.flush();
    expect(store.isComplete(broken)).toBe(false);
    expect(backend.recordings.get(broken)?.incomplete).toBe(true);

    // Storage stays on for the session: the next recording is stored in full.
    const next = store.begin("next", FORMAT)!;
    store.append(next, "n0");
    await store.flush();
    store.release(broken);
    store.release(next);
    const reloaded = new DictationRecordingStore(backend);
    expect(await reloaded.findPending("broken")).toBeNull();
    expect((await reloaded.findPending("next"))?.segments).toEqual(["n0"]);
  });

  it("does not offer a recording another tab owns, and deletes a removed host's audio", async () => {
    const locks = new Set<string>();
    const backend = new MemoryDictationRecordingBackend(locks);
    const tabA = new DictationRecordingStore(backend);
    const tabB = new DictationRecordingStore(backend);
    const id = tabA.begin("host:agent", FORMAT, "server-1")!;
    tabA.append(id, "live");
    await tabA.flush();

    expect(await tabB.findPending("host:agent")).toBeNull();
    tabA.release(id);
    expect((await tabB.findPending("host:agent"))?.segments).toEqual(["live"]);

    await tabB.deleteForServer("server-1");
    expect(backend.recordings.size).toBe(0);
    expect(locks.size).toBe(0);
  });

  it("builds a playable 16 kHz mono WAV from the stored segments", async () => {
    const pcm = (bytes: number[]) => Buffer.from(bytes).toString("base64");
    const parts: Uint8Array[] = [];
    for await (const part of wavParts([pcm([1, 0, 2, 0]), pcm([3, 0])])) {
      parts.push(part);
    }
    // A header plus one part per segment: no contiguous copy of the whole recording.
    expect(parts.map((part) => part.length)).toEqual([44, 4, 2]);
    const wav = Uint8Array.from(parts.flatMap((part) => Array.from(part)));
    const view = new DataView(wav.buffer);
    const ascii = (offset: number) => String.fromCharCode(...wav.slice(offset, offset + 4));

    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(6);
    expect(Array.from(wav.slice(44))).toEqual([1, 0, 2, 0, 3, 0]);
  });

  it("reports a recording as stored only once every segment is on the device", async () => {
    const backend = new MemoryDictationRecordingBackend();
    const store = new DictationRecordingStore(backend);
    const id = store.begin("host:agent", FORMAT)!;
    store.append(id, "s0");
    store.append(id, "s1");
    // The writes are still queued: the device holds none of them yet.
    expect(store.persistence(id, 2)).toBe("saving");
    await store.flush();
    expect(store.persistence(id, 2)).toBe("stored");
    expect(store.persistence(id, 3)).toBe("saving");
  });

  it("marks writes lost while storage was failing, and reports the failure once", async () => {
    const backend = new MemoryDictationRecordingBackend();
    const list = backend.listRecordings.bind(backend);
    let failures = 6;
    backend.listRecordings = async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("Connection to Indexed Database server lost");
      }
      return list();
    };
    const store = new DictationRecordingStore(backend);
    const events: DictationRecordingStoreEvent[] = [];
    store.subscribe((event) => events.push(event));

    const lost = store.begin("a", FORMAT)!;
    for (let seq = 0; seq < 5; seq += 1) {
      store.append(lost, `a${seq}`);
    }
    await store.flush();
    // Storage recovers and another recording begins, which clears the session failure.
    const next = store.begin("b", FORMAT)!;
    store.append(next, "b0");
    await store.flush();

    expect(store.persistence(lost, 5)).toBe("incomplete");
    expect(backend.segments.get(lost)).toBeUndefined();
    expect(events.filter((event) => event.kind === "unavailable")).toHaveLength(1);
    expect(store.persistence(next, 1)).toBe("stored");
  });

  it("bounds audio held in memory, says so when it drops some, and clears a removed Host's", async () => {
    const store = new DictationRecordingStore(null, { maxBytes: 10 });
    const events: DictationRecordingStoreEvent[] = [];
    store.subscribe((event) => events.push(event));
    const retained = (serverId: string, segment: string) => ({
      segments: [segment],
      createdAt: 1,
      format: FORMAT,
      storedId: null,
      serverId,
    });

    store.retainInMemory("old", retained("host-1", "a".repeat(6)));
    store.retainInMemory("new", retained("host-2", "b".repeat(6)));
    // Over the budget: the oldest is dropped and the owner is told.
    expect(events.filter((event) => event.kind === "evicted")).toHaveLength(1);

    store.retainInMemory("third", retained("host-1", "c".repeat(2)));
    await store.deleteForServer("host-1");
    expect(await store.findPending("third")).toBeNull();
    expect((await store.findPending("new"))?.segments).toEqual(["b".repeat(6)]);
    expect(await store.findPending("old")).toBeNull();
  });

  it("never drops the recording being retained, even when it alone exceeds the budget", async () => {
    const store = new DictationRecordingStore(null, { maxBytes: 100 });
    const events: DictationRecordingStoreEvent[] = [];
    store.subscribe((event) => events.push(event));
    store.retainInMemory("long", {
      segments: ["x".repeat(120)],
      createdAt: 1,
      format: FORMAT,
      storedId: null,
    });
    expect(events).toEqual([]);
    expect((await store.findPending("long"))?.segments).toEqual(["x".repeat(120)]);
  });

  it("lists unsent recordings, partial ones as partial, but never another tab's", async () => {
    const locks = new Set<string>();
    const backend = new MemoryDictationRecordingBackend(locks);
    let clock = 1_000_000;
    const now = () => clock;
    // A previous page: one complete recording, one that lost a write.
    const previous = new DictationRecordingStore(backend, { retryDelayMs: 0, now });
    const complete = previous.begin("dictation:a", FORMAT)!;
    previous.append(complete, "c0");
    const partial = previous.begin("dictation:b", FORMAT)!;
    previous.append(partial, "p0");
    await previous.flush();
    backend.failNextSegmentWrites = 3;
    previous.append(partial, "p1");
    await previous.flush();
    previous.release(complete);
    previous.release(partial);
    // Another tab is recording right now.
    const otherTab = new DictationRecordingStore(backend, { now });
    const live = otherTab.begin("dictation:c", FORMAT)!;
    otherTab.append(live, "l0");
    await otherTab.flush();
    clock += 60_000;

    const store = new DictationRecordingStore(backend, { now });
    store.retainInMemory("dictation:d", {
      segments: ["m0"],
      createdAt: 5,
      format: FORMAT,
      storedId: null,
    });
    const listed = await store.listUnsent();
    const byScope = Object.fromEntries(listed.map((row) => [row.scope, row]));
    expect(Object.keys(byScope).sort()).toEqual(["dictation:a", "dictation:b", "dictation:d"]);
    expect(byScope["dictation:a"]?.completeness).toBe("complete");
    expect(byScope["dictation:b"]?.completeness).toBe("partial");
    expect(byScope["dictation:b"]?.segmentCount).toBe(1);
    expect(byScope["dictation:d"]?.memoryOnly).toBe(true);
    expect(await store.readUnsent(partial)).toEqual(["p0"]);
  });

  it("never deletes from a stale list a recording another tab took, and lets a failed take go", async () => {
    const locks = new Set<string>();
    const backend = new MemoryDictationRecordingBackend(locks);
    const previous = new DictationRecordingStore(backend, { retryDelayMs: 0 });
    const id = previous.begin("dictation:a", FORMAT)!;
    previous.append(id, "a0");
    await previous.flush();
    previous.release(id);

    const tabA = new DictationRecordingStore(backend, { retryDelayMs: 0 });
    const tabB = new DictationRecordingStore(backend, { retryDelayMs: 0 });
    const [staleRow] = await tabB.listUnsent();
    expect(staleRow?.key).toBe(id);

    // Moving it fails on a storage error: the claim is let go, so every tab lists it again.
    const putRecording = backend.putRecording.bind(backend);
    backend.putRecording = () => Promise.reject(new Error("QuotaExceededError"));
    await expect(tabA.adoptUnsent(id, "dictation:here", undefined)).rejects.toThrow();
    backend.putRecording = putRecording;
    expect(locks.has(id)).toBe(false);
    expect((await tabB.listUnsent()).map((row) => row.key)).toEqual([id]);

    // Tab A takes it for Retry; tab B's stale Discard is refused and the audio survives.
    expect((await tabA.adoptUnsent(id, "dictation:here", undefined))?.segments).toEqual(["a0"]);
    expect(await tabB.discardUnsent(staleRow!.key)).toBe("unavailable");
    expect(backend.segments.get(id)).toEqual(["a0"]);
    expect(tabA.persistence(id, 1)).toBe("stored");

    // Once tab A lets it go, Discard deletes it and leaves no claim behind.
    tabA.release(id);
    expect(await tabB.discardUnsent(id)).toBe("discarded");
    expect(backend.recordings.has(id)).toBe(false);
    expect(locks.size).toBe(0);
  });
});
