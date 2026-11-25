import type { InstallationUpgrade } from "@getpaseo/protocol/installation-upgrades";
import {
  byTarget,
  byTargetAndOperation,
  instructionRequestIsStale,
  recordsNeedingReview,
  upgradeTarget,
  withDismissals,
  type ReviewableRecord,
  type TargetKey,
} from "@/execution-installation/failure-review";
import type { HealthDismissalQueue } from "@getpaseo/protocol/health-dismissals";
import type { HealthCard, HealthCardHost } from "@/execution-installation/health-cards";
import { currentSystemRestarts, type InstallationSystemState } from "./system-adapter-model";

/**
 * One problem in the System health list: what is wrong, where it stands now, and the setting
 * that resolves it. `count` is how many requests the row stands for, so the rows add up to the
 * number on the "System needs attention" button.
 */
export interface SystemHealthItem {
  id: string;
  label: string;
  status: string;
  count: number;
  /** Catalog entry whose row the Fix button jumps to. */
  settingId?: string;
  /** Pane the Fix button jumps to when no single row owns the fix. */
  pane: string;
  /** The request card Fix opens, expanding the section that holds it. Wins over settingId. */
  card?: HealthCard;
  /** The collapsed section holding `card`. */
  cardHost?: HealthCardHost;
  /** The card renders only with owner access, so Fix asks to unlock first. */
  needsUnlock?: boolean;
  /** The card opens as a sheet, such as restart approvals, so Fix does not scroll the page. */
  cardInSheet?: boolean;
}

type ReviewableJob = ReviewableRecord;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "2 waiting for approval, 1 failed", from the jobs that need review. */
function jobStatus(jobs: readonly ReviewableJob[]): string {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    let label = "failed";
    if (job.stage === "recovery_required") label = "needs recovery";
    else if (job.status === "pending") label = "waiting for approval";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, count]) => `${count} ${label}`);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface QueueDefinition {
  id: string;
  noun: string;
  jobs: (state: InstallationSystemState) => readonly ReviewableJob[];
  /**
   * Which records replace each other. Restarts, broker, monitor, helper and service jobs are
   * keyed by the service they act on, session host jobs by service and operation; instruction requests have no target, so a
   * pending one counts until it is decided or goes stale.
   */
  targetKey: TargetKey<ReviewableJob>;
  /** Where the owner's dismissals of this queue's failures are recorded. */
  dismissalQueue?: HealthDismissalQueue;
  card: HealthCard;
  pane: string;
}

const noTarget = () => null;

/** Pending requests written against the current instructions. Stale ones cannot be applied. */
function currentInstructionRequests(state: InstallationSystemState): ReviewableJob[] {
  const overview = state.instructionRequests;
  if (!overview) return [];
  return overview.requests.filter(
    (request) => !instructionRequestIsStale(request, overview.revision),
  );
}

const QUEUES: readonly QueueDefinition[] = [
  {
    id: "restarts",
    dismissalQueue: "restart",
    noun: "restart request",
    jobs: currentSystemRestarts,
    targetKey: byTarget as TargetKey<ReviewableJob>,
    card: "restarts",
    pane: "system.overview",
  },
  {
    id: "helper",
    dismissalQueue: "native-helper",
    noun: "native helper request",
    jobs: (state) => state.helperJobs,
    targetKey: byTarget as TargetKey<ReviewableJob>,
    card: "helper",
    pane: "system.overview",
  },
  {
    id: "broker",
    dismissalQueue: "preview-broker",
    noun: "preview broker request",
    jobs: (state) => state.brokerJobs,
    targetKey: byTarget as TargetKey<ReviewableJob>,
    card: "broker",
    pane: "system.overview",
  },
  {
    id: "monitor",
    dismissalQueue: "preview-monitor",
    noun: "preview monitor request",
    jobs: (state) => state.monitorJobs,
    targetKey: byTarget as TargetKey<ReviewableJob>,
    card: "monitor",
    pane: "system.overview",
  },
  {
    id: "services",
    dismissalQueue: "maintenance-service",
    noun: "service maintenance request",
    jobs: (state) => state.serviceQueue?.jobs ?? [],
    targetKey: byTarget as TargetKey<ReviewableJob>,
    card: "services",
    pane: "system.overview",
  },
  {
    id: "session-host",
    dismissalQueue: "session-host",
    noun: "session host request",
    jobs: (state) => state.sessionHost?.jobs ?? [],
    targetKey: byTargetAndOperation as TargetKey<ReviewableJob>,
    card: "session-host",
    pane: "system.overview",
  },
  {
    id: "instructions",
    noun: "agent instruction change",
    jobs: currentInstructionRequests,
    targetKey: noTarget,
    card: "instructions",
    pane: "system.overview",
  },
];

/** Restarts open on the environment they target; every other card lives in Host's Details. */
function queueCardHost(queue: QueueDefinition, jobs: readonly ReviewableJob[]): HealthCardHost {
  if (queue.id !== "restarts") return "host";
  // An approval to give wins over a failure to read.
  const job = jobs.find((entry) => entry.status !== "failed") ?? jobs[0];
  const target = (job as { target?: string } | undefined)?.target;
  return target === "container-daemon" ? "container-daemon" : "host";
}

/** Pending upgrades, and failed ones the owner has not dismissed and no later upgrade replaced. */
export function upgradesNeedingReview(
  upgrades: readonly InstallationUpgrade[],
): InstallationUpgrade[] {
  return recordsNeedingReview(upgrades, upgradeTarget);
}

type PublicSummary = NonNullable<InstallationSystemState["restartSummary"]>;

const PUBLIC_SERVICES: ReadonlyArray<{
  key: keyof PublicSummary;
  label: string;
  card: HealthCard;
}> = [
  { key: "serviceMaintenance", label: "Service maintenance", card: "services" },
  { key: "nativeHelper", label: "Native helper", card: "helper" },
  { key: "previewBroker", label: "Preview broker", card: "broker" },
  { key: "previewBrokerDeployment", label: "Preview broker deployment", card: "broker" },
  { key: "previewMonitor", label: "Preview monitor", card: "monitor" },
  { key: "sessionHost", label: "Session host", card: "session-host" },
];

/** While locked only the public summary counts are known, so the rows say so. */
function lockedItems(summary: PublicSummary | null | undefined): SystemHealthItem[] {
  if (!summary) return [];
  const items: SystemHealthItem[] = [];
  if (summary.requested > 0)
    items.push({
      id: "restarts",
      label: plural(summary.requested, "restart request"),
      status: "Waiting for approval. Unlock to review.",
      count: summary.requested,
      pane: "system.overview",
      card: "restarts",
      cardHost: "host",
      needsUnlock: true,
      cardInSheet: true,
    });
  for (const { key, label, card } of PUBLIC_SERVICES) {
    const service = summary[key] as Record<string, unknown> | null | undefined;
    if (!service || typeof service !== "object") continue;
    const number = (field: string) =>
      typeof service[field] === "number" ? (service[field] as number) : 0;
    const requested = number("requested");
    const recovery = number("recovery");
    const attention = number("attention");
    const count = requested + recovery + attention;
    if (!count) continue;
    const parts = [
      requested ? `${requested} requested` : null,
      recovery ? `${recovery} need recovery` : null,
      attention ? `${attention} need attention` : null,
    ].filter(Boolean);
    items.push({
      id: `service-${String(key)}`,
      label,
      status: `${parts.join(", ")}. Unlock to review.`,
      count,
      pane: "system.overview",
      card,
      cardHost: "host",
      needsUnlock: true,
    });
  }
  return items;
}

/**
 * Everything the installation reports as needing the owner, item by item: the same rules as
 * the former `systemAttentionCount`. The Health list and the "System needs attention" button both
 * show one row per item, so the button's number is the number of rows.
 */
export function systemHealthItems(
  state: InstallationSystemState | null,
  upgrades: readonly InstallationUpgrade[] = [],
): SystemHealthItem[] {
  if (!state) return [];
  if (!state.unlocked) return lockedItems(state.restartSummary);
  const items: SystemHealthItem[] = [];
  for (const queue of QUEUES) {
    const records = withDismissals(
      queue.jobs(state) as (ReviewableJob & { id: string })[],
      state.healthDismissals,
      queue.dismissalQueue,
    );
    const jobs = recordsNeedingReview(records, queue.targetKey);
    if (!jobs.length) continue;
    items.push({
      id: queue.id,
      label: plural(jobs.length, queue.noun),
      status: jobStatus(jobs),
      count: jobs.length,
      pane: queue.pane,
      card: queue.card,
      cardHost: queueCardHost(queue, jobs),
      needsUnlock: true,
      // Restart approvals live in the environment's Restart sheet; a failed one is in History.
      cardInSheet: queue.id === "restarts" && jobs.some((job) => job.status !== "failed"),
    });
  }
  const unacknowledged = upgradesNeedingReview(upgrades);
  if (unacknowledged.length)
    items.push({
      id: "upgrades",
      label: plural(unacknowledged.length, "Vorteo upgrade"),
      status: jobStatus(unacknowledged),
      count: unacknowledged.length,
      pane: "system.overview",
      card: "upgrades",
      cardHost: "updates",
      needsUnlock: true,
    });
  for (const service of state.enrollmentStatus?.services ?? []) {
    if (service.readiness !== "blocked") continue;
    items.push({
      id: `blocked-${service.target}`,
      label: `${service.target} is blocked`,
      status: service.reason || "Blocked",
      count: 1,
      pane: "system.overview",
      card: "dashboard",
      cardHost: "host",
      needsUnlock: true,
    });
  }
  if (state.enrollmentStatus?.activation === "recovery-required")
    items.push({
      id: "activation",
      label: "Installation activation",
      status: "Needs recovery",
      count: 1,
      pane: "system.overview",
      card: "dashboard",
      cardHost: "host",
      needsUnlock: true,
    });
  if (state.liveDev?.mode === "live" && state.liveDev.server.state === "failed")
    items.push({
      id: "live-dev",
      label: "Live development server",
      status: "Failed",
      count: 1,
      settingId: "maintenance.installation.deliveryMode",
      pane: "system.overview",
    });
  return items;
}
