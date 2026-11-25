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
) => { status: string; stage?: string } | undefined;

interface StoreOptions {
  lookup: HealthRecordLookup;
  now?: () => Date;
  warn?: (message: string) => void;
  /** Saves the store atomically; tests replace it to make one write fail. */
  write?: (file: string, data: string) => Promise<void>;
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

  /**
   * Reads the store. It never rejects: the file is optional, so a missing, unreadable or damaged
   * one starts empty, meaning nothing is dismissed, and the coordinator still starts. A damaged
   * file is set aside for inspection.
   */
  static async open(directory: string, options: StoreOptions): Promise<HealthDismissalStore> {
    const resolved = {
      now: () => new Date(),
      warn: () => {},
      write: writePrivateFileAtomic,
      ...options,
    };
    const file = path.join(directory, FILE_NAME);
    let dismissals: HealthDismissal[] = [];
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT")
        resolved.warn(
          `Health dismissal store could not be read (${error.code ?? "error"}); starting empty`,
        );
      return null;
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

  /** Saves the current list; a failed save takes `entry` back out, since it was not kept. */
  private async save(entry: HealthDismissal): Promise<void> {
    try {
      await this.options.write(this.file, this.serialize());
    } catch (error) {
      // Unsaved, so not dismissed: the list must match what a restart would read.
      this.dismissals = this.dismissals.filter((item) => item !== entry);
      throw error;
    }
  }

  private serialize(): string {
    return `${JSON.stringify({ version: 1, dismissals: this.dismissals }, null, 2)}\n`;
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
    // A record that needs recovery still has work for the owner; it is recovered, not dismissed.
    if (record.stage === "recovery_required")
      throw new HealthDismissalError("This record needs recovery, so it cannot be dismissed");
    const known = this.dismissals.some(
      (entry) => entry.queue === request.queue && entry.id === request.id,
    );
    if (!known) {
      const entry = { ...request, dismissedAt: this.options.now().toISOString() };
      this.dismissals = [...this.dismissals, entry].slice(-MAX_RETAINED);
      // Each write serializes the list as it is when the write runs, after earlier writes have
      // settled, so a dismissal whose own write failed never rides along in a later one.
      const write = this.writing.then(() => this.save(entry));
      // A failed write must not wedge later ones; the caller still sees this one fail.
      this.writing = write.catch(() => {});
      await write;
    }
    return this.list();
  }
}
