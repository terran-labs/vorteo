import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  HealthDismissalRequestSchema,
  HealthDismissalSchema,
  type HealthDismissal,
  type HealthDismissalQueue,
  type HealthDismissals,
} from "@getpaseo/protocol/health-dismissals";
import { writePrivateFileAtomic } from "../private-files.js";

/**
 * The owner's dismissals of failed maintenance records. System Health stops counting a dismissed
 * failure; the record itself stays in its journal and in its card's history. Only the owner
 * session reaches the dismissal route (front-door.ts lists it as owner-only), so an agent can
 * never clear a failure from the owner's Health list.
 */

/** Oldest dismissals drop first; their records have long left every queue's retention. */
const MAX_RETAINED = 512;
const FILE_NAME = "health-dismissals.json";

const StoreSchema = z.strictObject({
  version: z.literal(1),
  dismissals: z.array(z.unknown()),
});

export class HealthDismissalError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** Finds a record by queue and id, or undefined when the coordinator holds no such record. */
export type HealthRecordLookup = (
  queue: HealthDismissalQueue,
  id: string,
) => { status: string } | undefined;

interface StoreOptions {
  lookup: HealthRecordLookup;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** Unreadable entries are dropped, not fatal: the worst case is a failure counting again. */
function readDismissals(text: string): HealthDismissal[] {
  return StoreSchema.parse(JSON.parse(text)).dismissals.flatMap((entry) => {
    const parsed = HealthDismissalSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export class HealthDismissalStore {
  /** Writes run one at a time, in the order dismissals arrive. */
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private dismissals: HealthDismissal[],
    private readonly options: Required<StoreOptions>,
  ) {}

  /** Reads the store, setting aside an unreadable one so the coordinator still starts. */
  static async open(directory: string, options: StoreOptions): Promise<HealthDismissalStore> {
    const resolved = { now: () => new Date(), warn: () => {}, ...options };
    const file = path.join(directory, FILE_NAME);
    let dismissals: HealthDismissal[] = [];
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (text !== null) {
      try {
        dismissals = readDismissals(text);
      } catch {
        const kept = `${file}.unreadable-${resolved.now().getTime()}`;
        await rename(file, kept).then(
          () => resolved.warn(`Health dismissal store was unreadable; moved to ${kept}`),
          () => resolved.warn("Health dismissal store was unreadable and could not be moved aside"),
        );
      }
    }
    return new HealthDismissalStore(file, dismissals, resolved);
  }

  list(): HealthDismissals {
    return { dismissals: structuredClone(this.dismissals) };
  }

  /** Dismisses one failed record. Repeating a dismissal changes nothing. */
  async dismiss(input: unknown): Promise<HealthDismissals> {
    const request = HealthDismissalRequestSchema.parse(input);
    const record = this.options.lookup(request.queue, request.id);
    if (!record) throw new HealthDismissalError("Unknown maintenance record", 404);
    if (record.status !== "failed")
      throw new HealthDismissalError(
        `Only a failed record can be dismissed; this one is ${record.status}`,
      );
    const known = this.dismissals.some(
      (entry) => entry.queue === request.queue && entry.id === request.id,
    );
    if (!known) {
      this.dismissals = [
        ...this.dismissals,
        { ...request, dismissedAt: this.options.now().toISOString() },
      ].slice(-MAX_RETAINED);
      const snapshot = `${JSON.stringify({ version: 1, dismissals: this.dismissals }, null, 2)}\n`;
      const write = this.writing.then(() => writePrivateFileAtomic(this.file, snapshot));
      // A failed write must not wedge later ones; the caller still sees this one fail.
      this.writing = write.catch(() => {});
      await write;
    }
    return this.list();
  }
}
