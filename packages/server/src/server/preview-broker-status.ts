import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { WorkspaceScriptPreview } from "@getpaseo/protocol/messages";

/**
 * The broker's channel. On the Host it is mode 0700 and owned by the daemon's OS user. In
 * Dev it sits in the container's home, so container agents can read, rewrite or replace
 * anything in it: treat what is read here as display data only, never as authority.
 */
export const PREVIEW_CHANNEL_DIRECTORY = join(homedir(), ".local/share/paseo-preview/https");

/** Older than this, a running preview's state is not current. */
const STALE_AFTER_SECONDS = 60;
const STOP_REASONS = new Set([
  "stopped",
  "exited",
  "daemon_restart",
  "config_changed",
  "process_changed",
  "workspace_unavailable",
]);
/** Broker messages are short plain sentences; anything else (a link, markup) is not shown. */
const PLAIN_ERROR = /^[A-Za-z0-9 ;:,.'()_-]{1,160}$/;
/** The broker holds at most 32 reservations; this bounds a file the daemon does not own. */
const MAX_STATUS_BYTES = 256 * 1024;

const seconds = z.number().finite().nonnegative();
const brokerServiceSchema = z.object({
  workspaceId: z.string(),
  service: z.string(),
  desired: z.string().optional(),
  status: z.string().optional(),
  stopReason: z.string().optional(),
  stoppedAt: seconds.optional(),
  restartedAt: seconds.optional(),
  verifiedAt: seconds.optional(),
  checkedAt: seconds.optional(),
  needsReview: z.boolean().optional(),
  error: z.string().max(300).optional(),
});
const brokerStatusSchema = z.object({
  version: z.literal(1),
  publishedAt: seconds,
  services: z.array(z.unknown()).max(64),
});

export type PreviewBrokerService = z.infer<typeof brokerServiceSchema>;

export interface PreviewBrokerStatus {
  /** The broker finished a run; says nothing about whether entries were rechecked. */
  publishedAt: number;
  services: Map<string, PreviewBrokerService>;
}

export function previewServiceKey(workspaceId: string, service: string): string {
  return `${workspaceId}.${service}`;
}

let cached: { file: string; stamp: string; status: PreviewBrokerStatus | null } | null = null;

/**
 * The broker's published state from `preview-status.json`, or null when no broker
 * publishes it (not installed, or older than #586) or the file is unreadable. Cached
 * by modification time and size, so callers may read it on every projection.
 */
export async function readPreviewBrokerStatus(
  file = join(PREVIEW_CHANNEL_DIRECTORY, "preview-status.json"),
): Promise<PreviewBrokerStatus | null> {
  let stamp: string;
  try {
    const info = await stat(file);
    if (info.size > MAX_STATUS_BYTES) return null;
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
  if (cached?.file === file && cached.stamp === stamp) return cached.status;
  let status: PreviewBrokerStatus | null = null;
  try {
    status = parsePreviewBrokerStatus(JSON.parse(await readFile(file, "utf8")));
  } catch {
    status = null;
  }
  cached = { file, stamp, status };
  return status;
}

function parsePreviewBrokerStatus(json: unknown): PreviewBrokerStatus | null {
  const parsed = brokerStatusSchema.safeParse(json);
  if (!parsed.success) return null;
  const services = new Map<string, PreviewBrokerService>();
  for (const candidate of parsed.data.services) {
    // One malformed entry hides only itself.
    const entry = brokerServiceSchema.safeParse(candidate);
    if (entry.success) {
      services.set(previewServiceKey(entry.data.workspaceId, entry.data.service), entry.data);
    }
  }
  return { publishedAt: parsed.data.publishedAt, services };
}

export interface PreviewRestartOutcome {
  status: "starting" | "failed" | "unconfirmed";
  error: string | null;
  at: number;
}

const iso = (value: number | undefined): string | null =>
  value === undefined || value <= 0 ? null : new Date(value * 1000).toISOString();

/**
 * One rule for what the owner sees, shared by the scripts list and restart checks.
 * "stopped" comes from the broker's intent or a stopped service; "not_responding" is a
 * preview the broker still wants running whose checks time out or whose server refuses
 * connections. The broker's reason is passed through only as recorded: the daemon never
 * infers a cause of its own.
 */
interface PreviewProjectionInput {
  broker: PreviewBrokerService;
  publishedAt: number;
  lifecycle: "running" | "stopped";
  health: "healthy" | "unhealthy" | null;
  restart: PreviewRestartOutcome | null;
  nowSeconds: number;
}

function previewState(input: PreviewProjectionInput): string {
  const { broker, restart } = input;
  const wantsRunning = broker.desired === "running";
  if (restart?.status === "starting" || (wantsRunning && broker.status === "pending")) {
    return "starting";
  }
  if (!wantsRunning || input.lifecycle !== "running") return "stopped";
  if (broker.status === "ready" && input.health !== "unhealthy") return "ready";
  return "not_responding";
}

/** The recorded cause and times of a stop the broker made; none for any other state. */
function stopDetails(broker: PreviewBrokerService): Partial<WorkspaceScriptPreview> {
  const reason =
    broker.stopReason && STOP_REASONS.has(broker.stopReason) ? broker.stopReason : null;
  return {
    ...(reason ? { stopReason: reason } : {}),
    stoppedAt: iso(broker.stoppedAt),
    ...(reason === "daemon_restart" ? { restartedAt: iso(broker.restartedAt) } : {}),
  };
}

function restartDetails(restart: PreviewRestartOutcome | null): Partial<WorkspaceScriptPreview> {
  if (!restart) return {};
  return {
    restart: {
      status: restart.status,
      error: restart.error,
      at: new Date(restart.at * 1000).toISOString(),
    },
  };
}

/**
 * One rule for what the owner sees, shared by the scripts list and restart checks.
 * "stopped" comes from the broker's intent or a stopped service; "not_responding" is a
 * preview the broker still wants running whose checks time out or whose server refuses
 * connections. Only causes the broker recorded, from a known set, are passed through:
 * the daemon never infers one, and a forged Dev file cannot add one.
 */
export function projectWorkspaceScriptPreview(
  input: PreviewProjectionInput,
): WorkspaceScriptPreview {
  const { broker } = input;
  const state = previewState(input);
  const wantsRunning = broker.desired === "running";
  // A stopped preview needs no recheck; a running one is current only while the broker
  // runs and has visited this entry recently. checkedAt marks a visit, not a success.
  const stale =
    input.nowSeconds - input.publishedAt > STALE_AFTER_SECONDS ||
    (wantsRunning && input.nowSeconds - (broker.checkedAt ?? 0) > STALE_AFTER_SECONDS);
  const showError =
    Boolean(broker.error) && state !== "ready" && PLAIN_ERROR.test(broker.error ?? "");
  return {
    state,
    ...(state === "stopped" && !wantsRunning ? stopDetails(broker) : {}),
    checkedAt: iso(broker.checkedAt),
    stale,
    ...(broker.needsReview ? { needsReview: true } : {}),
    ...(showError ? { error: broker.error } : {}),
    ...restartDetails(input.restart),
  };
}

/**
 * Polls the broker's status file and reports workspaces whose preview state changed,
 * including a status going stale, so clients learn of stops without a health probe.
 */
export function watchPreviewBrokerStatus(options: {
  onWorkspaceChanged: (workspaceId: string) => void;
  intervalMs?: number;
  read?: () => Promise<PreviewBrokerStatus | null>;
  nowSeconds?: () => number;
}): () => void {
  const read = options.read ?? (() => readPreviewBrokerStatus());
  const nowSeconds = options.nowSeconds ?? (() => Date.now() / 1000);
  let previous: Map<string, string> | null = null;
  const check = async () => {
    const status = await read();
    const next = new Map<string, string>();
    if (status) {
      const now = nowSeconds();
      const stale = now - status.publishedAt > STALE_AFTER_SECONDS;
      for (const entry of status.services.values()) {
        const entryStale = stale || now - (entry.checkedAt ?? 0) > STALE_AFTER_SECONDS;
        // checkedAt moves every cycle; only what the owner would see changes the digest.
        const { checkedAt: _checkedAt, ...shown } = entry;
        const digest = `${next.get(entry.workspaceId) ?? ""}|${JSON.stringify(shown)}:${entryStale}`;
        next.set(entry.workspaceId, digest);
      }
    }
    // The first read is the baseline: clients already get full state when they connect.
    if (previous) {
      for (const workspaceId of new Set([...previous.keys(), ...next.keys()])) {
        if (previous.get(workspaceId) !== next.get(workspaceId)) {
          options.onWorkspaceChanged(workspaceId);
        }
      }
    }
    previous = next;
  };
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void check().finally(() => {
      running = false;
    });
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
