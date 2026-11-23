import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type pino from "pino";
import type { SessionCredentialKind } from "./authorization/index.js";
import {
  PREVIEW_CHANNEL_DIRECTORY,
  previewServiceKey,
  type PreviewBrokerService,
  type PreviewRestartOutcome,
} from "./preview-broker-status.js";

// The broker's request contract, as in docker/tailscale/preview-broker-client.mjs.
const WORKSPACE_ID = /^wks_[a-zA-Z0-9_-]{1,80}$/;
const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const RECEIPT_WAIT_MS = 90_000;
const PENDING_FOLLOW_MS = 60_000;
const POLL_MS = 500;
const STATUS_INTERVAL_MS = 2_000;
/** A failed outcome stays visible this long unless a newer restart replaces it. */
const OUTCOME_TTL_MS = 10 * 60_000;

interface BrokerReceipt {
  status?: string;
  error?: string;
  message?: string;
}

export type PreviewRestartMode = "start" | "restart";

/**
 * Starts or restarts a managed preview through the broker's filesystem inbox, which is
 * the same broker path an agent's helper uses, so the broker keeps the HTTPS reservation
 * and enforces its own policy. It never touches Tailscale, ports or the service itself.
 * Callers authorize first; this only refuses a second restart of the same preview.
 */
export class PreviewBrokerRestarter {
  private readonly outcomes = new Map<string, PreviewRestartOutcome>();

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
      outcome.status !== "starting" &&
      this.now() - outcome.at * 1000 > OUTCOME_TTL_MS
    ) {
      this.outcomes.delete(key);
      return null;
    }
    return outcome ?? null;
  }

  inFlight(workspaceId: string, scriptName: string): boolean {
    return this.outcome(workspaceId, scriptName)?.status === "starting";
  }

  /**
   * Submits the request and returns once it is in the inbox; the outcome follows
   * through `onChange`. Throws when the names are invalid or the inbox write fails.
   */
  async submit(workspaceId: string, scriptName: string, mode: PreviewRestartMode): Promise<void> {
    if (!WORKSPACE_ID.test(workspaceId) || !SERVICE.test(scriptName)) {
      throw new Error("Invalid preview identity");
    }
    const key = previewServiceKey(workspaceId, scriptName);
    if (this.inFlight(workspaceId, scriptName)) throw new Error("A restart is already running");
    const id = await this.request(mode, workspaceId, scriptName);
    this.record(key, workspaceId, { status: "starting", error: null });
    void this.follow(key, workspaceId, scriptName, id).catch((error: unknown) => {
      this.deps.logger.warn(
        { err: error, workspaceId, scriptName },
        "Preview restart follow failed",
      );
      this.record(key, workspaceId, { status: "unconfirmed", error: null });
    });
  }

  private record(
    key: string,
    workspaceId: string,
    outcome: Omit<PreviewRestartOutcome, "at"> | null,
  ): void {
    if (outcome) this.outcomes.set(key, { ...outcome, at: this.now() / 1000 });
    else this.outcomes.delete(key);
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
      try {
        return JSON.parse(await readFile(path, "utf8")) as BrokerReceipt;
      } catch {
        await delay(this.deps.pollMs ?? POLL_MS);
      }
    }
    return null;
  }

  private async follow(key: string, workspaceId: string, service: string, id: string) {
    let result = await this.receipt(id);
    const deadline = this.now() + PENDING_FOLLOW_MS;
    // Same rule as the helper: re-ask with a new request while the broker says pending.
    while (result?.status === "pending" && this.now() < deadline) {
      await delay(this.deps.pollMs === undefined ? STATUS_INTERVAL_MS : this.deps.pollMs);
      result = await this.receipt(await this.request("status", workspaceId, service));
    }
    if (result?.status === "ready") {
      this.record(key, workspaceId, null);
    } else if (result?.status === "failed") {
      const error = typeof result.error === "string" ? result.error.slice(0, 300) : null;
      this.record(key, workspaceId, { status: "failed", error });
    } else {
      // No receipt, or still pending: the request may yet finish. Never replay it.
      this.record(key, workspaceId, { status: "unconfirmed", error: null });
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
    | "busy";
  message: string;
}

/**
 * Who may restart a preview from the app. Only a session that proved the daemon password
 * qualifies: the local credential file is readable by every process of the daemon's OS
 * user, agents included, and service, hub and plugin sessions are not the owner's app.
 * Agents restart previews through the broker helper instead.
 */
export function admitPreviewRestart(input: {
  credential: SessionCredentialKind | null;
  restarter: Pick<PreviewBrokerRestarter, "inFlight"> | null;
  brokerAvailable: boolean;
  workspace: { archivedAt: string | null } | null;
  hasReservation: boolean;
  broker: PreviewBrokerService | null;
  workspaceId: string;
  scriptName: string;
}): PreviewRestartRefusal | null {
  if (input.credential !== "password") {
    return { code: "owner_app_only", message: "Only the owner's app can restart a preview here" };
  }
  if (!input.restarter || !input.brokerAvailable || !input.broker) {
    return { code: "broker_unavailable", message: "The preview broker is not available" };
  }
  if (!input.workspace || input.workspace.archivedAt) {
    return { code: "workspace_unavailable", message: "The workspace is archived or missing" };
  }
  if (!input.hasReservation) {
    return { code: "no_reservation", message: "This service has no managed preview link" };
  }
  if (input.broker.needsReview) {
    return { code: "needs_review", message: "This preview needs administrator review" };
  }
  if (input.restarter.inFlight(input.workspaceId, input.scriptName)) {
    return { code: "busy", message: "A restart is already running" };
  }
  return null;
}
