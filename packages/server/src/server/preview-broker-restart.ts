import { randomUUID } from "node:crypto";
import { access, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type pino from "pino";
import type { SessionCredentialKind } from "./authorization/index.js";
import { readBoundedRegularFile } from "./bounded-file-read.js";
import {
  PREVIEW_CHANNEL_DIRECTORY,
  previewServiceKey,
  type PreviewBrokerService,
  type PreviewRestartMode,
  type PreviewRestartOutcome,
} from "./preview-broker-status.js";

export type { PreviewRestartMode };

// The broker's request contract, as in docker/tailscale/preview-broker-client.mjs.
const WORKSPACE_ID = /^wks_[a-zA-Z0-9_-]{1,80}$/;
const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const RECEIPT_WAIT_MS = 90_000;
const PENDING_FOLLOW_MS = 60_000;
const POLL_MS = 500;
const STATUS_INTERVAL_MS = 2_000;
/**
 * Restarts in flight across all previews. Each can add about 30 status requests while it
 * follows its receipt, against a broker that handles 16 requests per run, so a few
 * concurrent restarts must not crowd out agents' own preview requests.
 */
const MAX_CONCURRENT_RESTARTS = 3;
/** One session may hold this many of those slots, so it cannot keep another's restart busy. */
const MAX_RESTARTS_PER_REQUESTER = 2;
const MAX_RECEIPT_BYTES = 16 * 1024;
/** A failed outcome stays visible this long unless a newer restart replaces it. */
const OUTCOME_TTL_MS = 10 * 60_000;

interface BrokerReceipt {
  status?: string;
  error?: string;
  message?: string;
}

/** A request still waiting on the broker; it holds a concurrency slot. */
function inFlightStatus(status: PreviewRestartOutcome["status"] | undefined): boolean {
  return status === "starting" || status === "stopping";
}

/**
 * Starts or restarts a managed preview through the broker's filesystem inbox, which is
 * the same broker path an agent's helper uses, so the broker keeps the HTTPS reservation
 * and enforces its own policy. It never touches Tailscale, ports or the service itself.
 * Callers authorize first; this only refuses a second restart of the same preview.
 */
export class PreviewBrokerRestarter {
  private readonly outcomes = new Map<string, PreviewRestartOutcome>();
  /** Who submitted each restart still in flight, by preview key. */
  private readonly requesters = new Map<string, string>();

  constructor(
    private readonly deps: {
      channel?: string;
      onChange: (workspaceId: string) => void;
      logger: pino.Logger;
      now?: () => number;
      pollMs?: number;
    },
  ) {}

  private get channel(): string {
    return this.deps.channel ?? PREVIEW_CHANNEL_DIRECTORY;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Whether a broker is installed here and accepting requests. */
  async available(): Promise<boolean> {
    const exists = (name: string) =>
      access(join(this.channel, name)).then(
        () => true,
        () => false,
      );
    return (await exists("installed.json")) && !(await exists("disabled.json"));
  }

  outcome(workspaceId: string, scriptName: string): PreviewRestartOutcome | null {
    const key = previewServiceKey(workspaceId, scriptName);
    const outcome = this.outcomes.get(key);
    if (
      outcome &&
      !inFlightStatus(outcome.status) &&
      this.now() - outcome.at * 1000 > OUTCOME_TTL_MS
    ) {
      this.outcomes.delete(key);
      return null;
    }
    return outcome ?? null;
  }

  inFlight(workspaceId: string, scriptName: string): boolean {
    return inFlightStatus(this.outcome(workspaceId, scriptName)?.status);
  }

  /**
   * Whether the start slots are full. Only starts count: a stop is one cheap broker request,
   * already limited to one per preview, and is never held behind queued starts.
   */
  atCapacity(requester: string): boolean {
    let running = 0;
    let mine = 0;
    for (const [key, outcome] of this.outcomes) {
      if (outcome.status !== "starting") continue;
      running += 1;
      if (this.requesters.get(key) === requester) mine += 1;
    }
    return running >= MAX_CONCURRENT_RESTARTS || mine >= MAX_RESTARTS_PER_REQUESTER;
  }

  /**
   * Submits the request and returns once it is in the inbox; the outcome follows
   * through `onChange`. Throws when the names are invalid or the inbox write fails.
   */
  async submit(
    workspaceId: string,
    scriptName: string,
    mode: PreviewRestartMode,
    requester: string,
  ): Promise<void> {
    if (!WORKSPACE_ID.test(workspaceId) || !SERVICE.test(scriptName)) {
      throw new Error("Invalid preview identity");
    }
    const key = previewServiceKey(workspaceId, scriptName);
    if (this.inFlight(workspaceId, scriptName)) throw new Error("A restart is already running");
    if (mode !== "stop" && this.atCapacity(requester)) {
      throw new Error("Too many preview restarts are running");
    }
    // Reserve the slot before any await, so concurrent submits see it: checking first and
    // recording after the inbox write let N simultaneous requests all pass the limits.
    const previous = this.outcomes.get(key);
    this.outcomes.set(key, {
      // A stop goes through the broker too, so it records as an explicit stop.
      status: mode === "stop" ? "stopping" : "starting",
      mode,
      error: null,
      at: this.now() / 1000,
    });
    this.requesters.set(key, requester);
    let id: string;
    try {
      id = await this.request(mode, workspaceId, scriptName);
    } catch (error) {
      // Nothing reached the broker: give the slot back and keep any earlier outcome.
      this.requesters.delete(key);
      if (previous) this.outcomes.set(key, previous);
      else this.outcomes.delete(key);
      throw error;
    }
    this.deps.onChange(workspaceId);
    void this.follow(key, workspaceId, scriptName, mode, id).catch((error: unknown) => {
      this.deps.logger.warn(
        { err: error, workspaceId, scriptName },
        "Preview restart follow failed",
      );
      this.record(key, workspaceId, { status: "unconfirmed", mode, error: null });
    });
  }

  private record(
    key: string,
    workspaceId: string,
    outcome: Omit<PreviewRestartOutcome, "at"> | null,
  ): void {
    if (outcome) this.outcomes.set(key, { ...outcome, at: this.now() / 1000 });
    else this.outcomes.delete(key);
    if (!inFlightStatus(outcome?.status)) this.requesters.delete(key);
    this.deps.onChange(workspaceId);
  }

  private async request(
    operation: PreviewRestartMode | "status",
    workspaceId: string,
    service: string,
  ): Promise<string> {
    const id = randomUUID();
    const body = { id, operation, workspaceId, service, createdAt: this.now() / 1000 };
    const inbox = join(this.channel, "inbox");
    const temporary = join(inbox, `.${id}`);
    await writeFile(temporary, JSON.stringify(body), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(inbox, `${id}.json`));
    return id;
  }

  private async receipt(id: string): Promise<BrokerReceipt | null> {
    const deadline = this.now() + RECEIPT_WAIT_MS;
    const path = join(this.channel, "receipts", `${id}.json`);
    while (this.now() < deadline) {
      // In Dev the receipts folder is agent-writable: a planted FIFO or device reads as absent.
      const file = await readBoundedRegularFile(path, MAX_RECEIPT_BYTES);
      if (file) {
        try {
          return JSON.parse(file.text) as BrokerReceipt;
        } catch {
          // A receipt being written, or not one: keep waiting until the deadline.
        }
      }
      await delay(this.deps.pollMs ?? POLL_MS);
    }
    return null;
  }

  private async follow(
    key: string,
    workspaceId: string,
    service: string,
    mode: PreviewRestartMode,
    id: string,
  ) {
    let result = await this.receipt(id);
    const deadline = this.now() + PENDING_FOLLOW_MS;
    // Same rule as the helper: re-ask with a new request while the broker says pending.
    while (result?.status === "pending" && this.now() < deadline) {
      await delay(this.deps.pollMs === undefined ? STATUS_INTERVAL_MS : this.deps.pollMs);
      result = await this.receipt(await this.request("status", workspaceId, service));
    }
    if (result?.status === "ready" || result?.status === "stopped") {
      this.record(key, workspaceId, null);
    } else if (result?.status === "failed") {
      const error = typeof result.error === "string" ? result.error.slice(0, 300) : null;
      this.record(key, workspaceId, { status: "failed", mode, error });
    } else {
      // No receipt, or still pending: the request may yet finish. Never replay it.
      this.record(key, workspaceId, { status: "unconfirmed", mode, error: null });
    }
  }
}

let daemonRestarter: PreviewBrokerRestarter | null = null;

/** Set once by bootstrap; sessions and projections share the daemon's single restarter. */
export function installPreviewBrokerRestarter(restarter: PreviewBrokerRestarter | null): void {
  daemonRestarter = restarter;
}

export function previewBrokerRestarter(): PreviewBrokerRestarter | null {
  return daemonRestarter;
}

export interface PreviewRestartRefusal {
  code:
    | "owner_app_only"
    | "broker_unavailable"
    | "workspace_unavailable"
    | "no_reservation"
    | "needs_review"
    | "busy"
    | "capacity";
  message: string;
}

/**
 * Who may restart a preview from the app: only a session admitted with the daemon
 * password, re-checked on every resume. This keeps out agents' CLI shells (the local
 * credential), service, hub and plugin sessions, and in Dev the container's agents.
 *
 * It is NOT proof of the owner. On the Host the daemon's password file is readable by its
 * OS user, so Host agents can learn it, and every session the Host routes to Dev arrives
 * as "password" because the Host connects to Dev with Dev's password. That is enough here
 * only because this request grants nothing an agent cannot already do through the broker
 * helper. Do not reuse this check for a more powerful request before #525 binds caller
 * identity to authenticated authority.
 */
export function admitPreviewRestart(input: {
  credential: SessionCredentialKind | null;
  restarter: Pick<PreviewBrokerRestarter, "inFlight" | "atCapacity"> | null;
  brokerAvailable: boolean;
  workspace: { archivedAt: string | null } | null;
  hasReservation: boolean;
  broker: PreviewBrokerService | null;
  workspaceId: string;
  scriptName: string;
  /** The requesting session, for its share of the restart slots. */
  requester: string;
  /** Absent means a start, as on the wire. */
  mode?: PreviewRestartMode;
}): PreviewRestartRefusal | null {
  // Stopping is always safe, so review, an archived workspace and queued starts never refuse
  // it here. The broker records the stop and withdraws the link before it looks the workspace
  // up, and reports any part it cannot finish as the outcome. A stop keeps the password gate,
  // the reservation check and the one-request-per-preview rule.
  const stop = input.mode === "stop";
  if (input.credential !== "password") {
    return { code: "owner_app_only", message: "Only the owner's app can restart a preview here" };
  }
  if (!input.restarter || !input.brokerAvailable || !input.broker) {
    return { code: "broker_unavailable", message: "The preview broker is not available" };
  }
  if (!input.workspace || (input.workspace.archivedAt && !stop)) {
    return { code: "workspace_unavailable", message: "The workspace is archived or missing" };
  }
  if (!input.hasReservation) {
    return { code: "no_reservation", message: "This service has no managed preview link" };
  }
  if (input.broker.needsReview && !stop) {
    return { code: "needs_review", message: "This preview needs administrator review" };
  }
  if (input.restarter.inFlight(input.workspaceId, input.scriptName)) {
    return { code: "busy", message: "A restart is already running" };
  }
  if (!stop && input.restarter.atCapacity(input.requester)) {
    // Its own code, so the app can say the limit is reached rather than "this one is starting".
    return { code: "capacity", message: "Too many preview restarts are running" };
  }
  return null;
}
