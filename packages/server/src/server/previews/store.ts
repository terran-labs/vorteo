import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PreviewGallerySchema,
  PreviewVariantSetSchema,
  PreviewVersionSchema,
  type PreviewAnnotation,
  type PreviewGallery,
  type PreviewKind,
  type PreviewSelection,
  type PreviewVariantSet,
  type PreviewVersion,
  type PublishPreviewInput,
} from "@getpaseo/protocol/previews";
import { z } from "zod";

/** A snapshot larger than this is refused rather than silently truncated. */
export const MAX_SNAPSHOT_BYTES = 300 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 10_000;
/** How long one snapshot copy may run before it is stopped. */
const COPY_DEADLINE_MS = 60_000;
/** Unprotected versions kept per artifact before the oldest are pruned. */
export const KEEP_UNRATED_PER_LINEAGE = 8;
const MAX_REVIEW_KEYS = 20;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);

const IndexSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  versions: z.array(PreviewVersionSchema),
  variantSets: z.array(PreviewVariantSetSchema),
  /** SHA-256 of each paired browser's review key. The keys themselves are never stored. */
  reviewKeys: z.array(z.object({ hash: z.string(), createdAt: z.string() })).default([]),
  /** The daemon's address as the owner's browser reaches it, learned at pairing. */
  reviewOrigin: z.string().optional(),
});
type Index = z.infer<typeof IndexSchema>;

export class PreviewError extends Error {
  constructor(
    public readonly code: "invalid" | "not_found" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "PreviewError";
  }
}

export interface PreviewAuthor {
  agentId: string;
  agentTitle?: string;
  workspaceId?: string;
}

function emptyIndex(): Index {
  return { version: 1, revision: 0, versions: [], variantSets: [], reviewKeys: [] };
}

function newVersionId(): string {
  return randomBytes(18).toString("base64url");
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Resolve a URL path inside a snapshot directory. Returns null for anything that could
 * leave it. Snapshots never contain symlinks, so a lexical check is sufficient; the
 * caller still opens the file without following links.
 */
export function resolveSnapshotPath(filesRoot: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const resolved = path.resolve(filesRoot, ...segments);
  if (resolved !== filesRoot && !resolved.startsWith(filesRoot + path.sep)) return null;
  return resolved;
}

/** A version the retention sweep must never delete. */
function isProtected(version: PreviewVersion, index: Index): boolean {
  if (version.rating !== null || version.approved || version.annotations.length > 0) return true;
  // Options in a variant set stay comparable until the owner has picked, and the winner stays.
  const set = index.variantSets.find((candidate) => candidate.id === version.variantSetId);
  if (set && (set.winnerVersionId === null || set.winnerVersionId === version.id)) return true;
  return false;
}

/** Version ids the retention rule removes: old unprotected versions beyond the kept count. */
export function selectPrunable(index: Pick<Index, "versions" | "variantSets">): string[] {
  const full = { ...emptyIndex(), ...index };
  const byLineage = new Map<string, PreviewVersion[]>();
  for (const version of full.versions) {
    const list = byLineage.get(version.lineage) ?? [];
    list.push(version);
    byLineage.set(version.lineage, list);
  }
  const prunable: string[] = [];
  for (const versions of byLineage.values()) {
    const newestFirst = [...versions].sort((a, b) => b.number - a.number);
    // The newest version is what the gallery shows, so it always stays.
    const candidates = newestFirst.slice(1).filter((version) => !isProtected(version, full));
    prunable.push(...candidates.slice(KEEP_UNRATED_PER_LINEAGE - 1).map((version) => version.id));
  }
  return prunable;
}

export class PreviewStore {
  private index: Index | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  /** One-time pairing tickets. In memory on purpose: a restart simply expires them. */
  private readonly tickets = new Map<string, number>();

  constructor(private readonly root: string) {}

  private indexPath(): string {
    return path.join(this.root, "index.json");
  }

  versionDir(versionId: string): string {
    return path.join(this.root, "versions", versionId);
  }

  filesDir(versionId: string): string {
    return path.join(this.versionDir(versionId), "files");
  }

  thumbnailPath(versionId: string): string {
    return path.join(this.versionDir(versionId), "thumbnail.png");
  }

  private async load(): Promise<Index> {
    if (this.index) return this.index;
    try {
      this.index = IndexSchema.parse(JSON.parse(await fs.readFile(this.indexPath(), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.index = emptyIndex();
    }
    return this.index;
  }

  private async save(index: Index): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath()}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(index), { mode: 0o600 });
    await fs.rename(temporary, this.indexPath());
  }

  /** Mutations run one at a time; the index is written before the next one starts. */
  private mutate<T>(change: (index: Index) => Promise<T> | T): Promise<T> {
    const run = this.tail.then(async () => {
      const index = await this.load();
      const result = await change(index);
      index.revision += 1;
      await this.save(index);
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async gallery(): Promise<PreviewGallery> {
    await this.tail;
    const index = await this.load();
    return PreviewGallerySchema.parse(
      structuredClone({
        revision: index.revision,
        versions: index.versions,
        variantSets: index.variantSets,
      }),
    );
  }

  async getVersion(versionId: string): Promise<PreviewVersion | null> {
    const gallery = await this.gallery();
    // The id is the capability for snapshot and viewer links.
    return gallery.versions.find((version) => sameId(version.id, versionId)) ?? null;
  }

  /** The newest live version whose page is served from this origin. */
  async findLiveVersionByOrigin(origin: string): Promise<PreviewVersion | null> {
    const gallery = await this.gallery();
    const matches = gallery.versions.filter((version) => {
      if (!version.liveUrl) return false;
      try {
        return new URL(version.liveUrl).origin === origin;
      } catch {
        return false;
      }
    });
    return matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async publish(input: PublishPreviewInput, author: PreviewAuthor): Promise<PreviewVersion> {
    const id = newVersionId();
    const frozen = await this.freeze(id, input);
    try {
      return await this.mutate(async (index) => {
        const number =
          index.versions
            .filter((version) => version.lineage === input.lineage)
            .reduce((highest, version) => Math.max(highest, version.number), 0) + 1;
        const variantSetId = input.variantSet
          ? `${input.lineage}:${input.variantSet.key}`
          : undefined;
        const version: PreviewVersion = {
          id,
          lineage: input.lineage,
          number,
          title: input.title,
          kind: input.kind,
          createdAt: new Date().toISOString(),
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
          agentId: author.agentId,
          ...(author.agentTitle ? { agentTitle: author.agentTitle.slice(0, 200) } : {}),
          ...(author.workspaceId ? { workspaceId: author.workspaceId } : {}),
          ...frozen,
          hasThumbnail: false,
          ...(variantSetId ? { variantSetId, variantLabel: input.variantSet!.label } : {}),
          rating: null,
          approved: false,
          annotations: [],
        };
        index.versions.push(version);
        if (variantSetId) {
          const existing = index.variantSets.find((set) => set.id === variantSetId);
          if (existing) existing.versionIds.push(id);
          else
            index.variantSets.push({
              id: variantSetId,
              title: input.variantSet!.title ?? input.title,
              versionIds: [id],
              winnerVersionId: null,
              reason: null,
              pickedAt: null,
            });
        }
        await this.prune(index);
        return structuredClone(version);
      });
    } catch (error) {
      await fs.rm(this.versionDir(id), { recursive: true, force: true });
      throw error;
    }
  }

  /** Copy the published files so later edits by the agent cannot change what was rated. */
  private async freeze(
    id: string,
    input: PublishPreviewInput,
  ): Promise<Pick<PreviewVersion, "entry" | "liveUrl" | "sizeBytes">> {
    if (input.kind === "url") {
      let url: URL;
      try {
        url = new URL(input.url ?? "");
      } catch {
        throw new PreviewError("invalid", "kind url needs a complete https link in url.");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new PreviewError("invalid", "Only http and https preview links can be published.");
      return { liveUrl: url.toString(), sizeBytes: 0 };
    }
    if (!input.path || !path.isAbsolute(input.path))
      throw new PreviewError("invalid", "path must be an absolute file or directory path.");
    const source = path.resolve(input.path);
    const destination = this.filesDir(id);
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    try {
      // The copy runs in its own process; see snapshot-copy-worker for why.
      const copied = await copySnapshot(source, destination);
      const sizeBytes = copied.bytes;
      let entry = copied.entry;
      if (!entry) {
        entry = (input.entry ?? "index.html").replace(/^\/+/, "");
        const resolved = resolveSnapshotPath(destination, entry);
        const entryStat = resolved ? await fs.lstat(resolved).catch(() => null) : null;
        if (!entryStat?.isFile())
          throw new PreviewError("invalid", `Entry file ${entry} was not found in ${source}.`);
      }
      assertKindMatches(input.kind, entry);
      return { entry, sizeBytes };
    } catch (error) {
      await fs.rm(this.versionDir(id), { recursive: true, force: true });
      throw error;
    }
  }

  /** Delete what the retention rule selects. Runs inside a mutation. */
  private async prune(index: Index): Promise<void> {
    const prunable = new Set(selectPrunable(index));
    if (prunable.size === 0) return;
    index.versions = index.versions.filter((version) => !prunable.has(version.id));
    for (const set of index.variantSets)
      set.versionIds = set.versionIds.filter((versionId) => !prunable.has(versionId));
    index.variantSets = index.variantSets.filter((set) => set.versionIds.length > 0);
    for (const id of prunable) await fs.rm(this.versionDir(id), { recursive: true, force: true });
  }

  private requireVersion(index: Index, versionId: string): PreviewVersion {
    const version = index.versions.find((candidate) => candidate.id === versionId);
    if (!version) throw new PreviewError("not_found", "That preview version no longer exists.");
    return version;
  }

  rate(versionId: string, rating: number | null): Promise<void> {
    return this.mutate((index) => {
      this.requireVersion(index, versionId).rating = rating;
    });
  }

  approve(versionId: string, approved: boolean): Promise<void> {
    return this.mutate((index) => {
      this.requireVersion(index, versionId).approved = approved;
    });
  }

  pick(variantSetId: string, winnerVersionId: string | null, reason?: string): Promise<void> {
    return this.mutate((index) => {
      const set = index.variantSets.find((candidate) => candidate.id === variantSetId);
      if (!set) throw new PreviewError("not_found", "That set of options no longer exists.");
      if (winnerVersionId !== null && !set.versionIds.includes(winnerVersionId))
        throw new PreviewError("invalid", "The winner must be one of the options in the set.");
      set.winnerVersionId = winnerVersionId;
      set.reason = winnerVersionId === null ? null : reason?.trim() || null;
      set.pickedAt = winnerVersionId === null ? null : new Date().toISOString();
    });
  }

  remove(versionId: string): Promise<void> {
    return this.mutate(async (index) => {
      this.requireVersion(index, versionId);
      index.versions = index.versions.filter((version) => version.id !== versionId);
      for (const set of index.variantSets) {
        set.versionIds = set.versionIds.filter((id) => id !== versionId);
        if (set.winnerVersionId === versionId) {
          set.winnerVersionId = null;
          set.reason = null;
          set.pickedAt = null;
        }
      }
      index.variantSets = index.variantSets.filter((set) => set.versionIds.length > 0);
      await fs.rm(this.versionDir(versionId), { recursive: true, force: true });
    });
  }

  markThumbnail(versionId: string): Promise<void> {
    return this.mutate((index) => {
      const version = index.versions.find((candidate) => candidate.id === versionId);
      if (version) version.hasThumbnail = true;
    });
  }

  addAnnotation(
    versionId: string,
    input: { comment: string; rating?: number; selection?: PreviewSelection },
  ): Promise<{ version: PreviewVersion; annotation: PreviewAnnotation }> {
    return this.mutate((index) => {
      const version = this.requireVersion(index, versionId);
      const annotation: PreviewAnnotation = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        comment: input.comment,
        ...(input.rating ? { rating: input.rating } : {}),
        ...(input.selection ? { selection: input.selection } : {}),
        delivery: "stored",
      };
      version.annotations.push(annotation);
      if (input.rating) version.rating = input.rating;
      return structuredClone({ version, annotation });
    });
  }

  markAnnotationQueued(versionId: string, annotationId: string): Promise<void> {
    return this.mutate((index) => {
      const annotation = index.versions
        .find((version) => version.id === versionId)
        ?.annotations.find((candidate) => candidate.id === annotationId);
      if (annotation) annotation.delivery = "queued";
    });
  }

  // ---- Browser pairing ---------------------------------------------------------------

  /** A single-use ticket the authenticated interface hands to the owner's browser. */
  mintTicket(now = Date.now()): string {
    for (const [ticket, expires] of this.tickets) if (expires <= now) this.tickets.delete(ticket);
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, now + 2 * 60_000);
    return ticket;
  }

  /** Exchange a ticket for a review key. The ticket is consumed even when it has expired. */
  async redeemTicket(
    ticket: string,
    now = Date.now(),
    reviewOrigin?: string,
  ): Promise<string | null> {
    const expires = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (expires === undefined || expires <= now) return null;
    const key = randomBytes(32).toString("base64url");
    await this.mutate((index) => {
      index.reviewKeys.push({ hash: hashKey(key), createdAt: new Date(now).toISOString() });
      index.reviewKeys = index.reviewKeys.slice(-MAX_REVIEW_KEYS);
      // Only a redeemed ticket, which the owner's client minted, may set this.
      if (reviewOrigin) index.reviewOrigin = reviewOrigin;
    });
    return key;
  }

  /** Where live previews load the review toolbar from. Null until a browser has paired. */
  async reviewOrigin(): Promise<string | null> {
    await this.tail;
    return (await this.load()).reviewOrigin ?? null;
  }

  async isReviewKeyValid(key: string | undefined): Promise<boolean> {
    if (!key || key.length > 200) return false;
    await this.tail;
    const provided = Buffer.from(hashKey(key), "hex");
    let valid = false;
    for (const entry of (await this.load()).reviewKeys) {
      const expected = Buffer.from(entry.hash, "hex");
      // Compare every entry so timing does not reveal which one matched.
      if (expected.length === provided.length && timingSafeEqual(expected, provided)) valid = true;
    }
    return valid;
  }
}

function assertKindMatches(kind: PreviewKind, entry: string): void {
  const extension = path.extname(entry).toLowerCase();
  if (kind === "image" && !IMAGE_EXTENSIONS.has(extension))
    throw new PreviewError("invalid", "kind image needs a png, jpg, gif, webp, avif or svg file.");
  if (kind === "pdf" && extension !== ".pdf")
    throw new PreviewError("invalid", "kind pdf needs a .pdf file.");
  if ((kind === "web" || kind === "deck") && extension !== ".html" && extension !== ".htm")
    throw new PreviewError("invalid", "kind web and deck need an .html entry file.");
}

function parseCopyResult(stdout: string): { bytes: number; entry: string } | null {
  try {
    const result = JSON.parse(stdout) as { bytes?: unknown; entry?: unknown };
    return { bytes: Number(result.bytes) || 0, entry: String(result.entry ?? "") };
  } catch {
    return null;
  }
}

/**
 * Copy a published file or directory into `destination` with the snapshot copy worker,
 * which never follows a link and cannot be redirected by a tree that changes under it.
 * Resolves with the bytes copied and, for a single file, its name.
 */
function copySnapshot(
  source: string,
  destination: string,
): Promise<{ bytes: number; entry: string }> {
  const worker = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "snapshot-copy-worker.mjs",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [worker, source, destination, String(MAX_SNAPSHOT_BYTES), String(MAX_SNAPSHOT_FILES)],
      { stdio: ["ignore", "pipe", "pipe"], env: {} },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf8");
    });
    // A publish must end. Ask the worker to stop at the deadline, then force it.
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, COPY_DEADLINE_MS);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    // "close" fires after the process has gone and its output is drained, so the caller
    // can safely remove the partial snapshot.
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (timedOut) {
        reject(
          new PreviewError("too_large", "Copying took too long. Publish a smaller built output."),
        );
        return;
      }
      const result = code === 0 ? parseCopyResult(stdout) : null;
      if (result) {
        resolve(result);
      } else if (code === 0) {
        reject(new PreviewError("invalid", "The snapshot copy did not finish."));
      } else if (code === 3) {
        reject(
          new PreviewError(
            "too_large",
            "The snapshot is larger than the limit of 300 MB or 10,000 files. Publish the built output, not the project.",
          ),
        );
      } else {
        reject(
          new PreviewError(
            "invalid",
            stderr.trim().slice(0, 500) || `Nothing to publish at ${source}.`,
          ),
        );
      }
    });
  });
}

/** Compare ids without leaking how many leading characters matched. */
function sameId(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type { PreviewVariantSet };
