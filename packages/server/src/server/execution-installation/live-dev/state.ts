import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LiveDevChangeSchema,
  LiveDevModeSchema,
  type LiveDevMode,
} from "@getpaseo/protocol/live-dev";

/**
 * The owner's delivery mode lives in protected coordinator state, not configuration, so it can
 * change without a restart. A missing file is Reliable; an unreadable one is refused rather
 * than read as Live, because live mode widens what reaches the owner's browser.
 */
const StoredLiveDevSchema = z.strictObject({
  version: z.literal(1),
  mode: LiveDevModeSchema,
  changedAt: z.string().datetime(),
});

export interface LiveDevModeRecord {
  mode: LiveDevMode;
  revision: string;
  changedAt: string | null;
}

export class LiveDevStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveDevStateError";
  }
}

const NO_RECORD_REVISION = "none";
/** Reported for a record that cannot be read; only a change to Reliable may use it. */
export const UNREADABLE_REVISION = "unreadable";

function stateFile(stateDir: string): string {
  return path.join(stateDir, "live-dev.json");
}

export async function readLiveDevMode(stateDir: string): Promise<LiveDevModeRecord> {
  let text: string;
  try {
    text = await readFile(stateFile(stateDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        mode: "reliable",
        revision: NO_RECORD_REVISION,
        changedAt: null,
      };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LiveDevStateError("The live dev mode record is unreadable.");
  }
  const parsed = StoredLiveDevSchema.safeParse(value);
  if (!parsed.success) throw new LiveDevStateError("The live dev mode record is unreadable.");
  return {
    mode: parsed.data.mode,
    revision: createHash("sha256").update(text).digest("hex"),
    changedAt: parsed.data.changedAt,
  };
}

/** Called only from the owner-authenticated route. A stale revision is refused. */
export async function changeLiveDevMode(
  stateDir: string,
  input: unknown,
  now: () => Date = () => new Date(),
): Promise<LiveDevModeRecord> {
  const change = LiveDevChangeSchema.parse(input);
  let current: LiveDevModeRecord;
  try {
    current = await readLiveDevMode(stateDir);
  } catch (error) {
    // The owner can always repair an unreadable record by choosing Reliable.
    if (!(error instanceof LiveDevStateError) || change.mode !== "reliable") throw error;
    current = { mode: "live", revision: UNREADABLE_REVISION, changedAt: null };
  }
  if (change.expectedRevision !== current.revision)
    throw new LiveDevStateError("Delivery mode changed elsewhere. Refresh before saving.");
  if (change.mode === current.mode) return current;
  const file = stateFile(stateDir);
  const temporary = path.join(stateDir, `.live-dev.json.${process.pid}.${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        mode: change.mode,
        changedAt: now().toISOString(),
      }),
      { mode: 0o600 },
    );
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return readLiveDevMode(stateDir);
}
