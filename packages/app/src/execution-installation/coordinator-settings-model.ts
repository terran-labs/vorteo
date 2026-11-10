import type {
  CoordinatorFollowJob,
  CoordinatorFollowStatus,
  CoordinatorSettingsJob,
  CoordinatorSettingsStatus,
} from "@getpaseo/protocol/installation-upgrades";
import { coordinatorFollowView } from "./installation-upgrades-model";

export interface CoordinatorSettingRow {
  key: string;
  before: string;
  after: string;
  /** The coordinator hashed the file the new value names and it matched. */
  verified?: boolean;
}

/**
 * The coordinator settings card: nothing, or a change with its rows. `follow` is the pending
 * coordinator update, or the release to create one for, that a single approval can cover.
 */
export type CoordinatorSettingsView =
  | { kind: "hidden" }
  | {
      kind: "job";
      job: CoordinatorSettingsJob;
      rows: CoordinatorSettingRow[];
      follow: CoordinatorFollowJob | string | null;
    };

/**
 * Before and after per key, or per changed field of a structured setting such as the preview
 * broker's. Keys that are not display-safe show only that they changed.
 */
export function coordinatorSettingRows(job: CoordinatorSettingsJob): CoordinatorSettingRow[] {
  return job.changes.flatMap((change): CoordinatorSettingRow[] => {
    if (change.displaySafe && change.fields)
      return change.fields.map((field) => ({
        key: `${change.key}.${field.field}`,
        before: field.before ?? "not set",
        after: field.after ?? "removed",
        ...(field.verified ? { verified: true } : {}),
      }));
    return [
      change.displaySafe && change.before !== undefined && change.after !== undefined
        ? { key: change.key, before: change.before ?? "not set", after: change.after ?? "removed" }
        : { key: change.key, before: "hidden", after: "changed" },
    ];
  });
}

export function coordinatorSettingsView(
  status: CoordinatorSettingsStatus | null | undefined,
  followStatus: CoordinatorFollowStatus | null | undefined,
): CoordinatorSettingsView {
  const job = status?.job;
  if (!job) return { kind: "hidden" };
  let follow: CoordinatorFollowJob | string | null = null;
  if (job.status === "pending" && !job.approvedWith) {
    const view = coordinatorFollowView(followStatus);
    if (view.kind === "offer") follow = view.next;
    else if (view.kind === "job" && view.job.status === "pending") follow = view.job;
  }
  return { kind: "job", job, rows: coordinatorSettingRows(job), follow };
}

/** Polling follows a change closely while it waits on an update or restarts the coordinator. */
export function coordinatorSettingsInProgress(
  status: CoordinatorSettingsStatus | null | undefined,
) {
  const job = status?.job;
  if (!job) return false;
  return job.status === "approved" || job.status === "running" || job.approvedWith !== undefined;
}
