import { demoStorageName } from "@/demo/mode";
import type {
  DictationRecordingBackend,
  DictationRecordingClaimRelease,
  StoredDictationRecording,
} from "./recording-store";

// IndexedDB keeps recordings across reloads, tab closes and PWA restarts on web and iOS Safari.
const DATABASE_NAME = demoStorageName("vorteo-dictation-recordings");
const RECORDINGS = "recordings";
const SEGMENTS = "segments";

function segmentKey(id: string, seq: number): string {
  return `${id}:${seq.toString().padStart(8, "0")}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Dictation recording write was aborted")),
    );
  });
}

export function createIndexedDbDictationRecordingBackend(
  factory: IDBFactory,
  keyRange: typeof IDBKeyRange,
  databaseName = DATABASE_NAME,
): DictationRecordingBackend {
  const segmentRange = (id: string) => keyRange.bound(`${id}:`, `${id}:\uffff`);
  let databasePromise: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    databasePromise ??= new Promise((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RECORDINGS)) {
          database.createObjectStore(RECORDINGS, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(SEGMENTS)) {
          database.createObjectStore(SEGMENTS);
        }
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => {
        databasePromise = null;
        reject(request.error ?? new Error("Failed to open dictation recording storage"));
      });
    });
    return databasePromise;
  };

  return {
    async listRecordings() {
      const database = await open();
      const store = database.transaction(RECORDINGS, "readonly").objectStore(RECORDINGS);
      return (await requestResult(store.getAll())) as StoredDictationRecording[];
    },
    async putRecording(recording) {
      const database = await open();
      const transaction = database.transaction(RECORDINGS, "readwrite");
      transaction.objectStore(RECORDINGS).put(recording);
      await transactionDone(transaction);
    },
    async putSegment(id, seq, base64Pcm) {
      const database = await open();
      const transaction = database.transaction(SEGMENTS, "readwrite");
      transaction.objectStore(SEGMENTS).put(base64Pcm, segmentKey(id, seq));
      await transactionDone(transaction);
    },
    async readSegments(id, segmentCount) {
      const database = await open();
      const store = database.transaction(SEGMENTS, "readonly").objectStore(SEGMENTS);
      const values = (await requestResult(store.getAll(segmentRange(id)))) as string[];
      return values.slice(0, segmentCount);
    },
    async deleteRecording(id) {
      const database = await open();
      const transaction = database.transaction([RECORDINGS, SEGMENTS], "readwrite");
      transaction.objectStore(RECORDINGS).delete(id);
      transaction.objectStore(SEGMENTS).delete(segmentRange(id));
      await transactionDone(transaction);
    },
  };
}

/**
 * Holds a Web Lock per recording for as long as this tab owns it, so a second tab on the same
 * thread is never offered a recording the first is writing, retrying or discarding. The lock is
 * dropped automatically when the tab closes or crashes.
 */
const LOCK_PREFIX = "vorteo-dictation-recording:";

/**
 * Recording ids whose Web Lock is held, by any tab, found with locks.query() so listing never
 * takes or waits for a lock. The caller excludes its own recordings separately.
 */
export function createWebLockHeldQuery(locks: LockManager): () => Promise<Set<string>> {
  return async () => {
    const snapshot = await locks.query();
    const held = new Set<string>();
    for (const lock of snapshot.held ?? []) {
      if (lock.name?.startsWith(LOCK_PREFIX)) {
        held.add(lock.name.slice(LOCK_PREFIX.length));
      }
    }
    return held;
  };
}

export function createWebLockClaim(
  locks: LockManager,
): (id: string) => Promise<DictationRecordingClaimRelease | null> {
  return (id) =>
    new Promise((resolve, reject) => {
      locks
        .request(`${LOCK_PREFIX}${id}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return undefined;
          }
          return new Promise<void>((release) => {
            resolve(() => release());
          });
        })
        .catch(reject);
    });
}

export function createDeviceDictationRecordingBackend(): DictationRecordingBackend | null {
  if (typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined") {
    return null;
  }
  const backend = createIndexedDbDictationRecordingBackend(indexedDB, IDBKeyRange);
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  // Without Web Locks (Safari before 15.4) the store falls back to the updated-at heartbeat.
  return locks
    ? { ...backend, claim: createWebLockClaim(locks), heldByOthers: createWebLockHeldQuery(locks) }
    : backend;
}
