import type {
  FACTORY_CONFIG_PATH,
  FactoryActivityEntry,
  FactoryLeanStatus,
  FactoryLeanView,
} from "../../../../../../plugins/factory/shared/lean";
import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import type { FactoryInvoke } from "../queue";

/**
 * The one place the app touches lean Factory RPCs. Views and models read the shapes below, so
 * wiring to the daemon, or reconciling with a revised contract, is an edit to this file only.
 * React hooks over it live in lean-factory-queries.ts and hold no wire knowledge.
 *
 * Types marked "pending contract" use the names the spine agreed on November 27 but are not in
 * the shared contract yet. They are optional on the wire: until a daemon sends them, the mapping
 * below leaves them null and the views that depend on them render nothing.
 */

/** The daemon capability that serves `factory.lean.*`. */
export const FACTORY_LEAN_FEATURE = "factoryLean" as const;

/**
 * Whether lean views apply: the daemon advertises `factoryLean` and this project runs in lean
 * mode. Every installed daemon today advertises neither, so the app stays exactly as it is.
 */
export function isLeanFactory(
  features: Record<string, unknown> | null | undefined,
  state: Pick<ProjectFactoryState, "mode"> | undefined,
): boolean {
  return features?.[FACTORY_LEAN_FEATURE] === true && state?.mode === "lean";
}

/** Pending contract: the beta notice the owner can hold before a beta resets occupied rooms. */
export interface LeanPendingBeta {
  eventId: string;
  version: string;
  /** When it ships unless held; the default notice is 10 minutes. */
  shipsAt: string;
  held: boolean;
}

/** The delivery executor's current job: in the contract, plus pending fields marked below. */
export interface LeanDelivery {
  /** "pending" | "running" | "awaiting-approval" | "verifying" | "delivered" | "failed" */
  state: string;
  jobId: string;
  /** The executor's run kinds: "beta" | "promote" | "rollback" */
  kind: string;
  version: string | null;
  approvalUrl: string | null;
  /** Pending contract: why the run is not moving, in the executor's own words. */
  waitingOn: string | null;
  /** Pending contract: "step-failed" | "unknown" | "refused" | "cancelled", or null. */
  failureKind: string | null;
  /** Pending contract: the executor's sentence the owner can act on. */
  failureReason: string | null;
}

/** Pending contract: one unfinished delivery run, oldest first. */
export interface LeanQueuedDelivery {
  jobId: string;
  kind: string;
  state: string;
  version: string | null;
  waitingOn: string | null;
}

/** The executor's choices for a run whose step failed or whose outcome is unknown. */
export const LEAN_RESOLVE_ACTIONS = ["verify-only", "rerun", "abandon"] as const;
export type LeanResolveAction = (typeof LEAN_RESOLVE_ACTIONS)[number];

/** Pending contract: `health.deliveryLock.holderInfo`, beside the legacy `holder` string. */
export interface LeanDeliveryHolder {
  kind: "executor" | "runner";
  agentId?: string;
  installationId?: string;
}

/**
 * Pending contract `view.readiness`. `factoryLean` advertises reading only; each flag is false,
 * and absent means false, until the daemon has a verified owner route or a wired executor.
 */
export interface LeanReadiness {
  ownerActions: boolean;
  deliveryActions: boolean;
}

export type LeanView = Omit<FactoryLeanView, "health"> & {
  /** Pending contract. */
  readiness: LeanReadiness;
  health: {
    alerts: string[];
    deliveryLock: { holder: LeanDeliveryHolder; batch: string; expiresAt: string } | null;
  };
  /** Pending contract. */
  pendingBeta: LeanPendingBeta | null;
  delivery: LeanDelivery | null;
  /** Pending contract: every unfinished delivery run, oldest first. */
  deliveryQueue: LeanQueuedDelivery[];
};

export type LeanStatus = FactoryLeanStatus;
export type LeanActivityEntry = FactoryActivityEntry;

/** The repository config path; a runtime copy, checked against the contract's constant. */
export const FACTORY_CONFIG_FILE = ".github/vorteo-factory.json";
const sameConfigPath: typeof FACTORY_CONFIG_PATH = FACTORY_CONFIG_FILE;
void sameConfigPath;

/** Pending contract: the config key `builder.provider`, which provider builds issues. */
export const LEAN_BUILDER_PROVIDER_KEY = ["builder", "provider"] as const;

export interface LeanConfigRead {
  /** The raw file text, or null when the repository has none yet. */
  file: string | null;
  commit: string | null;
  installations: { id: string; friendlyName: string | null }[];
}

interface Refusal {
  refused: string;
}
export type LeanWriteResult<T> = T | Refusal;

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && "refused" in value;
}

function mapHolder(
  legacy: string,
  info: Partial<LeanDeliveryHolder> | undefined,
): LeanDeliveryHolder {
  // A daemon without holderInfo names only an installation: no runner the owner can open.
  if (!info) return { kind: "executor", installationId: legacy };
  const holder = info;
  return {
    kind: holder.kind === "runner" ? "runner" : "executor",
    agentId: holder.agentId,
    installationId: holder.installationId,
  };
}

/** Maps a wire view, including the pending-contract fields a newer daemon may add. */
export function mapLeanView(raw: FactoryLeanView): LeanView {
  const extra = raw as FactoryLeanView & {
    pendingBeta?: LeanPendingBeta | null;
    delivery?: WireDelivery | null;
    deliveryQueue?: Partial<LeanQueuedDelivery>[];
    readiness?: Partial<LeanReadiness>;
  };
  const lock = raw.health.deliveryLock as
    | (NonNullable<FactoryLeanView["health"]["deliveryLock"]> & {
        holderInfo?: Partial<LeanDeliveryHolder>;
      })
    | null;
  return {
    ...raw,
    health: {
      alerts: raw.health.alerts,
      deliveryLock: lock
        ? {
            batch: lock.batch,
            expiresAt: lock.expiresAt,
            holder: mapHolder(lock.holder, lock.holderInfo),
          }
        : null,
    },
    readiness: {
      ownerActions: extra.readiness?.ownerActions === true,
      deliveryActions: extra.readiness?.deliveryActions === true,
    },
    pendingBeta: extra.pendingBeta ?? null,
    delivery: extra.delivery ? mapDelivery(extra.delivery) : null,
    deliveryQueue: (extra.deliveryQueue ?? []).flatMap((run) =>
      run.jobId
        ? [
            {
              jobId: run.jobId,
              kind: run.kind ?? "",
              state: run.state ?? "",
              version: run.version ?? null,
              waitingOn: run.waitingOn ?? null,
            },
          ]
        : [],
    ),
  };
}

/**
 * The delivery as a daemon may send it. The failure names are unconfirmed: this accepts the
 * flat `failureKind` the spine described and the executor's own `failure { kind, reason }`.
 */
type WireDelivery = Omit<LeanDelivery, "waitingOn" | "failureKind" | "failureReason"> & {
  waitingOn?: string | null;
  failureKind?: string | null;
  failure?: { kind?: string; reason?: string } | null;
};

function mapDelivery(raw: WireDelivery): LeanDelivery {
  return {
    state: raw.state,
    jobId: raw.jobId,
    kind: raw.kind,
    version: raw.version,
    approvalUrl: raw.approvalUrl,
    waitingOn: raw.waitingOn ?? null,
    failureKind: raw.failureKind ?? raw.failure?.kind ?? null,
    failureReason: raw.failure?.reason ?? null,
  };
}

export const leanQueryKeys = {
  status: (serverId: string, projectId: string) => ["factoryLeanStatus", serverId, projectId],
  view: (serverId: string, projectId: string) => ["factoryLeanView", serverId, projectId],
  activity: (serverId: string, projectId: string) => ["factoryLeanActivity", serverId, projectId],
  config: (serverId: string, projectId: string) => ["factoryLeanConfig", serverId, projectId],
};

export function createLeanSource(invoke: FactoryInvoke, projectId: string) {
  return {
    status: async () => (await invoke("factory.lean.status", { projectId })) as LeanStatus,
    view: async () =>
      mapLeanView((await invoke("factory.lean.view", { projectId })) as FactoryLeanView),
    activity: async (limit = 50) =>
      (await invoke("factory.lean.activity.list", { projectId, limit })) as {
        entries: LeanActivityEntry[];
        nextBefore: string | null;
      },
    promote: async (eventId: string, expectedProduction: string | null) =>
      (await invoke("factory.lean.releases.promote", {
        projectId,
        eventId,
        expectedProduction,
      })) as LeanWriteResult<{ queued: true; jobId: string }>,
    rollback: async (targetEventId: string, expectedProduction: string) =>
      (await invoke("factory.lean.releases.rollback", {
        projectId,
        targetEventId,
        expectedProduction,
      })) as LeanWriteResult<{ queued: true; jobId: string }>,
    /** Pending contract: holds a pending beta past its notice. */
    holdBeta: async (eventId: string) =>
      (await invoke("factory.lean.releases.hold", { projectId, eventId })) as LeanWriteResult<{
        held: boolean;
      }>,
    /** Pending contract: lets a held beta ship. */
    releaseBeta: async (eventId: string) =>
      (await invoke("factory.lean.releases.release", { projectId, eventId })) as LeanWriteResult<{
        held: boolean;
      }>,
    config: async (): Promise<LeanConfigRead> => {
      const raw = (await invoke("factory.lean.config.read", { projectId })) as {
        file: string | null;
        commit: string | null;
        installations: { id: string; friendlyName: string | null }[];
      };
      return {
        file: raw.file,
        commit: raw.commit,
        installations: raw.installations.map(({ id, friendlyName }) => ({ id, friendlyName })),
      };
    },
    /**
     * Pending contract, name unconfirmed: settles a failed or unknown-outcome delivery with one
     * of the executor's choices. Owner-only.
     */
    resolveDelivery: async (jobId: string, action: LeanResolveAction) =>
      (await invoke("factory.lean.delivery.resolve", {
        projectId,
        jobId,
        action,
      })) as LeanWriteResult<{ resolved: boolean }>,
    proposeConfig: async (baseCommit: string, content: string) =>
      (await invoke("factory.lean.config.propose", {
        projectId,
        baseCommit,
        content,
      })) as LeanWriteResult<{ pullRequest: number; url: string }>,
  };
}
export type LeanSource = ReturnType<typeof createLeanSource>;
