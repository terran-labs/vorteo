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

/** Parsed, so "…:00Z" and "…:00.500Z" in the same second still order correctly. */
function timeOf(record: ReviewableRecord): number | null {
  if (!record.createdAt) return null;
  const time = Date.parse(record.createdAt);
  return Number.isNaN(time) ? null : time;
}

/** A failed record followed by a later success for the same target. */
export function isSupersededFailure<T extends ReviewableRecord>(
  record: T,
  records: readonly T[],
  targetKey: TargetKey<T>,
): boolean {
  if (record.status !== "failed") return false;
  const createdAt = timeOf(record);
  const key = targetKey(record);
  if (createdAt === null || key === null) return false;
  return records.some((other) => {
    if (other === record || other.status !== "succeeded") return false;
    const otherAt = timeOf(other);
    return otherAt !== null && otherAt > createdAt && targetKey(other) === key;
  });
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

/**
 * Session host jobs: an install, remove or restart each change something different, so a
 * successful restart does not show that a failed install's plist change ever landed.
 */
export function byTargetAndOperation(record: {
  target?: string;
  operation?: string;
}): string | null {
  return record.target && record.operation ? `${record.target}:${record.operation}` : null;
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
