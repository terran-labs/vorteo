import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIndexedDbDictationRecordingBackend } from "./recording-backend.web";
import {
  DictationRecordingStore,
  MemoryDictationRecordingBackend,
  type DictationRecordingStoreEvent,
} from "./recording-store";
import { buildDictationWav } from "./recording-wav";

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
    expect(events).toEqual([
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

  it("builds a playable 16 kHz mono WAV from the stored segments", () => {
    const pcm = (bytes: number[]) => Buffer.from(bytes).toString("base64");
    const wav = buildDictationWav([pcm([1, 0, 2, 0]), pcm([3, 0])]);
    const view = new DataView(wav.buffer);
    const ascii = (offset: number) => String.fromCharCode(...wav.slice(offset, offset + 4));

    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(6);
    expect(Array.from(wav.slice(44))).toEqual([1, 0, 2, 0, 3, 0]);
  });
});
