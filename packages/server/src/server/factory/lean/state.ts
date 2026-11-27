import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import { RevisionConflictError, type LeanLedger, type LeanStateStore } from "./types.js";

export function emptyLedger(): LeanLedger {
  return {
    version: 1,
    revision: 0,
    runners: {},
    leases: {},
    parkedAccounts: {},
    deadlines: {},
    acceptances: {},
    answeredEvents: {},
    pendingEvents: [],
    escalations: [],
    intent: {},
    rules: [],
    delivery: { lock: null, receipts: [] },
    releases: [],
    preauthorization: null,
    local: { runners: 1, heavyQueueLimit: 0 },
    loopBeat: null,
  };
}

export function createLeanStateStore(home: string): LeanStateStore {
  const writes = new Map<string, Promise<void>>();
  function file(projectId: string): string {
    if (!projectId || /[/\\]/u.test(projectId) || projectId.includes("\0"))
      throw new Error("Invalid project identifier.");
    return path.join(home, "factory", "lean", projectId + ".json");
  }
  async function read(projectId: string): Promise<LeanLedger> {
    try {
      const state = JSON.parse(await readFile(file(projectId), "utf8"));
      if (state.version !== 1 || !Number.isSafeInteger(state.revision)) {
        throw new Error("Unsupported Factory ledger.");
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
      throw error;
    }
  }
  return {
    read,
    async mutate(projectId, change, expectedRevision) {
      const result = (writes.get(projectId) ?? Promise.resolve()).then(async () => {
        const ledger = await read(projectId);
        if (expectedRevision !== undefined && expectedRevision !== ledger.revision) {
          throw new RevisionConflictError(expectedRevision, ledger.revision);
        }
        const value = change(ledger);
        ledger.revision++;
        await writeJsonFileAtomic(file(projectId), ledger);
        return value;
      });
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      writes.set(projectId, tail);
      try {
        return await result;
      } finally {
        if (writes.get(projectId) === tail) writes.delete(projectId);
      }
    },
  };
}
