import type {
  PreviewAnnotation,
  PreviewGallery,
  PreviewVariantSet,
  PreviewVersion,
} from "@getpaseo/protocol/previews";

/** Pure gallery shaping for the Previews card. Nothing here talks to the daemon. */

export type PreviewScope = "thread" | "all";
export type PreviewSort = "newest" | "rating";

/** One gallery tile: every version that shares a lineage key, newest first. */
export interface PreviewLineage {
  lineage: string;
  newest: PreviewVersion;
  versions: PreviewVersion[];
}

export interface PreviewVariantGroup {
  set: PreviewVariantSet;
  options: PreviewVersion[];
}

function createdMs(version: PreviewVersion): number {
  const ms = Date.parse(version.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

function newestFirst(left: PreviewVersion, right: PreviewVersion): number {
  return right.number - left.number || createdMs(right) - createdMs(left);
}

/**
 * The gallery the daemon sends already holds only this workspace's previews, so "all" is
 * the whole workspace and "thread" narrows it to what this thread published.
 */
export function scopeVersions(
  versions: readonly PreviewVersion[],
  scope: PreviewScope,
  agentId: string,
): PreviewVersion[] {
  return scope === "all" ? [...versions] : versions.filter((v) => v.agentId === agentId);
}

export function groupByLineage(versions: readonly PreviewVersion[]): PreviewLineage[] {
  const groups = new Map<string, PreviewVersion[]>();
  for (const version of versions) {
    const group = groups.get(version.lineage);
    if (group) group.push(version);
    else groups.set(version.lineage, [version]);
  }
  return Array.from(groups, ([lineage, group]) => {
    const sorted = group.toSorted(newestFirst);
    return { lineage, newest: sorted[0], versions: sorted };
  });
}

/** Newest: by the newest version's time. Rating: highest first, unrated last, ties by time. */
export function sortLineages(lineages: readonly PreviewLineage[], sort: PreviewSort) {
  return lineages.toSorted((left, right) => {
    const byTime = createdMs(right.newest) - createdMs(left.newest);
    if (sort === "newest") return byTime;
    const leftRating = left.newest.rating ?? 0;
    const rightRating = right.newest.rating ?? 0;
    return rightRating - leftRating || byTime;
  });
}

/** Variant sets with at least one option in view, options in the set's own order. */
export function variantGroups(
  gallery: PreviewGallery,
  versions: readonly PreviewVersion[],
): PreviewVariantGroup[] {
  const byId = new Map(versions.map((version) => [version.id, version]));
  return gallery.variantSets.flatMap((set) => {
    const options = set.versionIds.flatMap((id) => byId.get(id) ?? []);
    return options.length > 0 ? [{ set, options }] : [];
  });
}

export function withRating(
  gallery: PreviewGallery,
  versionId: string,
  rating: number | null,
): PreviewGallery {
  return {
    ...gallery,
    versions: gallery.versions.map((v) => (v.id === versionId ? { ...v, rating } : v)),
  };
}

/** The tile's star tap: tapping the current rating clears it. */
export function nextRating(current: number | null, tapped: number): number | null {
  return current === tapped ? null : tapped;
}

/** Short, plain-text label for where a comment points. Selection text is untrusted. */
export function annotationLocation(annotation: PreviewAnnotation): string {
  const selection = annotation.selection;
  if (!selection || selection.kind === "page") return "Whole page";
  if (selection.kind === "region") return "Region";
  const text = selection.text?.replace(/\s+/g, " ").trim();
  if (text) return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  return selection.tag ? `<${selection.tag}> element` : "Element";
}

// ---- Daemon HTTP routes ----------------------------------------------------------------

function route(base: string, path: string): string {
  return new URL(path, base).toString();
}

/**
 * Why a tile shows an icon instead of a picture. Live links and PDFs are never rendered;
 * a frozen page has no thumbnail when the daemon cannot run its sandboxed renderer, which
 * is usual inside a container.
 */
export function placeholderReason(version: Pick<PreviewVersion, "kind">): string {
  if (version.kind === "url") return "Live page";
  if (version.kind === "pdf") return "PDF";
  return "No thumbnail here";
}

export function thumbnailUrl(base: string, versionId: string): string {
  return route(base, `/api/previews/thumb/${encodeURIComponent(versionId)}`);
}

/** The frozen snapshot. `bare` hides the review toolbar inside the in-app zoom. */
export function snapshotUrl(base: string, versionId: string, bare: boolean): string {
  const url = route(base, `/api/previews/snap/${encodeURIComponent(versionId)}/`);
  return bare ? `${url}?bare=1` : url;
}

function isHttpsOrHttp(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Where the paired browser lands: the version's review page, or a live version's own page.
 * Only these two targets are ever produced, so an agent cannot steer the pairing elsewhere
 * except to the live URL it published for that version.
 */
export function pairTarget(version: PreviewVersion): string {
  if (version.kind === "url" && version.liveUrl && isHttpsOrHttp(version.liveUrl))
    return version.liveUrl;
  return `/api/previews/view/${encodeURIComponent(version.id)}`;
}

/** Pairs the owner's browser with a one-time ticket in the fragment, then continues on. */
export function buildPairUrl(base: string, ticket: string, version: PreviewVersion): string {
  const fragment = `ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(pairTarget(version))}`;
  return `${route(base, "/api/previews/pair")}#${fragment}`;
}
