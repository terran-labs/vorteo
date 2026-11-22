import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIndexedDbDictationRecordingBackend } from "./recording-backend.web";
import { DictationRecordingStore } from "./recording-store";

const FORMAT = "audio/pcm;rate=16000;bits=16";

describe("DictationRecordingStore over IndexedDB", () => {
  it("keeps segments across a reload and deletes them once the transcript is applied", async () => {
    const factory = new IDBFactory();
    const first = new DictationRecordingStore(
      createIndexedDbDictationRecordingBackend(factory, IDBKeyRange),
    );
    const id = first.begin("host:agent", FORMAT);
    expect(id).not.toBeNull();
    for (let seq = 0; seq < 12; seq += 1) {
      first.append(id!, `segment-${seq}`);
    }
    await first.flush();

    // A reload is a new store over the same database; nothing in memory survives.
    const reloaded = new DictationRecordingStore(
      createIndexedDbDictationRecordingBackend(factory, IDBKeyRange),
    );
    expect(await reloaded.findPending("other:thread")).toBeNull();
    const pending = await reloaded.findPending("host:agent");
    expect(pending?.recording.id).toBe(id);
    expect(pending?.segments).toEqual(Array.from({ length: 12 }, (_, seq) => `segment-${seq}`));

    await reloaded.delete(id!);
    const afterConfirm = new DictationRecordingStore(
      createIndexedDbDictationRecordingBackend(factory, IDBKeyRange),
    );
    expect(await afterConfirm.findPending("host:agent")).toBeNull();
  });

  it("evicts the oldest recordings first when the byte cap is reached", async () => {
    const factory = new IDBFactory();
    let clock = 1_000;
    const store = new DictationRecordingStore(
      createIndexedDbDictationRecordingBackend(factory, IDBKeyRange),
      {
        maxBytes: 30,
        now: () => clock,
      },
    );
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

    expect(store.isAvailable).toBe(true);
    expect(await store.findPending("a")).toBeNull();
    expect((await store.findPending("b"))?.segments).toEqual(["y".repeat(10)]);
  });
});
