import {
  FactoryLeanViewSchema,
  type FactoryLeanStatus,
  type FactoryLeanView,
} from "@getpaseo/server/factory-lean";
import type { LeanLedger } from "./types.js";

export interface LeanViewReadiness {
  /** Installation ingress can verify owner sessions and this project's intake lane can act. */
  ownerActions: boolean;
  /** The same verified ingress has a live, authorized delivery delegate for this project. */
  deliveryActions: boolean;
}

export type LeanViewDetails = Partial<Pick<FactoryLeanView, "machines" | "previews" | "recipe">>;

/** Read-only subset of DeliveryExecutor.snapshot(). Private receipts and approval text stay local. */
export interface LeanDeliveryRun {
  id: string;
  kind: string;
  state: string;
  values: { version: string | null };
  notBefore: string | null;
  held?: boolean;
  approvalUrl?: string | null;
  waitingOn: string | null;
  failure: { kind: string; reason: string } | null;
}

export interface LeanDeliverySnapshot {
  pendingBeta: LeanDeliveryRun | null;
  active: LeanDeliveryRun | null;
  needsOwner: LeanDeliveryRun | null;
  queued: readonly LeanDeliveryRun[];
}

function deliveryQueueLine(run: LeanDeliveryRun) {
  return {
    jobId: run.id,
    kind: run.kind === "beta" ? "cut-beta" : run.kind,
    state: run.state,
    version: run.values.version,
    waitingOn: run.waitingOn,
  };
}

function deliveryLine(run: LeanDeliveryRun) {
  return {
    ...deliveryQueueLine(run),
    approvalUrl: run.approvalUrl ?? null,
    failureKind: run.failure?.kind ?? null,
    failureReason: run.failure?.reason ?? null,
  };
}

function describePendingBeta(pending: LeanDeliveryRun | null | undefined) {
  if (!pending?.notBefore) return null;
  return {
    eventId: pending.id,
    version: pending.values.version,
    shipsAt: pending.notBefore,
    held: pending.held ?? false,
  };
}

type ViewLedger = Pick<LeanLedger, "delivery" | "releases">;

function describeDeliveryLock(lock: ViewLedger["delivery"]["lock"], installation: string) {
  if (!lock) return null;
  const { holder } = lock;
  const holderInfo =
    "kind" in holder
      ? { kind: "executor" as const, installationId: holder.installation }
      : {
          kind: "runner" as const,
          agentId: holder.agentId,
          ...(holder.serverId === null ? { installationId: installation } : {}),
        };
  return {
    holder: holderInfo.kind === "executor" ? holderInfo.installationId : holderInfo.agentId,
    holderInfo,
    batch: lock.job.id,
    expiresAt: lock.expiresAt,
  };
}

export function createLeanView(input: {
  status: FactoryLeanStatus;
  ledger: ViewLedger;
  readiness: LeanViewReadiness;
  details?: LeanViewDetails | null;
  deliverySnapshot?: LeanDeliverySnapshot | null;
}): FactoryLeanView {
  const { status, ledger, details, readiness, deliverySnapshot } = input;
  const run =
    deliverySnapshot?.needsOwner ?? deliverySnapshot?.active ?? deliverySnapshot?.queued[0];
  const delivery = run ? deliveryLine(run) : null;
  const events = [...ledger.releases].sort(
    (first, second) =>
      Date.parse(second.at) - Date.parse(first.at) || second.id.localeCompare(first.id),
  );
  const production =
    events.find(
      (event) =>
        event.channel === "stable" && (event.kind === "promote" || event.kind === "rollback"),
    ) ?? null;
  const betas = events.filter((event) => event.channel === "beta" && event.kind === "beta");
  const earlier = events.filter(
    (event) => event !== production && !(event.channel === "beta" && event.kind === "beta"),
  );
  const deliveryLock = describeDeliveryLock(ledger.delivery.lock, status.installation);
  return FactoryLeanViewSchema.parse({
    readiness,
    pendingBeta: describePendingBeta(deliverySnapshot?.pendingBeta),
    delivery,
    deliveryQueue: deliverySnapshot?.queued.map(deliveryQueueLine) ?? [],
    production,
    betas,
    earlier,
    inFlight: status.issues.filter(({ stage }) => stage !== "merged"),
    machines: details?.machines ?? [],
    previews: details?.previews ?? [],
    health: { alerts: status.alerts, deliveryLock },
    recipe: details?.recipe ?? {
      valid: false,
      error: "A release recipe has not been verified on this daemon.",
    },
  });
}
