import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import { isOwnerStop } from "./factory-reads";
import { FACTORY_LANES, factoryLane, type FactoryIssue, type FactoryLane } from "./overview-model";

/**
 * Pure model for overviews that span several Factories: every project's Factory on every host
 * of the installation.
 */

export type FactoryDrain = NonNullable<ProjectFactoryState["drain"]>;

/** One project's Factory on one host, as far as the client has loaded it. */
export interface FactoryScopeEntry {
  key: string;
  serverId: string;
  projectId: string;
  name: string;
  /** Shown only when the overview spans more than one host. */
  hostLabel: string | null;
  /** Full state once loaded; the list entry alone is enough to show the pill. */
  state: ProjectFactoryState | null;
  status: ProjectFactoryState["state"];
  /** Set while pause_all holds this project. */
  drain: FactoryDrain | null;
  /** Null until loaded, or when the daemon has no queue. */
  issues: FactoryIssue[] | null;
}

export function factoryScopeKey(serverId: string, projectId: string): string {
  return `${serverId}:${projectId}`;
}

/** Every loaded issue, tagged with the Factory it belongs to. */
export function scopedIssues(entries: readonly FactoryScopeEntry[]): FactoryIssue[] {
  return entries.flatMap((entry) =>
    (entry.issues ?? []).map(
      (issue): FactoryIssue =>
        Object.assign({}, issue, {
          origin: {
            key: entry.key,
            serverId: entry.serverId,
            projectId: entry.projectId,
            label: entry.name,
          },
        }),
    ),
  );
}

/** Issues per lane across every queue; queues still loading count as empty. */
export function aggregateStageCounts(
  queues: readonly (readonly FactoryIssue[] | null | undefined)[],
): Record<FactoryLane, number> {
  const counts = Object.fromEntries(FACTORY_LANES.map((lane) => [lane, 0])) as Record<
    FactoryLane,
    number
  >;
  for (const queue of queues) {
    for (const issue of queue ?? []) counts[factoryLane(issue.stage)] += 1;
  }
  return counts;
}

/** One pause_all on one host. The daemon gives each project its own drain id. */
export interface FactoryStop {
  key: string;
  serverId: string;
  reason: string;
  /** The earliest project's pause. */
  pausedAt: string;
  projects: number;
  /** Started by Stop all Factories; otherwise someone else, such as Builds, holds it. */
  owner: boolean;
}

function drainOf(entry: FactoryScopeEntry): FactoryDrain | null {
  return entry.drain ?? entry.state?.drain ?? null;
}

/** Stops holding Factories, one per host and reason, however many projects each holds. */
export function activeDrains(entries: readonly FactoryScopeEntry[]): FactoryStop[] {
  const stops = new Map<string, FactoryStop>();
  for (const entry of entries) {
    const drain = drainOf(entry);
    if (!drain) continue;
    const key = `${entry.serverId}:${drain.reason}`;
    const current = stops.get(key);
    stops.set(key, {
      key,
      serverId: entry.serverId,
      reason: drain.reason,
      pausedAt: current && current.pausedAt < drain.pausedAt ? current.pausedAt : drain.pausedAt,
      projects: (current?.projects ?? 0) + 1,
      owner: isOwnerStop(drain),
    });
  }
  return [...stops.values()];
}

/** What one host's Factories allow the global stop control to do. */
export interface HostStopState {
  /** Some Factory is on and not stopped, so Stop all has something to stop. */
  running: boolean;
  /** Stop all holds some Factory. */
  ours: boolean;
  /** Someone else, such as Builds before a restart, holds some Factory. */
  foreign: boolean;
}

/**
 * Read from scope entries, or list entries with their state as status. resume_all releases every drain on a host, so a host
 * with any foreign drain is never resumed, and never stopped again on top of it.
 */
export function hostStopState(
  projects: readonly { status: string; drain?: { reason: string } | null }[],
): HostStopState {
  let running = false;
  let ours = false;
  let foreign = false;
  for (const project of projects) {
    if (project.drain) {
      if (isOwnerStop(project.drain)) ours = true;
      else foreign = true;
    } else if (project.status === "on") {
      running = true;
    }
  }
  return { running, ours, foreign };
}

export function canStopHost(state: HostStopState): boolean {
  return state.running && !state.foreign;
}

export function canResumeHost(state: HostStopState): boolean {
  return state.ours && !state.foreign;
}

/**
 * Which hosts a confirmed Stop all or Resume all may act on, from a fresh list read of each.
 * A host whose read failed is never acted on, and one that no longer qualifies is skipped; the
 * rest proceed, so one unreachable host does not stop the others.
 */
export function selectFreshTargets<Host>(
  targets: readonly Host[],
  reads: readonly PromiseSettledResult<{
    projects: readonly { state: string; drain: { reason: string } | null }[];
  }>[],
  qualifies: (state: HostStopState) => boolean,
): { act: Host[]; unreadable: Host[]; skipped: Host[] } {
  const act: Host[] = [];
  const unreadable: Host[] = [];
  const skipped: Host[] = [];
  targets.forEach((host, index) => {
    const read = reads[index];
    if (!read || read.status === "rejected") {
      unreadable.push(host);
      return;
    }
    const state = hostStopState(
      read.value.projects.map((project) => ({ status: project.state, drain: project.drain })),
    );
    (qualifies(state) ? act : skipped).push(host);
  });
  return { act, unreadable, skipped };
}
