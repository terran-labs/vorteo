import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityLog } from "./types.js";

type ActivityEntry = Awaited<ReturnType<ActivityLog["append"]>>;

const rotationSize = 10_000;

async function readEntries(path: string): Promise<ActivityEntry[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActivityEntry);
}

/** Open once per project in the daemon. Readers see one consistent pair of log generations. */
export function createActivityLog(
  paseoHome: string,
  projectId: string,
  now: () => Date = () => new Date(),
): ActivityLog {
  if (!/^[\w.-]+$/.test(projectId)) throw new Error("Invalid Factory project ID.");
  const directory = join(paseoHome, "factory", "lean");
  const path = join(directory, `${projectId}-activity.jsonl`);
  const previous = `${path}.1`;
  let tail = Promise.resolve();
  let lines: number | undefined;

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(action);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    append(entry) {
      return serialize(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        lines ??= (await readEntries(path)).length;
        if (lines >= rotationSize) {
          await rename(path, previous);
          lines = 0;
        }
        const stored = { ...entry, id: randomUUID(), at: now().toISOString() };
        await appendFile(path, JSON.stringify(stored) + "\n", { mode: 0o600 });
        lines++;
        return stored;
      });
    },
    list({ before, limit = 50 }) {
      return serialize(async () => {
        const entries = [
          ...(await readEntries(previous)),
          ...(await readEntries(path)),
        ].toReversed();
        const cursor =
          before === undefined ? -1 : entries.findIndex((entry) => entry.id === before);
        if (before !== undefined && cursor === -1) return { entries: [], nextBefore: null };
        const page = entries.slice(cursor + 1, cursor + 1 + limit);
        const nextBefore =
          cursor + 1 + page.length < entries.length ? (page.at(-1)?.id ?? null) : null;
        return { entries: page, nextBefore };
      });
    },
  };
}
