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
 * Types derive from the shared contract in plugins/factory/shared/lean.ts. Fields a daemon may
 * omit are resolved to defaults here, so views read one shape whatever the daemon's age.
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

type WireView = FactoryLeanView;

/**
 * The beta in its notice window, which the owner can hold before it resets occupied rooms. Its
 * version is null until the release tool has run; the interface calls it the next beta.
 */
export type LeanPendingBeta = NonNullable<WireView["pendingBeta"]>;

/** One unfinished delivery run, oldest first, with why it is not moving. */
export type LeanQueuedDelivery = NonNullable<WireView["deliveryQueue"]>[number];

/** The delivery executor's current run, with its optional fields made explicit. */
export interface LeanDelivery {
  /** "pending" | "running" | "awaiting-approval" | "verifying" | "delivered" | "failed" */
  state: string;
  jobId: string;
  /** The executor's run kinds: "beta" | "promote" | "rollback" */
  kind: string;
  version: string | null;
  approvalUrl: string | null;
  waitingOn: string | null;
  /** "step-failed" | "unknown" | "refused" | "cancelled", or null. */
  failureKind: string | null;
  /** The executor's sentence the owner can act on. */
  failureReason: string | null;
}

/** The executor's choices for a run whose step failed or whose outcome is unknown. */
export const LEAN_RESOLVE_ACTIONS = ["verify-only", "rerun", "abandon"] as const;
export type LeanResolveAction = (typeof LEAN_RESOLVE_ACTIONS)[number];

type WireLock = NonNullable<WireView["health"]["deliveryLock"]>;
/** Who holds the delivery lock: `holderInfo`, or the legacy `holder` string as the executor. */
export type LeanDeliveryHolder = NonNullable<WireLock["holderInfo"]>;

/**
 * Whether the daemon takes owner actions now. `factoryLean` advertises reading only; an absent
 * `readiness` means neither, until the daemon has a verified owner route or a wired executor.
 */
export type LeanReadiness = NonNullable<WireView["readiness"]>;

/** The view with optional fields resolved to their defaults, so views never branch on absence. */
export type LeanView = Omit<
  WireView,
  "health" | "readiness" | "pendingBeta" | "delivery" | "deliveryQueue"
> & {
  readiness: LeanReadiness;
  health: {
    alerts: string[];
    deliveryLock: { holder: LeanDeliveryHolder; batch: string; expiresAt: string } | null;
  };
  pendingBeta: LeanPendingBeta | null;
  delivery: LeanDelivery | null;
  deliveryQueue: LeanQueuedDelivery[];
};

export type LeanStatus = FactoryLeanStatus;
type IssueLine = LeanStatus["issues"][number];
/** One runner on an issue, with where it runs: `installation` and `friendlyName`. */
export type LeanRunnerRef = NonNullable<IssueLine["runner"]>;

/** Every active runner on an issue: `runners`, or the single legacy `runner` from older daemons. */
export function issueRunners(line: Pick<IssueLine, "runner" | "runners">): LeanRunnerRef[] {
  if (line.runners) return line.runners;
  return line.runner ? [line.runner] : [];
}
export type LeanActivityEntry = FactoryActivityEntry;

/** The repository config path; a runtime copy, checked against the contract's constant. */
export const FACTORY_CONFIG_FILE = ".github/vorteo-factory.json";
const sameConfigPath: typeof FACTORY_CONFIG_PATH = FACTORY_CONFIG_FILE;
void sameConfigPath;

/** The config key `builder.provider`, which provider builds issues. */
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

function mapHolder(legacy: string, info: LeanDeliveryHolder | undefined): LeanDeliveryHolder {
  // A daemon without holderInfo names only an installation: no runner the owner can open.
  return info ?? { kind: "executor", installationId: legacy };
}

type WireDelivery = NonNullable<WireView["delivery"]>;

function mapDelivery(raw: WireDelivery): LeanDelivery {
  return {
    state: raw.state,
    jobId: raw.jobId,
    kind: raw.kind,
    version: raw.version,
    approvalUrl: raw.approvalUrl,
    waitingOn: raw.waitingOn ?? null,
    failureKind: raw.failureKind ?? null,
    failureReason: raw.failureReason ?? null,
  };
}

/** Maps a wire view, resolving every optional field to its default. */
export function mapLeanView(raw: FactoryLeanView): LeanView {
  const lock = raw.health.deliveryLock;
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
      ownerActions: raw.readiness?.ownerActions === true,
      deliveryActions: raw.readiness?.deliveryActions === true,
    },
    pendingBeta: raw.pendingBeta ?? null,
    delivery: raw.delivery ? mapDelivery(raw.delivery) : null,
    deliveryQueue: raw.deliveryQueue ?? [],
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
    /** Owner-only: holds a pending beta past its notice. */
    holdBeta: async (eventId: string) =>
      (await invoke("factory.lean.releases.hold", { projectId, eventId })) as LeanWriteResult<{
        held: boolean;
      }>,
    /** Owner-only: lets a held beta ship. */
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
     * Owner-only, through the verified owner ingress: settles a failed or unknown-outcome
     * delivery with one of the executor's choices.
     */
    resolveDelivery: async (jobId: string, action: LeanResolveAction) =>
      (await invoke("factory.lean.delivery.resolve", {
        projectId,
        jobId,
        action,
      })) as LeanWriteResult<{ resolved: true }>,
    proposeConfig: async (baseCommit: string, content: string) =>
      (await invoke("factory.lean.config.propose", {
        projectId,
        baseCommit,
        content,
      })) as LeanWriteResult<{ pullRequest: number; url: string }>,
  };
}
export type LeanSource = ReturnType<typeof createLeanSource>;
