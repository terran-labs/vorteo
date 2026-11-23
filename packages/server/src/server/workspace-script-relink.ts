// Re-links workspace services whose terminals survived a daemon replacement.
//
// A service runs in a terminal of the terminal worker, which outlives the daemon. The script
// state that ties the terminal to its workspace script lives in daemon memory, so the daemon
// keeps a durable record of its running services and, at start, re-links each one it can prove
// it launched. See docs/terminal-worker.md, "Workspace services across a restart".
//
// The record lives in $PASEO_HOME. On a Host that is outside every guest-writable mount. On Dev
// the home is agent-writable, so the record is treated as untrusted input: a forged entry can
// at most re-link a terminal that already carries that script's workspace, name and directory
// under the verified worker, and stop one only in a workspace that is archived or gone, which
// archiving does to every terminal in it anyway.

import { createHash } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import type { TerminalSession } from "../terminal/terminal.js";
import type { TerminalWorkerIdentity } from "../terminal/terminal-worker-pool.js";
import { readBoundedRegularFile } from "./bounded-file-read.js";
import { writePrivateFileAtomic } from "./private-files.js";

export const SURVIVING_SERVICES_FILE = "workspace-script-terminals.json";
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_SERVICES = 256;

const TerminalWorkerIdentitySchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1).max(200),
});

const SurvivingServiceSchema = z.object({
  terminalId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(4096),
  scriptName: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4096),
  port: z.number().int().min(1).max(65535),
  projectSlug: z.string().max(400),
  branchName: z.string().max(400).nullable(),
  scriptConfig: z.string().regex(/^[0-9a-f]{64}$/),
  worker: TerminalWorkerIdentitySchema,
});

const SurvivingServicesRecordSchema = z.object({
  version: z.literal(1),
  services: z.array(SurvivingServiceSchema).max(MAX_SERVICES),
});

export type SurvivingService = z.infer<typeof SurvivingServiceSchema>;

export interface AdoptedTerminals {
  getTerminal(terminalId: string): TerminalSession | undefined;
  /** The verified identity of the worker that runs the terminal, or null when unknown. */
  workerIdentityOf(terminalId: string): TerminalWorkerIdentity | null;
}

export interface SurvivorWorkspace {
  cwd: string;
  archived: boolean;
}

export interface SurvivorScript {
  scriptConfig: string;
  fixedPort: number | null;
}

export type SurvivorDecision =
  | {
      action: "relink";
      service: SurvivingService;
      terminal: TerminalSession;
      fixedPort: number | null;
    }
  | { action: "stop"; service: SurvivingService; reason: "workspace_unavailable" }
  | {
      action: "leave";
      service: SurvivingService;
      reason: "not_proven" | "workspace_changed" | "script_changed" | "duplicate";
    }
  | { action: "gone"; service: SurvivingService };

export function survivorKey(service: Pick<SurvivingService, "workspaceId" | "scriptName">): string {
  return `${service.workspaceId}\u0000${service.scriptName}`;
}

export function hashScriptConfig(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/**
 * Whether the adopted terminal is the one this daemon launched for the service: the recorded
 * terminal id runs under the same verified worker (pid and birth time), with the workspace,
 * name and directory the launcher gave it. Name, port or directory alone never prove it.
 */
function isProven(
  service: SurvivingService,
  terminal: TerminalSession,
  worker: TerminalWorkerIdentity | null,
): boolean {
  if (!worker) return false;
  const sameWorker =
    worker.pid === service.worker.pid && worker.startedAt === service.worker.startedAt;
  const sameTerminal =
    terminal.workspaceId === service.workspaceId &&
    terminal.name === service.scriptName &&
    terminal.cwd === service.cwd;
  return sameWorker && sameTerminal;
}

/**
 * One decision per recorded service. Only a proven terminal is ever stopped or re-linked; it is
 * stopped only when its workspace is archived or gone. Everything else is left running.
 */
export function decideSurvivors(input: {
  services: readonly SurvivingService[];
  terminals: AdoptedTerminals;
  workspaces: ReadonlyMap<string, SurvivorWorkspace | null>;
  scripts: ReadonlyMap<string, SurvivorScript | null>;
}): SurvivorDecision[] {
  const relinked = new Set<string>();
  return input.services.map((service): SurvivorDecision => {
    const terminal = input.terminals.getTerminal(service.terminalId);
    if (!terminal) return { action: "gone", service };
    if (!isProven(service, terminal, input.terminals.workerIdentityOf(service.terminalId))) {
      return { action: "leave", service, reason: "not_proven" };
    }
    const workspace = input.workspaces.get(service.workspaceId) ?? null;
    if (!workspace || workspace.archived) {
      return { action: "stop", service, reason: "workspace_unavailable" };
    }
    if (workspace.cwd !== service.cwd) {
      return { action: "leave", service, reason: "workspace_changed" };
    }
    const script = input.scripts.get(survivorKey(service)) ?? null;
    if (!script || script.scriptConfig !== service.scriptConfig) {
      return { action: "leave", service, reason: "script_changed" };
    }
    if (relinked.has(survivorKey(service))) {
      return { action: "leave", service, reason: "duplicate" };
    }
    relinked.add(survivorKey(service));
    return { action: "relink", service, terminal, fixedPort: script.fixedPort };
  });
}

/** The recorded services, or none when the record is missing, linked, oversized or invalid. */
export async function readSurvivingServices(
  recordPath: string,
  logger: pino.Logger,
): Promise<SurvivingService[]> {
  const file = await readBoundedRegularFile(recordPath, MAX_RECORD_BYTES);
  if (!file) return [];
  let json: unknown;
  try {
    json = JSON.parse(file.text);
  } catch {
    logger.warn({ recordPath }, "Ignoring unreadable workspace service record");
    return [];
  }
  const parsed = SurvivingServicesRecordSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ recordPath }, "Ignoring invalid workspace service record");
    return [];
  }
  return parsed.data.services;
}

/** Serializes record writes so the last state wins. */
export function createSurvivingServicesWriter(input: {
  recordPath: string;
  logger: pino.Logger;
}): (services: SurvivingService[]) => void {
  let queue: Promise<void> = Promise.resolve();
  let last: string | null = null;
  return (services) => {
    const text = `${JSON.stringify({ version: 1, services: services.slice(0, MAX_SERVICES) })}\n`;
    if (text === last) return;
    last = text;
    queue = queue
      .then(() => writePrivateFileAtomic(input.recordPath, text))
      .catch((error: unknown) => {
        input.logger.warn({ err: error }, "Cannot write workspace service record");
      });
  };
}

class RelinkDeadlineError extends Error {}

/**
 * Reads the record, looks up each service's workspace and script within `deadlineMs`, then
 * re-links or stops what it proved. Past the deadline nothing is re-linked or stopped and the
 * daemon starts as before: those services show as stopped and keep running unlinked.
 */
export async function relinkWorkspaceScripts(input: {
  recordPath: string;
  terminals: AdoptedTerminals;
  lookupWorkspace(workspaceId: string): Promise<SurvivorWorkspace | null>;
  readScript(cwd: string, scriptName: string): Promise<SurvivorScript | null>;
  restore(decision: Extract<SurvivorDecision, { action: "relink" }>): void;
  stopTerminal(terminalId: string): Promise<void>;
  deadlineMs: number;
  logger: pino.Logger;
}): Promise<SurvivorDecision[]> {
  const { logger } = input;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RelinkDeadlineError()), input.deadlineMs);
  });
  let decisions: SurvivorDecision[];
  try {
    decisions = await Promise.race([gatherDecisions(input), deadline]);
  } catch (error) {
    if (!(error instanceof RelinkDeadlineError)) throw error;
    logger.warn(
      { deadlineMs: input.deadlineMs },
      "Workspace service re-link timed out; surviving services stay running unlinked",
    );
    return [];
  } finally {
    clearTimeout(timer);
  }

  for (const decision of decisions) {
    const fields = {
      terminalId: decision.service.terminalId,
      workspaceId: decision.service.workspaceId,
      scriptName: decision.service.scriptName,
    };
    if (decision.action === "relink") {
      // One service's route or port conflict must not keep the others, or the daemon, down.
      try {
        input.restore(decision);
        logger.info(fields, "Re-linked a workspace service that survived the daemon");
      } catch (error) {
        logger.warn({ ...fields, err: error }, "Cannot re-link a surviving workspace service");
      }
    } else if (decision.action === "stop") {
      logger.info(fields, "Stopping a surviving workspace service; its workspace is unavailable");
      void input.stopTerminal(decision.service.terminalId).catch((error: unknown) => {
        logger.warn({ ...fields, err: error }, "Cannot stop a surviving workspace service");
      });
    } else if (decision.action === "leave") {
      logger.warn(
        { ...fields, reason: decision.reason },
        "Leaving a surviving terminal running without re-linking it",
      );
    }
  }
  return decisions;
}

async function gatherDecisions(input: {
  recordPath: string;
  terminals: AdoptedTerminals;
  lookupWorkspace(workspaceId: string): Promise<SurvivorWorkspace | null>;
  readScript(cwd: string, scriptName: string): Promise<SurvivorScript | null>;
  logger: pino.Logger;
}): Promise<SurvivorDecision[]> {
  const services = await readSurvivingServices(input.recordPath, input.logger);
  const workspaces = new Map<string, SurvivorWorkspace | null>();
  const scripts = new Map<string, SurvivorScript | null>();
  for (const service of services) {
    const terminal = input.terminals.getTerminal(service.terminalId);
    const worker = input.terminals.workerIdentityOf(service.terminalId);
    if (!terminal || !isProven(service, terminal, worker)) continue;
    if (!workspaces.has(service.workspaceId)) {
      workspaces.set(service.workspaceId, await input.lookupWorkspace(service.workspaceId));
    }
    const workspace = workspaces.get(service.workspaceId);
    if (workspace && !workspace.archived && !scripts.has(survivorKey(service))) {
      scripts.set(survivorKey(service), await input.readScript(workspace.cwd, service.scriptName));
    }
  }
  return decideSurvivors({ services, terminals: input.terminals, workspaces, scripts });
}
