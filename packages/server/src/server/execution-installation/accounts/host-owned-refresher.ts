import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  projectionReceiptMatches,
  type HostProjectionDelivery,
  type HostProjectionReceipt,
} from "./host-owned-projection.js";

const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TargetSchema = z.strictObject({
  serverId: z.string().min(1),
  providerId: z.string().min(1),
  excluded: z.boolean(),
  appliedRotation: Counter.nullable(),
});
/** Secret-free by construction: digests, expiry and identity only, never a token. */
const RecordSchema = z.strictObject({
  definitionId: z.string().min(1),
  generation: Positive,
  rotation: Counter,
  signedIn: z.boolean(),
  hostGrant: z.enum(["present", "missing"]).nullable(),
  policyRevision: Positive,
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  expiresAt: Counter.nullable(),
  /** `orgId` is the provider's organization or workspace: Claude's org, Codex's ChatGPT account. */
  identity: z
    .strictObject({ email: z.string().nullable(), orgId: z.string().nullable() })
    .nullable(),
  checkedAt: Counter.nullable(),
  refresh: z
    .strictObject({ at: Counter, outcome: z.enum(["refreshed", "unchanged", "failed"]) })
    .nullable(),
  /** Consecutive refreshes of the current Host token that did not produce a newer one. */
  refreshFailures: Counter.default(0),
  /** Consecutive reconciles that left a rotation undelivered, and when to try again. */
  deliveryFailures: Counter.default(0),
  deliveryRetryAt: Counter.nullable().default(null),
  targets: z.array(TargetSchema),
});
export const HostRefreshStateSchema = z.array(RecordSchema);
export type HostRefreshState = z.infer<typeof HostRefreshStateSchema>;
// Diagnostic fields never enter state.json: older coordinators parse it strictly.
const DiagnosticFields = z.object({
  failureReason: z
    .enum([
      "storage_unreadable",
      "grant_missing",
      "refresh_failed",
      "refresh_unchanged",
      "policy_unavailable",
    ])
    .optional(),
  missedExpiry: Counter.optional(),
  refreshRetry: z
    .object({
      at: Counter,
      failures: Counter,
      expiresAt: Counter.nullable(),
      reason: z.enum(["refresh_failed", "refresh_unchanged"]),
    })
    .optional(),
});
const DiagnosticSchema = DiagnosticFields.extend({
  definitionId: z.string().min(1),
  generation: Positive,
  refreshAt: Counter.nullable(),
  refreshFailures: Counter,
});
export const HostRefreshDiagnosticsSchema = z.array(DiagnosticSchema);
export type HostRefreshDiagnostics = z.infer<typeof HostRefreshDiagnosticsSchema>;
const InternalRecordSchema = RecordSchema.extend(DiagnosticFields.shape);
type HostRefreshRecord = z.infer<typeof InternalRecordSchema>;

export interface HostRefreshIdentity {
  email: string | null;
  orgId: string | null;
}

export interface HostRefreshPolicy {
  revision: number;
  removed: boolean;
  hostEnabled?: boolean;
  /** Dev environments that receive access projections. */
  targets: Array<{ serverId: string; providerId: string; excluded: boolean }>;
}

/** What the refresher needs to know about a Host grant. The refresh token itself never leaves. */
export interface HostGrant {
  expiresAt: number | null;
}

/** Provider rules for one kind of Host-owned credential. */
export interface HostGrantAdapter<G extends HostGrant, P> {
  /** Access-only view for Dev, or null when the grant cannot be projected usefully. */
  project(grant: G | null): P | null;
  digest(projection: P | null): string;
  /** Whether the Host should refresh this grant now. False without a refresh token. */
  needsRefresh(grant: G | null, now: number): boolean;
  /** How long before expiry the refresher starts reading the Host more often. */
  leadMs: number;
  refreshForHost?: boolean;
  /** Thrown, without detail, for every refusal. */
  error(): Error;
}

export interface HostRefresherPorts<G extends HostGrant, P> {
  installationId: string;
  read(): unknown;
  persist(state: HostRefreshState): void;
  diagnostics?: {
    read(): unknown;
    persist(diagnostics: HostRefreshDiagnostics): void;
  };
  /** Throws when the definition no longer exists or is not a Host-owned account. */
  policy(definitionId: string): HostRefreshPolicy;
  /** The Host account's grant, read from its own CLI storage. Throws when the Host is unreachable. */
  grant(definitionId: string): Promise<G | null>;
  /** Asks the official Host CLI to refresh under its own locks. */
  refresh(definitionId: string): Promise<void>;
  deliver(delivery: HostProjectionDelivery<P>): Promise<HostProjectionReceipt>;
  now(): number;
}

/** Normal cadence for noticing a rotation made by a Host agent or a new sign-in. */
const RECHECK_MS = 5 * 60_000;
/** First retry delay after a failed refresh; it doubles up to RECHECK_MS. */
const REFRESH_RETRY_MS = 60_000;
/** First retry delay for an undelivered rotation; it doubles up to RECHECK_MS. */
const DELIVERY_RETRY_MS = 30_000;

/**
 * The coordinator's Host-owned refresh, shared by every provider whose Host CLI keeps a rotating
 * grant. Provider policy decides whether Host use or Dev delivery permits renewal. It delivers
 * access-only projections in generation and rotation order, and withdraws them on exclusion,
 * removal, sign-out or a missing Host grant. The Host CLI is the only refresh writer. The access
 * token lives in memory for one reconcile; a pending delivery re-reads it from the Host.
 */
export class HostOwnedRefresher<G extends HostGrant, P> {
  private records: HostRefreshRecord[];
  private queues = new Map<string, Promise<void>>();
  private recoveries = new Map<string, Promise<void>>();
  private reconciliation: Promise<void> | null = null;
  private persistenceFailed = false;

  constructor(
    private readonly ports: HostRefresherPorts<G, P>,
    private readonly adapter: HostGrantAdapter<G, P>,
  ) {
    const parsed = HostRefreshStateSchema.safeParse(ports.read());
    if (!parsed.success) throw adapter.error();
    let diagnostics: HostRefreshDiagnostics = [];
    try {
      const saved = HostRefreshDiagnosticsSchema.safeParse(ports.diagnostics?.read() ?? []);
      if (saved.success) diagnostics = saved.data;
    } catch {
      // Optional evidence must not prevent startup when its file is missing or unreadable.
    }
    this.records = parsed.data;
    for (const record of this.records) {
      const saved = diagnostics.find(
        (item) =>
          item.definitionId === record.definitionId && item.generation === record.generation,
      );
      const matchingFailure =
        saved?.refreshAt === record.refresh?.at &&
        saved?.refreshFailures === record.refreshFailures;
      record.missedExpiry = saved?.missedExpiry;
      record.failureReason = matchingFailure ? saved?.failureReason : undefined;
      record.refreshRetry = matchingFailure ? saved?.refreshRetry : undefined;
    }
    if (new Set(this.records.map((record) => record.definitionId)).size !== this.records.length)
      throw adapter.error();
  }

  status(definitionId: string) {
    if (this.persistenceFailed) throw this.adapter.error();
    const record = this.records.find((item) => item.definitionId === definitionId);
    if (!record)
      return {
        signedIn: false,
        needsSignIn: false,
        identity: null,
        expiresAt: null,
        refresh: null,
        environments: [],
      };
    let policy: HostRefreshPolicy;
    try {
      policy = this.ports.policy(definitionId);
    } catch {
      policy = { revision: record.policyRevision, removed: true, targets: record.targets };
    }
    const current = policy.revision === record.policyRevision;
    const unexpired = record.expiresAt === null || record.expiresAt > this.ports.now();
    const present = record.signedIn && record.hostGrant === "present" && !policy.removed;
    const usable = present && unexpired;
    return {
      signedIn: record.signedIn,
      needsSignIn: record.signedIn && record.hostGrant === "missing",
      identity: record.identity,
      expiresAt: record.expiresAt,
      refresh: record.refresh,
      environments: policy.targets.map((target) => {
        let status = record.signedIn ? "pending" : "disconnecting";
        if (target.excluded) status = "excluded";
        else if (
          current &&
          record.targets.some(
            (saved) =>
              saved.serverId === target.serverId &&
              saved.providerId === target.providerId &&
              saved.appliedRotation === record.rotation,
          )
        ) {
          status = present ? "pending" : "disconnected";
          if (usable) status = "ready";
        }
        return { serverId: target.serverId, status };
      }),
    };
  }

  /** A completed Host sign-in starts a new generation. */
  connected(definitionId: string, identity: HostRefreshIdentity | null): Promise<void> {
    return this.enqueue(definitionId, async () => {
      const policy = this.ports.policy(definitionId);
      if (policy.removed) throw this.adapter.error();
      this.replace(definitionId, policy, { signedIn: true, identity, digest: null });
    });
  }

  /** Sign-out starts a new generation whose only projection is a withdrawal. */
  signedOut(definitionId: string): Promise<void> {
    return this.enqueue(definitionId, async () => {
      const policy = this.ports.policy(definitionId);
      const previous = this.records.find((item) => item.definitionId === definitionId);
      this.replace(definitionId, policy, {
        signedIn: false,
        identity: previous?.identity ?? null,
        digest: this.adapter.digest(null),
      });
    });
  }

  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const task = Promise.all(
      this.records.map((record) =>
        this.enqueue(record.definitionId, () => this.reconcileRecord(record.definitionId)).catch(
          () => {
            // One unavailable account must not delay another account's renewal.
          },
        ),
      ),
    ).then(() => undefined);
    this.reconciliation = task.finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  /** Recovery uses the same per-account writer and retry budget as scheduled work. */
  recover(definitionId: string, expectedPolicyRevision?: number): Promise<void> {
    const revision = expectedPolicyRevision ?? this.ports.policy(definitionId).revision;
    if (this.ports.policy(definitionId).revision !== revision)
      return Promise.reject(this.adapter.error());
    const existing = this.recoveries.get(definitionId);
    if (existing) return existing;
    const generation = this.records.find(
      (record) => record.definitionId === definitionId,
    )?.generation;
    const task = this.enqueue(definitionId, async () => {
      const record = this.records.find((item) => item.definitionId === definitionId);
      if (
        !record?.signedIn ||
        record.generation !== generation ||
        this.ports.policy(definitionId).revision !== revision
      )
        throw this.adapter.error();
      await this.reconcileRecord(definitionId, true);
    }).finally(() => this.recoveries.delete(definitionId));
    this.recoveries.set(definitionId, task);
    return task;
  }

  private async reconcileRecord(definitionId: string, recovery = false): Promise<void> {
    const current = this.records.find((item) => item.definitionId === definitionId)!;
    const next = structuredClone(current);
    let policy: HostRefreshPolicy;
    try {
      policy = this.ports.policy(definitionId);
    } catch {
      if (this.adapter.refreshForHost && next.signedIn && this.isDue(next, this.ports.now())) {
        this.recordFailure(next, this.ports.now(), "policy_unavailable");
        this.commit(this.withRecord(next));
      }
      return;
    }
    applyPolicy(next, policy);
    const now = this.ports.now();
    // undefined: the Host was not read this reconcile, so there is nothing new to deliver.
    let desired: P | null | undefined = null;
    if (next.signedIn && !policy.removed) {
      desired = await this.readDueHost(next, now, recovery);
    }

    // Policy may change while storage or the official CLI is pending.
    if (this.ports.policy(definitionId).revision !== policy.revision) return;
    if (desired !== undefined) {
      this.rotate(next, desired);
      if (recovery) {
        // Reapply an acknowledged projection if a local logout removed Dev's access file.
        for (const target of next.targets) target.appliedRotation = null;
      }
    }
    // Rewrite state only when something changed; idle reconciles stay read-only.
    if (!isDeepStrictEqual(next, current)) this.commit(this.withRecord(next));
    if (desired !== undefined) await this.deliverPending(definitionId, next, desired, now);
  }

  private async readDueHost(
    next: HostRefreshRecord,
    now: number,
    recovery: boolean,
  ): Promise<P | null | undefined> {
    const due = this.isDue(next, now) || (recovery && next.refreshFailures === 0);
    // Preserve the previous deadline even if this read immediately discovers a renewed grant.
    if (next.expiresAt !== null && now >= next.expiresAt) next.missedExpiry = next.expiresAt;
    let desired: P | null | undefined;
    if (due) {
      try {
        desired = await this.readHost(next.definitionId, next, now);
      } catch {
        this.recordFailure(next, now, "storage_unreadable");
        next.checkedAt = now;
      }
    }
    const expired = next.expiresAt !== null && now >= next.expiresAt;
    if (expired && next.expiresAt !== null && next.missedExpiry !== next.expiresAt) {
      next.missedExpiry = next.expiresAt;
    }
    return desired;
  }

  /** Reads the Host grant and renews it when the provider's policy allows. */
  private async readHost(
    definitionId: string,
    next: HostRefreshRecord,
    now: number,
  ): Promise<P | null> {
    let grant = await this.ports.grant(definitionId);
    // A newer Host token (a Host agent refreshed it, or the owner signed in) clears failures.
    const recoveredRead =
      grant !== null &&
      (next.failureReason === "storage_unreadable" || next.failureReason === "grant_missing");
    if (isNewerGrant(next, grant)) {
      next.refreshFailures = 0;
      delete next.failureReason;
      delete next.refreshRetry;
    } else if (recoveredRead) {
      next.refreshFailures = next.refreshRetry?.failures ?? 0;
      if (next.refreshRetry) {
        const retry = next.refreshRetry;
        next.refresh = {
          at: retry.at,
          outcome: retry.reason === "refresh_failed" ? "failed" : "unchanged",
        };
        next.failureReason = retry.reason;
      } else delete next.failureReason;
      delete next.refreshRetry;
    }
    if (grant === null) this.recordFailure(next, now, "grant_missing");
    if (this.shouldRefresh(next, grant, now))
      grant = await this.refreshHost(definitionId, grant, next, now);
    next.checkedAt = now;
    next.expiresAt = grant?.expiresAt ?? null;
    // A failed request is not evidence of revocation. Keep the grant available to the
    // official CLI for bounded retries; only a confirmed missing grant withdraws Dev.
    const desired = this.adapter.project(grant);
    next.hostGrant = desired ? "present" : "missing";
    return desired;
  }

  private async refreshHost(
    definitionId: string,
    grant: G | null,
    next: HostRefreshRecord,
    now: number,
  ): Promise<G | null> {
    const before = grant?.expiresAt ?? null;
    let failed = false;
    try {
      await this.ports.refresh(definitionId);
    } catch {
      // The CLI can save a rotated token before the model request fails or times out.
      failed = true;
    }
    let after: G | null;
    try {
      after = await this.ports.grant(definitionId);
    } catch {
      this.recordFailure(next, now, failed ? "refresh_failed" : "storage_unreadable");
      return grant;
    }
    const advanced =
      after !== null && after.expiresAt !== null && (before === null || after.expiresAt > before);
    let outcome: "refreshed" | "failed" | "unchanged" = failed ? "failed" : "unchanged";
    if (advanced) outcome = "refreshed";
    next.refresh = { at: now, outcome };
    next.refreshFailures = advanced ? 0 : next.refreshFailures + 1;
    if (advanced) delete next.failureReason;
    else next.failureReason = failed ? "refresh_failed" : "refresh_unchanged";
    return after;
  }

  private async deliverPending(
    definitionId: string,
    next: HostRefreshRecord,
    desired: P | null,
    now: number,
  ): Promise<void> {
    for (const target of next.targets) {
      if (target.appliedRotation === next.rotation) continue;
      const delivery: HostProjectionDelivery<P> = {
        installationId: this.ports.installationId,
        serverId: target.serverId,
        definitionId,
        providerId: target.providerId,
        policyRevision: next.policyRevision,
        generation: next.generation,
        rotation: next.rotation,
        access: target.excluded ? null : desired,
      };
      try {
        const receipt = await this.ports.deliver(delivery);
        if (!projectionReceiptMatches(receipt, delivery, this.adapter.digest(delivery.access)))
          continue;
        if (this.ports.policy(definitionId).revision !== next.policyRevision) continue;
        target.appliedRotation = next.rotation;
        this.commit(this.withRecord(next));
      } catch {
        // Offline Dev keeps this rotation pending; the token is read again next time.
      }
    }
    // Back off while a rotation stays undelivered, so an offline Dev does not cause a Host
    // read (a Keychain query on macOS) every reconcile.
    const pending = next.targets.some((target) => target.appliedRotation !== next.rotation);
    const failures = pending ? next.deliveryFailures + 1 : 0;
    const retryAt = pending ? now + backoff(DELIVERY_RETRY_MS, failures) : null;
    if (failures === next.deliveryFailures && retryAt === next.deliveryRetryAt) return;
    next.deliveryFailures = failures;
    next.deliveryRetryAt = retryAt;
    this.commit(this.withRecord(next));
  }

  private replace(
    definitionId: string,
    policy: HostRefreshPolicy,
    values: { signedIn: boolean; identity: HostRefreshIdentity | null; digest: string | null },
  ): void {
    const previous = this.records.find((item) => item.definitionId === definitionId);
    const generation = (previous?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw this.adapter.error();
    this.commit(
      this.withRecord({
        definitionId,
        generation,
        rotation: 0,
        signedIn: values.signedIn,
        hostGrant: null,
        policyRevision: policy.revision,
        digest: values.digest,
        expiresAt: null,
        identity: values.identity,
        checkedAt: null,
        refresh: null,
        refreshFailures: 0,
        deliveryFailures: 0,
        deliveryRetryAt: null,
        targets: policy.targets.map((target) => ({ ...target, appliedRotation: null })),
      }),
    );
  }

  private withRecord(record: HostRefreshRecord): HostRefreshRecord[] {
    return [...this.records.filter((item) => item.definitionId !== record.definitionId), record];
  }

  private commit(next: HostRefreshRecord[]): void {
    try {
      const state: HostRefreshState = [];
      const diagnostics: HostRefreshDiagnostics = [];
      for (const record of next) {
        const { failureReason, missedExpiry, refreshRetry, ...legacy } = record;
        state.push(legacy);
        diagnostics.push({
          definitionId: record.definitionId,
          generation: record.generation,
          refreshAt: record.refresh?.at ?? null,
          refreshFailures: record.refreshFailures,
          failureReason,
          missedExpiry,
          refreshRetry,
        });
      }
      // Save evidence first. On a partial write, restore failure reasons only when their
      // generation and refresh outcome match state.json; evidence never changes authority.
      try {
        this.ports.diagnostics?.persist(diagnostics);
      } catch {
        // A sidecar outage can lose diagnostic detail, but must not stop renewal or the
        // legacy state write. Refresh counters remain durable in the authoritative state.
      }
      this.ports.persist(state);
    } catch {
      this.persistenceFailed = true;
      throw this.adapter.error();
    }
    this.records = next;
  }

  private recordFailure(
    next: HostRefreshRecord,
    now: number,
    reason: NonNullable<HostRefreshRecord["failureReason"]>,
  ): void {
    const transient = reason === "storage_unreadable" || reason === "grant_missing";
    // A later read error must not erase the CLI failure's retry budget when storage recovers.
    if (
      transient &&
      next.refresh &&
      (next.failureReason === "refresh_failed" || next.failureReason === "refresh_unchanged")
    ) {
      next.refreshRetry = {
        at: next.refresh.at,
        failures: next.refreshFailures,
        expiresAt: next.expiresAt,
        reason: next.failureReason,
      };
    }
    next.refresh = { at: now, outcome: "failed" };
    next.refreshFailures += 1;
    next.failureReason = reason;
  }

  private enqueue(definitionId: string, operation: () => Promise<void>): Promise<void> {
    const task = (this.queues.get(definitionId) ?? Promise.resolve()).then(() => {
      if (this.persistenceFailed) throw this.adapter.error();
      return operation();
    });
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(definitionId, settled);
    void settled.then(() => {
      if (this.queues.get(definitionId) === settled) this.queues.delete(definitionId);
      return undefined;
    });
    return task;
  }

  private isDue(next: HostRefreshRecord, now: number): boolean {
    if (this.adapter.refreshForHost && next.refreshFailures > 0 && next.refresh !== null)
      return now - next.refresh.at >= backoff(REFRESH_RETRY_MS, next.refreshFailures);
    if (
      this.adapter.refreshForHost &&
      next.expiresAt !== null &&
      next.expiresAt - now <= this.adapter.leadMs
    )
      return true;
    // An undelivered rotation waits for its retry time, whatever the token's expiry.
    if (next.targets.some((target) => target.appliedRotation !== next.rotation))
      return next.deliveryRetryAt === null || now >= next.deliveryRetryAt;
    if (next.checkedAt === null || now - next.checkedAt >= RECHECK_MS) return true;
    if (next.refreshFailures > 0 && next.refresh !== null)
      return now - next.refresh.at >= backoff(REFRESH_RETRY_MS, next.refreshFailures);
    return (
      next.expiresAt !== null && next.expiresAt - now <= this.adapter.leadMs + REFRESH_RETRY_MS
    );
  }

  private shouldRefresh(next: HostRefreshRecord, grant: G | null, now: number) {
    // Codex retains receipt-gated renewal. Claude also renews for enabled Host use or a
    // pending Dev delivery, so delivery outages cannot suppress renewal.
    const reachable = next.targets.some(
      (target) => !target.excluded && target.appliedRotation === next.rotation,
    );
    const policy = this.ports.policy(next.definitionId);
    if (policy.revision !== next.policyRevision || policy.removed) return false;
    const hostEligible = this.adapter.refreshForHost && policy.hostEnabled === true;
    const devEligible = this.adapter.refreshForHost
      ? next.targets.some((target) => !target.excluded)
      : reachable;
    if (!hostEligible && !devEligible) return false;
    const wait = backoff(REFRESH_RETRY_MS, next.refreshFailures);
    if (next.refresh !== null && now - next.refresh.at < wait) return false;
    return this.adapter.needsRefresh(grant, now);
  }

  /** A changed projection, including a withdrawal, takes the next rotation slot. */
  private rotate(next: HostRefreshRecord, desired: P | null): void {
    const digest = this.adapter.digest(desired);
    if (digest === next.digest) return;
    next.digest = digest;
    next.rotation += 1;
  }
}

function applyPolicy(next: HostRefreshRecord, policy: HostRefreshPolicy): void {
  if (policy.revision === next.policyRevision) return;
  next.policyRevision = policy.revision;
  next.rotation += 1;
  next.targets = policy.targets.map((target) => ({ ...target, appliedRotation: null }));
}

function backoff(base: number, failures: number): number {
  return Math.min(base * 2 ** Math.max(0, failures - 1), RECHECK_MS);
}

function isNewerGrant(next: HostRefreshRecord, grant: HostGrant | null): boolean {
  const expiresAt = next.refreshRetry?.expiresAt ?? next.expiresAt;
  return (
    grant !== null &&
    grant.expiresAt !== null &&
    (expiresAt === null || grant.expiresAt > expiresAt)
  );
}
