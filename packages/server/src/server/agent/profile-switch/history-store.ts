import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "pino";
import { z } from "zod";
import { SwitchHistoryEventSchema, type SwitchHistoryEvent } from "./history.js";

/**
 * Retained switch history is stored as one segment per switch. A segment holds only the
 * rows its switch added after the previous switch's marker, ends with its own marker, and
 * names the previous switch, so the full history is the chain read oldest first.
 *
 * Segments are newline-delimited JSON: a header line, then one event per line. Reads and
 * writes stream line by line, so no history is ever built as one string. The legacy format,
 * one pretty-printed JSON document per switch repeating all earlier history, is migrated
 * lazily on first read; see migrateLegacySwitchHistory.
 */
const SEGMENT_FORMAT = "vorteo-switch-segment";
const SEGMENT_SUFFIX = ".segment.jsonl";
const LEGACY_SUFFIX = ".json";
const WRITE_CHUNK_CHARS = 1024 * 1024;

const SegmentHeaderSchema = z.object({
  format: z.literal(SEGMENT_FORMAT),
  version: z.literal(1),
  previousSwitchId: z.string().nullable(),
});
type SegmentHeader = z.infer<typeof SegmentHeaderSchema>;

export class SwitchHistoryTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Switch history exceeds ${Math.round(maxBytes / (1024 * 1024))} MB`);
    this.name = "SwitchHistoryTooLargeError";
  }
}

export interface SwitchSegmentInput {
  switchId: string;
  previousSwitchId: string | null;
  events: Iterable<SwitchHistoryEvent>;
  /** Refuse the write, leaving nothing behind, once the segment exceeds this many bytes. */
  maxBytes?: number;
}

export interface SwitchHistoryReadOptions {
  /**
   * Replay at most this many bytes, taken from the newest end of the chain. Older events
   * stay on disk. The newest event, the latest switch marker, is always replayed.
   */
  maxBytes?: number;
}

export interface SwitchHistoryStoreOptions {
  directory: (agentId: string) => string;
  logger: Logger;
}

interface ChainSegment {
  switchId: string;
  file: string;
  bytes: number;
}

export interface SwitchHistoryChainStatus {
  /** Switch ids with a segment in the chain, oldest first. */
  switchIds: string[];
  /**
   * True only when the chain reaches its first segment without a gap and holds a segment for
   * every switch the thread's record lists. Legacy snapshots can lack earlier history, so a
   * migrated chain can be shorter than the record.
   */
  complete: boolean;
}

export class SwitchHistoryStore {
  private readonly migrations = new Map<string, Promise<boolean>>();
  /** A failed migration is not retried while this process runs; each retry rereads the file. */
  private readonly failedMigrations = new Set<string>();

  constructor(private readonly options: SwitchHistoryStoreOptions) {}

  /** Written before the switch commits; an orphan from a failed switch is never read. */
  async writeSegment(agentId: string, input: SwitchSegmentInput): Promise<void> {
    const header: SegmentHeader = {
      format: SEGMENT_FORMAT,
      version: 1,
      previousSwitchId: input.previousSwitchId,
    };
    await writeSegmentFile(
      this.segmentPath(agentId, input.switchId),
      header,
      input.events,
      input.maxBytes,
    );
  }

  /**
   * Streams retained history ending at `switchId`, oldest first. Returns null when the
   * segment and any legacy snapshot are both absent.
   */
  async read(
    agentId: string,
    switchId: string,
    options: SwitchHistoryReadOptions = {},
  ): Promise<AsyncIterable<SwitchHistoryEvent> | null> {
    if (!(await exists(this.segmentPath(agentId, switchId)))) {
      const migrated = await this.migrate(agentId, switchId);
      if (!migrated) return null;
    }
    const { segments } = await this.resolveChain(agentId, switchId);
    return readChain(segments, options.maxBytes ?? Number.POSITIVE_INFINITY);
  }

  /** Compares the chain ending at the record's latest switch with every switch it lists. */
  async inspectChain(
    agentId: string,
    recordSwitchIds: readonly string[],
  ): Promise<SwitchHistoryChainStatus> {
    const latest = recordSwitchIds.at(-1);
    if (latest === undefined) return { switchIds: [], complete: true };
    if (!(await exists(this.segmentPath(agentId, latest))))
      return { switchIds: [], complete: false };
    const { segments, complete } = await this.resolveChain(agentId, latest);
    const switchIds = segments.map((segment) => segment.switchId);
    const held = new Set(switchIds);
    return { switchIds, complete: complete && recordSwitchIds.every((id) => held.has(id)) };
  }

  /**
   * After a switch commits, removes orphaned segments from switches that never committed.
   * Runs only when the chain is complete against the record. Legacy snapshots are never
   * removed: an older snapshot can hold history that no newer snapshot or segment repeats.
   */
  async pruneUnreferenced(agentId: string, recordSwitchIds: readonly string[]): Promise<void> {
    const status = await this.inspectChain(agentId, recordSwitchIds);
    if (!status.complete) return;
    const keep = new Set(
      status.switchIds.map((id) => `${encodeURIComponent(id)}${SEGMENT_SUFFIX}`),
    );
    const dir = this.options.directory(agentId);
    for (const name of await fs.readdir(dir)) {
      if (keep.has(name) || !name.endsWith(SEGMENT_SUFFIX)) continue;
      await fs.rm(path.join(dir, name), { force: true });
    }
  }

  private migrate(agentId: string, switchId: string): Promise<boolean> {
    const key = `${agentId}\0${switchId}`;
    if (this.failedMigrations.has(key)) return Promise.resolve(false);
    let migration = this.migrations.get(key);
    if (!migration) {
      migration = migrateLegacySwitchHistory({
        directory: this.options.directory(agentId),
        switchId,
        segmentPath: (id) => this.segmentPath(agentId, id),
        legacyPath: (id) => this.legacyPath(agentId, id),
      })
        .then((result) => {
          if (result.status === "migrated")
            this.options.logger.info(
              { agentId, segments: result.segments, events: result.events },
              "Migrated retained switch history to segments",
            );
          return result.status === "migrated";
        })
        .catch((error: unknown) => {
          // The legacy snapshot stays in place. Reading it whole is what exhausted the heap,
          // so the thread loads with its switch marker only until the daemon restarts.
          this.failedMigrations.add(key);
          this.options.logger.error(
            { err: error, agentId },
            "Retained switch history could not be migrated; original files kept",
          );
          return false;
        })
        .finally(() => this.migrations.delete(key));
      this.migrations.set(key, migration);
    }
    return migration;
  }

  private async resolveChain(
    agentId: string,
    switchId: string,
  ): Promise<{ segments: ChainSegment[]; complete: boolean }> {
    const chain: ChainSegment[] = [];
    const seen = new Set<string>();
    let next: string | null = switchId;
    while (next !== null && !seen.has(next)) {
      seen.add(next);
      const file = this.segmentPath(agentId, next);
      let header: SegmentHeader;
      let bytes: number;
      try {
        [header, bytes] = await Promise.all([readHeader(file), fs.stat(file).then((s) => s.size)]);
      } catch (error) {
        // The newest segment was checked by the caller. A missing earlier segment ends the
        // chain: the thread keeps what remains instead of failing to load.
        if (chain.length > 0 && (error as NodeJS.ErrnoException).code === "ENOENT") {
          this.options.logger.warn({ agentId }, "An earlier switch history segment is missing");
          return { segments: chain, complete: false };
        }
        throw error;
      }
      chain.unshift({ switchId: next, file, bytes });
      next = header.previousSwitchId;
    }
    return { segments: chain, complete: next === null };
  }

  private segmentPath(agentId: string, switchId: string): string {
    return path.join(
      this.options.directory(agentId),
      `${encodeURIComponent(switchId)}${SEGMENT_SUFFIX}`,
    );
  }

  private legacyPath(agentId: string, switchId: string): string {
    return path.join(
      this.options.directory(agentId),
      `${encodeURIComponent(switchId)}${LEGACY_SUFFIX}`,
    );
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function tempPathFor(file: string): string {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
}

/** Streams lines to a temporary file and renames it into place, so readers never see a partial segment. */
class SegmentWriter {
  private readonly temp: string;
  private readonly digest = createHash("sha256");
  private buffer = "";
  private bytes = 0;
  events = 0;

  private constructor(
    private readonly file: string,
    private readonly handle: fs.FileHandle,
    private readonly maxBytes: number,
    temp: string,
  ) {
    this.temp = temp;
  }

  static async open(
    file: string,
    header: SegmentHeader,
    maxBytes = Number.POSITIVE_INFINITY,
  ): Promise<SegmentWriter> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = tempPathFor(file);
    const writer = new SegmentWriter(file, await fs.open(temp, "w"), maxBytes, temp);
    writer.buffer = `${JSON.stringify(header)}\n`;
    return writer;
  }

  async append(event: SwitchHistoryEvent): Promise<void> {
    const line = JSON.stringify(event);
    this.bytes += Buffer.byteLength(line, "utf8") + 1;
    if (this.bytes > this.maxBytes) throw new SwitchHistoryTooLargeError(this.maxBytes);
    this.digest.update(line);
    this.buffer += `${line}\n`;
    this.events += 1;
    if (this.buffer.length >= WRITE_CHUNK_CHARS) await this.flush();
  }

  async finish(): Promise<{ events: number; digest: string }> {
    await this.flush();
    await this.handle.sync();
    await this.handle.close();
    await fs.rename(this.temp, this.file);
    return { events: this.events, digest: this.digest.digest("hex") };
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await fs.rm(this.temp, { force: true });
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return;
    const chunk = this.buffer;
    this.buffer = "";
    await this.handle.write(chunk, null, "utf8");
  }
}

async function writeSegmentFile(
  file: string,
  header: SegmentHeader,
  events: Iterable<SwitchHistoryEvent>,
  maxBytes?: number,
): Promise<void> {
  const writer = await SegmentWriter.open(file, header, maxBytes);
  try {
    for (const event of events) await writer.append(event);
    await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

function lines(file: string): AsyncIterable<string> {
  return createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
}

async function readHeader(file: string): Promise<SegmentHeader> {
  const reader = createInterface({
    input: createReadStream(file, { encoding: "utf8", highWaterMark: 4096 }),
  });
  try {
    for await (const line of reader) return SegmentHeaderSchema.parse(JSON.parse(line));
  } finally {
    reader.close();
  }
  throw new Error(`Switch history segment ${file} is empty`);
}

async function* readSegmentEvents(file: string): AsyncGenerator<{
  event: SwitchHistoryEvent;
  bytes: number;
}> {
  let headerRead = false;
  for await (const line of lines(file)) {
    if (!headerRead) {
      headerRead = true;
      continue;
    }
    if (!line) continue;
    yield {
      event: SwitchHistoryEventSchema.parse(JSON.parse(line)),
      bytes: Buffer.byteLength(line, "utf8") + 1,
    };
  }
}

async function* readChain(
  chain: readonly ChainSegment[],
  maxBytes: number,
): AsyncGenerator<SwitchHistoryEvent> {
  // File sizes bound how much of the chain fits; header lines make this slightly conservative.
  let skipBytes = Math.max(
    0,
    chain.reduce((total, segment) => total + segment.bytes, 0) - maxBytes,
  );
  const last = chain.length - 1;
  for (const [index, segment] of chain.entries()) {
    if (skipBytes >= segment.bytes && index < last) {
      skipBytes -= segment.bytes;
      continue;
    }
    let pending: SwitchHistoryEvent | null = null;
    for await (const { event, bytes } of readSegmentEvents(segment.file)) {
      if (skipBytes > 0) {
        skipBytes -= bytes;
        // Hold the newest skipped event so the latest marker survives any budget.
        pending = index === last ? event : null;
        continue;
      }
      pending = null;
      yield event;
    }
    if (pending) yield pending;
  }
}

/* ---------------------------------------------------------------------------------------- */
/* Legacy migration                                                                          */
/* ---------------------------------------------------------------------------------------- */

interface LegacyMigrationInput {
  directory: string;
  switchId: string;
  segmentPath: (switchId: string) => string;
  legacyPath: (switchId: string) => string;
}

type LegacyMigrationResult =
  | { status: "absent" }
  | { status: "migrated"; segments: number; events: number };

interface StagedSegment {
  file: string;
  events: number;
  digest: string;
}

/**
 * Rebuilds segments from the latest switch's legacy snapshot. That snapshot is what older
 * daemons replay: the history before each earlier marker it holds, each marker ending a
 * segment. The snapshot is parsed one array element at a time and each segment is written as
 * its events arrive. Segments are verified by rereading them before they become visible; on
 * failure the staged segments are removed and every original file stays.
 *
 * Migration never deletes a legacy snapshot. An older snapshot can hold history the newest
 * lacks, when a thread once loaded with only its switch marker; that history stays on disk,
 * unreplayed, exactly as older daemons left it. A marker whose segment already exists, from
 * before a rollback, is never overwritten: the new segments chain onto it.
 */
export async function migrateLegacySwitchHistory(
  input: LegacyMigrationInput,
): Promise<LegacyMigrationResult> {
  const legacy = input.legacyPath(input.switchId);
  if (!(await exists(legacy))) return { status: "absent" };

  await removeStaleStagingFiles(input.directory);
  const staging = new LegacySegmentStaging(input);
  try {
    await staging.stage(legacy);
    for (const [switchId, segment] of staging.staged) await verifyStagedSegment(switchId, segment);
    // Map order is chain order, so the newest segment, whose presence marks completion, is last.
    for (const [switchId, segment] of staging.staged) {
      const file = input.segmentPath(switchId);
      if (await exists(file)) throw new Error("A switch history segment appeared during migration");
      await fs.rename(segment.file, file);
    }
  } catch (error) {
    await staging.discard();
    throw error;
  }

  let events = 0;
  for (const segment of staging.staged.values()) events += segment.events;
  return { status: "migrated", segments: staging.staged.size, events };
}

/**
 * A crashed migration or write leaves staging and temporary files. This process's own
 * temporary files may belong to a write in progress; older processes' cannot.
 */
async function removeStaleStagingFiles(directory: string): Promise<void> {
  for (const name of await fs.readdir(directory)) {
    const staged = name.endsWith(`${SEGMENT_SUFFIX}.migrating`);
    const temporary = name.startsWith(".") && name.endsWith(".tmp");
    if (!staged && !(temporary && !name.includes(`.${process.pid}.`))) continue;
    await fs.rm(path.join(directory, name), { force: true });
  }
}

/** Splits a legacy snapshot into staged segments, one per switch marker. */
class LegacySegmentStaging {
  readonly staged = new Map<string, StagedSegment>();
  private writer: SegmentWriter | null = null;
  private previous: string | null = null;

  constructor(private readonly input: LegacyMigrationInput) {}

  async stage(legacy: string): Promise<void> {
    let documentSwitchId: string | null = null;
    const elements = streamLegacySnapshot(legacy, (skeleton) => {
      documentSwitchId = z.object({ switchId: z.string() }).parse(skeleton).switchId;
    });
    for await (const element of elements)
      await this.append(SwitchHistoryEventSchema.parse(element));
    if (documentSwitchId !== this.input.switchId)
      throw new Error("Legacy switch history names a different switch");
    if (this.writer !== null || this.previous !== this.input.switchId)
      throw new Error("Legacy switch history does not end with its own switch marker");
  }

  async discard(): Promise<void> {
    await this.writer?.abort();
    await fs.rm(this.path("pending"), { force: true });
    for (const segment of this.staged.values()) await fs.rm(segment.file, { force: true });
  }

  private async append(event: SwitchHistoryEvent): Promise<void> {
    this.writer ??= await SegmentWriter.open(this.path("pending"), {
      format: SEGMENT_FORMAT,
      version: 1,
      previousSwitchId: this.previous,
    });
    await this.writer.append(event);
    if (event.item.type !== "profile_switch" || this.staged.has(event.item.switchId)) return;
    // A segment is named for its switch, known only once its closing marker arrives.
    const switchId = event.item.switchId;
    if (await exists(this.input.segmentPath(switchId))) {
      // Written before a rollback. It already holds this history; continue after it.
      await this.writer.abort();
      this.writer = null;
      for (const segment of this.staged.values()) await fs.rm(segment.file, { force: true });
      this.staged.clear();
      this.previous = switchId;
      return;
    }
    const result = await this.writer.finish();
    this.writer = null;
    const file = this.path(switchId);
    await fs.rename(this.path("pending"), file);
    this.staged.set(switchId, { file, ...result });
    this.previous = switchId;
  }

  private path(switchId: string): string {
    return `${this.input.segmentPath(switchId)}.migrating`;
  }
}

/** Rereads a staged segment and checks it against what was written. */
async function verifyStagedSegment(switchId: string, segment: StagedSegment): Promise<void> {
  const digest = createHash("sha256");
  let count = 0;
  let last: SwitchHistoryEvent | null = null;
  for await (const { event } of readSegmentEvents(segment.file)) {
    digest.update(JSON.stringify(event));
    count += 1;
    last = event;
  }
  const closesSwitch = last?.item.type === "profile_switch" && last.item.switchId === switchId;
  if (!closesSwitch || count !== segment.events || digest.digest("hex") !== segment.digest)
    throw new Error("Migrated switch history failed verification");
}

/**
 * Streams the elements of the top-level `events` array of a legacy snapshot without parsing
 * the document whole. Each element is parsed on its own, so memory holds one event at a time.
 * Everything outside that array forms a small skeleton document passed to `onSkeleton`.
 */
async function* streamLegacySnapshot(
  file: string,
  onSkeleton: (skeleton: unknown) => void,
): AsyncGenerator<unknown> {
  const decoder = new StringDecoder("utf8");
  const scanner = new LegacySnapshotScanner();
  for await (const raw of createReadStream(file) as AsyncIterable<Buffer>) {
    yield* scanner.scan(decoder.write(raw));
  }
  yield* scanner.scan(decoder.end());
  onSkeleton(scanner.finish());
}

/** A JSON tokenizer that tracks only nesting and strings, which is all element boundaries need. */
class LegacySnapshotScanner {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private inEvents = false;
  private skeleton = "";
  private parts: string[] = [];
  private start = -1;
  private elements: unknown[] = [];

  /** Returns the events completed within this chunk. */
  scan(chunk: string): unknown[] {
    this.elements = [];
    if (this.start >= 0) this.start = 0;
    for (let i = 0; i < chunk.length; i += 1) this.step(chunk, i);
    if (this.start >= 0) this.parts.push(chunk.slice(this.start));
    return this.elements;
  }

  finish(): unknown {
    if (this.depth !== 0 || this.inString) throw new Error("Legacy switch history is truncated");
    return JSON.parse(this.skeleton);
  }

  private get inElement(): boolean {
    return this.inEvents && this.depth >= 3;
  }

  private get betweenElements(): boolean {
    return this.inEvents && this.depth === 2;
  }

  private step(chunk: string, i: number): void {
    const ch = chunk[i];
    if (this.inString) return this.stringChar(ch);
    if (ch === "{" || ch === "[") return this.open(ch, i);
    if (ch === "}" || ch === "]") return this.close(chunk, ch, i);
    if (this.betweenElements) {
      if (ch !== "," && ch.trim() !== "") throw malformed();
      return;
    }
    if (ch === '"') this.inString = true;
    if (!this.inElement) this.skeleton += ch;
  }

  private stringChar(ch: string): void {
    if (this.escaped) this.escaped = false;
    else if (ch === "\\") this.escaped = true;
    else if (ch === '"') this.inString = false;
    if (!this.inElement) this.skeleton += ch;
  }

  private open(ch: string, i: number): void {
    if (this.betweenElements) {
      if (ch !== "{") throw malformed();
      this.start = i;
    } else if (!this.inElement) {
      this.skeleton += ch;
      if (this.depth === 1 && ch === "[" && /"events"\s*:\s*\[$/.test(this.skeleton))
        this.inEvents = true;
    }
    this.depth += 1;
  }

  private close(chunk: string, ch: string, i: number): void {
    this.depth -= 1;
    if (this.betweenElements) {
      this.parts.push(chunk.slice(this.start, i + 1));
      this.elements.push(JSON.parse(this.parts.join("")));
      this.parts = [];
      this.start = -1;
      return;
    }
    if (this.inEvents && this.depth === 1) this.inEvents = false;
    if (!this.inEvents) this.skeleton += ch;
  }
}

function malformed(): Error {
  return new Error("Legacy switch history has a malformed event");
}
