import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";
import type { ProjectSyncChangeSchema, ProjectSyncEntrySchema } from "@getpaseo/protocol/messages";
import type { z } from "zod";

// Installation project synchronization. A project is one identity, its key, with a folder on
// each host. Hosts join a project only by that folder: both daemons see the shared Projects
// folder at the same path, so the same path is the same project. A Git remote never joins two
// folders. See docs/execution-installation.md#synchronized-projects.

export type ProjectSyncEntry = z.infer<typeof ProjectSyncEntrySchema>;
export type ProjectSyncChange = z.infer<typeof ProjectSyncChangeSchema>;

export interface ProjectSyncHost {
  kind: ExecutionEnvironmentKind;
  projectsRoot: string;
  projects: readonly ProjectSyncEntry[];
}

interface Placement {
  host: ProjectSyncHost;
  project: ProjectSyncEntry;
}

interface Group {
  path: string;
  placements: Placement[];
  key: string;
}

/** A key minted for a folder whose inferred key another folder already holds. */
export function folderProjectKey(path: string): string {
  return `project:${createHash("sha256").update(path).digest("hex").slice(0, 24)}`;
}

function insideRoot(root: string, path: string): boolean {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) && path.length > prefix.length;
}

function oldestFirst(left: ProjectSyncEntry, right: ProjectSyncEntry): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.projectId.localeCompare(right.projectId)
  );
}

/** Host first, then Dev, so the trusted Host's key wins a tie. */
function hostFirst(left: Placement, right: Placement): number {
  return (left.host.kind === "host" ? 0 : 1) - (right.host.kind === "host" ? 0 : 1);
}

/** The group's key, or "conflict" when two Factory bindings hold different keys. */
function chooseKey(placements: readonly Placement[]): string | null | "conflict" {
  const ordered = [...placements].sort(hostFirst);
  // Factory bindings compare their project's key, so it can never change.
  // COMPAT(retiredFactoryCheckpoint): added after 26.11.902; current daemons always report false.
  // Remove the factory flag's handling here after 2027-05-10, once Host and Dev floors include
  // this release.
  const factory = new Set(
    ordered.filter((p) => p.project.factory).map((p) => p.project.projectKey),
  );
  if (factory.size > 1) return "conflict";
  const [factoryKey] = factory;
  if (factoryKey) return factoryKey;
  return (
    ordered.find((p) => p.project.projectKeyPinned && p.project.projectKey)?.project.projectKey ??
    ordered.find((p) => p.project.projectKey)?.project.projectKey ??
    null
  );
}

/**
 * Plans the changes that give every project inside the shared Projects folder one key on every
 * host and a record on each host where it is missing. Archived records are the owner's removal
 * on that host, so they are never restored, re-keyed or duplicated. Returns no changes unless
 * every host advertises the same Projects folder.
 */
export function planProjectSync(
  hosts: readonly ProjectSyncHost[],
): Map<ExecutionEnvironmentKind, ProjectSyncChange[]> {
  const root = hosts[0]?.projectsRoot;
  if (hosts.length < 2 || !root || hosts.some((host) => host.projectsRoot !== root))
    return new Map();
  const changes = new Map<ExecutionEnvironmentKind, ProjectSyncChange[]>(
    hosts.map((host) => [host.kind, []]),
  );
  const { byPath, archivedPaths } = collectPlacements(hosts, root);
  const { groups, reserved } = groupByFolder(byPath);
  const rekeyed = new Set<string>();
  const candidates: [from: string, to: string][] = [];
  for (const group of groups) {
    planKeys(group, changes, rekeyed, candidates);
    planCreates(group, hosts, archivedPaths, changes);
  }
  for (const [from, to] of safeRenames(hosts, groups, reserved, rekeyed, candidates)) {
    for (const host of hosts) changes.get(host.kind)!.push({ kind: "rename_key", from, to });
  }
  return changes;
}

/**
 * Renames that cannot reach another project: the old key must not remain on any active record
 * anywhere, including projects outside the Projects folder, and must name one new key.
 */
function safeRenames(
  hosts: readonly ProjectSyncHost[],
  groups: readonly Group[],
  reserved: ReadonlySet<string>,
  rekeyed: ReadonlySet<string>,
  candidates: readonly [string, string][],
): Map<string, string> {
  const held = new Set<string>([...reserved, ...groups.map((group) => group.key)]);
  for (const host of hosts) {
    for (const project of host.projects) {
      if (project.archived || !project.projectKey) continue;
      if (!rekeyed.has(placementId(host.kind, project.projectId))) held.add(project.projectKey);
    }
  }
  const renames = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [from, to] of candidates) {
    if (from === to || held.has(from)) continue;
    const existing = renames.get(from);
    if (existing !== undefined && existing !== to) ambiguous.add(from);
    renames.set(from, to);
  }
  for (const from of ambiguous) renames.delete(from);
  return renames;
}

function placementId(kind: ExecutionEnvironmentKind, projectId: string): string {
  return `${kind}:${projectId}`;
}

type PlannedChanges = Map<ExecutionEnvironmentKind, ProjectSyncChange[]>;

/** Active records by folder, at most one per host, and each host's archived folders. */
function collectPlacements(hosts: readonly ProjectSyncHost[], root: string) {
  const byPath = new Map<string, Placement[]>();
  const archivedPaths = new Map<ExecutionEnvironmentKind, Set<string>>();
  for (const host of hosts) {
    const archived = new Set<string>();
    archivedPaths.set(host.kind, archived);
    const seen = new Set<string>();
    for (const project of [...host.projects].sort(oldestFirst)) {
      const path = project.logicalRootPath;
      if (!insideRoot(root, path)) continue;
      if (project.archived) {
        archived.add(path);
        continue;
      }
      // One record per folder on a host; a duplicate stays as the host left it.
      if (seen.has(path)) continue;
      seen.add(path);
      const placements = byPath.get(path) ?? [];
      placements.push({ host, project });
      byPath.set(path, placements);
    }
  }
  return { byPath, archivedPaths };
}

function groupByFolder(byPath: ReadonlyMap<string, Placement[]>) {
  const groups: Group[] = [];
  // Keys held at folders left for an operator; no other folder may claim them.
  const reserved = new Set<string>();
  for (const [path, placements] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    const key = chooseKey(placements);
    // Two Factory bindings disagree; leave the folder for an operator rather than guess.
    if (key === "conflict") {
      for (const { project } of placements)
        if (project.projectKey) reserved.add(project.projectKey);
      continue;
    }
    groups.push({ path, placements, key: key ?? folderProjectKey(path) });
  }
  // A key belongs to one folder. When a remote-derived key landed on several folders, the
  // folder that keeps it is the one with a Factory binding or a pinned key, else the oldest.
  const owners = new Map<string, Group>();
  for (const group of groups) {
    const owner = owners.get(group.key);
    if (!owner || groupPrecedes(group, owner)) owners.set(group.key, group);
  }
  for (const group of groups) {
    if (group.placements.some((p) => p.project.factory)) continue;
    if (owners.get(group.key) !== group || reserved.has(group.key))
      group.key = folderProjectKey(group.path);
  }
  return { groups, reserved };
}

function planKeys(
  group: Group,
  changes: PlannedChanges,
  rekeyed: Set<string>,
  candidates: [string, string][],
): void {
  for (const { host, project } of group.placements) {
    // Memberships and saved sidebar state under a replaced key follow the project. Previous
    // keys are offered every pass, so a rename cut short by a failed batch still completes.
    for (const previous of project.previousKeys ?? []) candidates.push([previous, group.key]);
    if (project.projectKey === group.key && project.projectKeyPinned) continue;
    if (project.factory && project.projectKey !== group.key) continue;
    changes.get(host.kind)!.push({
      kind: "set_key",
      projectId: project.projectId,
      projectKey: group.key,
    });
    if (project.projectKey && project.projectKey !== group.key) {
      rekeyed.add(placementId(host.kind, project.projectId));
      candidates.push([project.projectKey, group.key]);
    }
  }
}

function planCreates(
  group: Group,
  hosts: readonly ProjectSyncHost[],
  archivedPaths: ReadonlyMap<ExecutionEnvironmentKind, ReadonlySet<string>>,
  changes: PlannedChanges,
): void {
  const named = [...group.placements].sort(hostFirst)[0]!.project;
  for (const host of hosts) {
    if (group.placements.some((placement) => placement.host === host)) continue;
    if (archivedPaths.get(host.kind)!.has(group.path)) continue;
    changes.get(host.kind)!.push({
      kind: "create",
      rootPath: group.path,
      projectKey: group.key,
      displayName: named.displayName,
      customName: named.customName,
    });
  }
}

function groupRank(group: Group): number {
  if (group.placements.some((p) => p.project.factory)) return 0;
  return group.placements.some(
    (p) => p.project.projectKeyPinned && p.project.projectKey === group.key,
  )
    ? 1
    : 2;
}

function groupPrecedes(candidate: Group, current: Group): boolean {
  const oldest = (group: Group) =>
    Math.min(...group.placements.map((p) => Date.parse(p.project.createdAt)));
  const order =
    groupRank(candidate) - groupRank(current) ||
    oldest(candidate) - oldest(current) ||
    candidate.path.localeCompare(current.path);
  return order < 0;
}

type SyncClient = Pick<DaemonClient, "listProjectsForSync" | "applyProjectSync" | "close">;

/** How long a refused change waits before it is tried again, such as a folder missing in Dev. */
const REFUSAL_RETRY_MS = 10 * 60_000;
/** Changes per request, well under the protocol's limit and the request timeout. */
const APPLY_BATCH = 50;

export function createProjectSyncRuntime(input: {
  environments: readonly ExecutionEnvironmentKind[];
  connect(kind: ExecutionEnvironmentKind): Promise<SyncClient>;
  assertReady?(kind: ExecutionEnvironmentKind): void;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const refused = new Map<string, number>();

  async function reconcile(): Promise<void> {
    const clients = new Map<ExecutionEnvironmentKind, SyncClient>();
    try {
      const hosts: ProjectSyncHost[] = [];
      for (const kind of input.environments) {
        input.assertReady?.(kind);
        const client = await input.connect(kind);
        clients.set(kind, client);
        const listed = await client.listProjectsForSync();
        // A daemon that predates synchronization, or has no Projects folder, opts the pass out.
        if (!listed?.projectsRoot) return;
        hosts.push({ kind, projectsRoot: listed.projectsRoot, projects: listed.projects });
      }
      for (const [kind, planned] of planProjectSync(hosts)) {
        const due = planned.filter(
          (change) => (refused.get(refusalKey(kind, change)) ?? 0) <= now(),
        );
        if (due.length === 0) continue;
        for (let start = 0; start < due.length; start += APPLY_BATCH) {
          const batch = due.slice(start, start + APPLY_BATCH);
          const results = await clients.get(kind)!.applyProjectSync(batch);
          record(kind, batch, results);
        }
      }
    } finally {
      await Promise.all([...clients.values()].map((client) => client.close()));
    }
  }

  function record(
    kind: ExecutionEnvironmentKind,
    batch: readonly ProjectSyncChange[],
    results: Awaited<ReturnType<SyncClient["applyProjectSync"]>>,
  ): void {
    batch.forEach((change, index) => {
      const result = results[index];
      if (result?.applied) {
        refused.delete(refusalKey(kind, change));
        // Renames under previous keys repeat every pass; only real changes are logged.
        if (change.kind !== "rename_key")
          input.logger.info({ environment: kind, change }, "Synchronized project");
      } else {
        refused.set(refusalKey(kind, change), now() + REFUSAL_RETRY_MS);
        input.logger.warn(
          { environment: kind, change, error: result?.error ?? null },
          "Project synchronization change was refused",
        );
      }
    });
  }

  return { reconcile };
}

function refusalKey(kind: ExecutionEnvironmentKind, change: ProjectSyncChange): string {
  return JSON.stringify([kind, change]);
}
