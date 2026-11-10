import { demoStorageName } from "@/demo/mode";
import {
  encodeOutboxKey,
  nextOutboxOrder,
  OutboxRecordSchema,
  validateOutboxExchange,
  type OutboxStorage,
  type OutboxRecord,
} from "./outbox-record";

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Outbox storage request failed")),
    );
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Outbox transaction aborted")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Outbox transaction failed")),
    );
  });
}

export function createOutboxStorage(
  databaseName = demoStorageName("paseo-message-outbox"),
): OutboxStorage {
  // One shared connection serves every transaction. The browser can close it
  // without our consent (storage pressure, backing store errors, an idle or
  // frozen tab), so a closed connection must be forgotten and reopened rather
  // than cached forever. Otherwise every later read, including the queue's
  // Retry, fails with "The database connection is closing."
  let opening: Promise<IDBDatabase> | null = null;
  function forget(db: IDBDatabase, pending: Promise<IDBDatabase> | null): void {
    if (opening === pending) opening = null;
    db.close();
  }
  function database(): Promise<IDBDatabase> {
    if (opening) return opening;
    const pending: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.addEventListener("upgradeneeded", () =>
        request.result.createObjectStore("operations"),
      );
      request.addEventListener("success", () => {
        const db = request.result;
        db.addEventListener("versionchange", () => forget(db, pending));
        db.addEventListener("close", () => forget(db, pending));
        resolve(db);
      });
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Cannot open message outbox")),
      );
      request.addEventListener("blocked", () =>
        reject(new Error("Close other Vorteo tabs to upgrade the message outbox.")),
      );
    }).catch((error: unknown) => {
      if (opening === pending) opening = null;
      throw error;
    });
    opening = pending;
    return pending;
  }

  /** Starts a transaction, reopening once if the cached connection has closed. */
  async function begin(mode: IDBTransactionMode): Promise<IDBTransaction> {
    const pending = database();
    const db = await pending;
    try {
      return db.transaction("operations", mode, { durability: "strict" });
    } catch (error) {
      // Some engines close the connection without firing "close" first.
      if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
      forget(db, pending);
      return (await database()).transaction("operations", mode, { durability: "strict" });
    }
  }

  async function transact<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const transaction = await begin(mode);
    const done = completed(transaction);
    try {
      const result = await run(transaction.objectStore("operations"));
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already completed or aborted. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  return {
    list: () =>
      transact("readonly", async (store) => {
        const records: unknown[] = await requestValue(store.getAll());
        return records.map((record) => OutboxRecordSchema.parse(record));
      }),
    read: (key) =>
      transact("readonly", async (store) => {
        const record: unknown = await requestValue(store.get(encodeOutboxKey(key)));
        return record === undefined ? null : OutboxRecordSchema.parse(record);
      }),
    exchange: (key, expectedRevision, value) => {
      validateOutboxExchange(key, expectedRevision, value);
      return transact("readwrite", async (store) => {
        const encoded = encodeOutboxKey(key);
        const current: OutboxRecord | undefined = await requestValue(store.get(encoded));
        const revision = current === undefined ? null : OutboxRecordSchema.parse(current).revision;
        if (revision !== expectedRevision) return false;
        if (value) {
          const order =
            current?.order ??
            (current
              ? undefined
              : // A reissued command keeps its place in line; new commits take the next slot.
                (value.order ??
                nextOutboxOrder(
                  (await requestValue(store.getAll())).map((record: unknown) =>
                    OutboxRecordSchema.parse(record),
                  ),
                )));
          await requestValue(store.put({ ...value, order }, encoded));
        } else await requestValue(store.delete(encoded));
        return true;
      });
    },
  };
}
