import type { InstallationUpgrade } from "@getpaseo/protocol/installation-upgrades";
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
}

interface ReviewableJob {
  status: string;
  stage?: string;
}

function requiresReview(job: ReviewableJob): boolean {
  return ["pending", "failed"].includes(job.status) || job.stage === "recovery_required";
}

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
  settingId?: string;
  pane: string;
}

const QUEUES: readonly QueueDefinition[] = [
  {
    id: "restarts",
    noun: "restart request",
    jobs: currentSystemRestarts,
    settingId: "maintenance.installation.restarts",
    pane: "maintenance.installation",
  },
  {
    id: "helper",
    noun: "native helper request",
    jobs: (state) => state.helperJobs,
    pane: "system.overview",
  },
  {
    id: "broker",
    noun: "preview broker request",
    jobs: (state) => state.brokerJobs,
    pane: "system.overview",
  },
  {
    id: "monitor",
    noun: "preview monitor request",
    jobs: (state) => state.monitorJobs,
    pane: "system.overview",
  },
  {
    id: "services",
    noun: "service maintenance request",
    jobs: (state) => state.serviceQueue?.jobs ?? [],
    pane: "system.overview",
  },
  {
    id: "session-host",
    noun: "session host request",
    jobs: (state) => state.sessionHost?.jobs ?? [],
    settingId: "maintenance.installation.sessionHost",
    pane: "maintenance.installation",
  },
  {
    id: "instructions",
    noun: "agent instruction change",
    jobs: (state) => state.instructionRequests?.requests ?? [],
    settingId: "maintenance.installation.instructions",
    pane: "maintenance.installation",
  },
];

type PublicSummary = NonNullable<InstallationSystemState["restartSummary"]>;

const PUBLIC_SERVICES: ReadonlyArray<{ key: keyof PublicSummary; label: string }> = [
  { key: "serviceMaintenance", label: "Service maintenance" },
  { key: "nativeHelper", label: "Native helper" },
  { key: "previewBroker", label: "Preview broker" },
  { key: "previewBrokerDeployment", label: "Preview broker deployment" },
  { key: "previewMonitor", label: "Preview monitor" },
  { key: "sessionHost", label: "Session host" },
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
      settingId: "maintenance.installation.restarts",
      pane: "maintenance.installation",
    });
  for (const { key, label } of PUBLIC_SERVICES) {
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
    const jobs = queue.jobs(state).filter(requiresReview);
    if (!jobs.length) continue;
    items.push({
      id: queue.id,
      label: plural(jobs.length, queue.noun),
      status: jobStatus(jobs),
      count: jobs.length,
      settingId: queue.settingId,
      pane: queue.pane,
    });
  }
  const unacknowledged = upgrades.filter(
    (upgrade) => !upgrade.acknowledgedAt && requiresReview(upgrade),
  );
  if (unacknowledged.length)
    items.push({
      id: "upgrades",
      label: plural(unacknowledged.length, "Vorteo upgrade"),
      status: jobStatus(unacknowledged),
      count: unacknowledged.length,
      settingId: "maintenance.updates.vorteo",
      pane: "system.overview",
    });
  for (const service of state.enrollmentStatus?.services ?? []) {
    if (service.readiness !== "blocked") continue;
    items.push({
      id: `blocked-${service.target}`,
      label: `${service.target} is blocked`,
      status: service.reason || "Blocked",
      count: 1,
      pane: "system.overview",
    });
  }
  if (state.enrollmentStatus?.activation === "recovery-required")
    items.push({
      id: "activation",
      label: "Installation activation",
      status: "Needs recovery",
      count: 1,
      pane: "system.overview",
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
