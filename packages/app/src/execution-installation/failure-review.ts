/**
 * Which finished records still need the owner. A failure stops needing review once the owner
 * dismisses it (`acknowledgedAt`) or once a later record for the same target succeeded. A
 * failure that is the latest state of its target always keeps counting, and a record with no
 * target key keeps counting until it is dismissed. Nothing here hides a record from history;
 * the cards still list it, marked as superseded.
 */
export interface ReviewableRecord {
  status: string;
  stage?: string;
  createdAt?: string;
  /** Set by a coordinator that records the owner's dismissal. Optional on the wire. */
  acknowledgedAt?: string;
}

/** Groups records that replace each other: a later success here supersedes an earlier failure. */
export type TargetKey<T> = (record: T) => string | null;

/** A failed record followed by a later success for the same target. */
export function isSupersededFailure<T extends ReviewableRecord>(
  record: T,
  records: readonly T[],
  targetKey: TargetKey<T>,
): boolean {
  if (record.status !== "failed" || !record.createdAt) return false;
  const key = targetKey(record);
  if (key === null) return false;
  const createdAt = record.createdAt;
  return records.some(
    (other) =>
      other !== record &&
      other.status === "succeeded" &&
      Boolean(other.createdAt) &&
      other.createdAt! > createdAt &&
      targetKey(other) === key,
  );
}

/** Pending, stuck or failed records the owner still has to act on. */
export function recordsNeedingReview<T extends ReviewableRecord>(
  records: readonly T[],
  targetKey: TargetKey<T>,
): T[] {
  return records.filter((record) => {
    if (record.stage === "recovery_required") return true;
    if (record.status === "pending") return true;
    if (record.status !== "failed") return false;
    if (record.acknowledgedAt) return false;
    return !isSupersededFailure(record, records, targetKey);
  });
}

/** Jobs whose schema names the service they act on. */
export function byTarget(record: { target?: string }): string | null {
  return record.target ?? null;
}

/** Release upgrades all act on the one installation, so any later success supersedes. */
export function upgradeTarget(): string {
  return "installation";
}

/** A pending instruction request written against older instructions can no longer apply. */
export function instructionRequestIsStale(
  request: { status: string; baseRevision: number },
  currentRevision: number,
): boolean {
  return request.status === "pending" && request.baseRevision !== currentRevision;
}
