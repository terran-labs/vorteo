// Re-links workspace services whose terminals survived a daemon replacement.
//
// A service runs in a terminal of the terminal worker, which outlives the daemon. The script
// state that ties the terminal to its workspace script lives in daemon memory. Two things let a
// new daemon restore it:
//
// - The launch marker. The launcher hands the worker a marker with the terminal (workspace,
//   script, port, script config hash and a random nonce). The worker keeps it and lists it on
//   adoption. Terminal creation from clients and agents cannot set it. It is the proof, and the
//   only source of the port and script identity.
// - The record of running services in $PASEO_HOME. It names which launches should keep
//   running: Stop removes a service from it before killing the terminal. It proves nothing on
//   its own, because in Dev the home is agent-writable. An entry counts only when its nonce
//   equals the marker the verified worker holds for that terminal.
//
// See docs/terminal-worker.md, "Workspace services across a restart".

import { createHash } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import type { TerminalSession } from "../terminal/terminal.js";
import type { TerminalWorkerIdentity } from "../terminal/terminal-worker-pool.js";
import type { TerminalScriptLaunch } from "../terminal/terminal-worker-protocol.js";
import { readBoundedRegularFile } from "./bounded-file-read.js";
import { writePrivateFileAtomic } from "./private-files.js";

export const SURVIVING_SERVICES_FILE = "workspace-script-terminals.json";
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_SERVICES = 256;

const SurvivingServiceSchema = z.object({
  terminalId: z.string().min(1).max(200),
  launchNonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  worker: z.object({
    pid: z.number().int().positive(),
    startedAt: z.string().min(1).max(200),
  }),
});

const SurvivingServicesRecordSchema = z.object({
  version: z.literal(2),
  services: z.array(SurvivingServiceSchema).max(MAX_SERVICES),
});

// The marker comes from the worker over its authenticated socket; it is still checked before
// any of it reaches a route or the port registry.
const TerminalScriptLaunchSchema = z.object({
  kind: z.literal("workspace-script"),
  workspaceId: z.string().min(1).max(4096),
  scriptName: z.string().min(1).max(200),
  port: z.number().int().min(1).max(65535),
  projectSlug: z.string().max(400),
  branchName: z.string().max(400).nullable(),
  scriptConfig: z.string().regex(/^[0-9a-f]{64}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

export type SurvivingService = z.infer<typeof SurvivingServiceSchema>;

export interface AdoptedTerminals {
  getTerminal(terminalId: string): TerminalSession | undefined;
  /** The verified identity of the worker that runs the terminal, or null when unknown. */
  workerIdentityOf(terminalId: string): TerminalWorkerIdentity | null;
  /** The launch marker the worker holds for the terminal, or null. */
  scriptLaunchOf(terminalId: string): TerminalScriptLaunch | null;
}

export interface SurvivorWorkspace {
  cwd: string;
  archived: boolean;
}

/**
 * The workspaces as the registry knows them, or `unknown` when it could not say: it failed to
 * read or parse its file, has no file, or lists nothing. Unknown never stops anything.
 */
export type SurvivorWorkspaces =
  | { known: true; byId: ReadonlyMap<string, SurvivorWorkspace> }
  | { known: false };

export interface SurvivorScript {
  scriptConfig: string;
  fixedPort: number | null;
}

/** A launch proven by the worker's marker, with everything the re-link may use. */
export interface ProvenLaunch {
  service: SurvivingService;
  terminal: TerminalSession;
  launch: TerminalScriptLaunch;
}

type LeaveReason =
  | "not_proven"
  | "workspace_unknown"
  | "workspace_changed"
  | "script_changed"
  | "duplicate";

export type SurvivorDecision =
  | (ProvenLaunch & {
      action: "relink";
      fixedPort: number | null;
      /** The checkout's branch now, or the launch's when git could not say. */
      branchName: string | null;
    })
  | (ProvenLaunch & { action: "stop"; reason: "workspace_unavailable" })
  | { action: "leave"; service: SurvivingService; reason: LeaveReason }
  | { action: "gone"; service: SurvivingService };

export function hashScriptConfig(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function scriptKey(launch: Pick<TerminalScriptLaunch, "workspaceId" | "scriptName">): string {
  return `${launch.workspaceId}\u0000${launch.scriptName}`;
}

/**
 * The launch this record entry names, when the worker proves it: the terminal runs under the
 * recorded worker (pid and birth time, verified at adoption), the worker holds a launch marker
 * for it with the same nonce, and the terminal's workspace and name agree with the marker. A
 * name, port, directory or record alone never proves it.
 */
function provenLaunch(service: SurvivingService, terminals: AdoptedTerminals): ProvenLaunch | null {
  const terminal = terminals.getTerminal(service.terminalId);
  const worker = terminals.workerIdentityOf(service.terminalId);
  const marker = TerminalScriptLaunchSchema.safeParse(terminals.scriptLaunchOf(service.terminalId));
  if (!terminal || !worker || !marker.success) return null;
  const launch = marker.data;
  const sameWorker =
    worker.pid === service.worker.pid && worker.startedAt === service.worker.startedAt;
  const sameLaunch = launch.nonce === service.launchNonce;
  const sameTerminal =
    terminal.workspaceId === launch.workspaceId && terminal.name === launch.scriptName;
  if (!sameWorker || !sameLaunch || !sameTerminal) return null;
  return { service, terminal, launch };
}

/**
 * One decision per recorded service. Only a proven launch is ever stopped or re-linked. It is
 * stopped only when the registry read cleanly and reports its workspace archived or absent.
 * Everything else is left running.
 */
export function decideSurvivors(input: {
  services: readonly SurvivingService[];
  terminals: AdoptedTerminals;
  workspaces: SurvivorWorkspaces;
  scripts: ReadonlyMap<string, SurvivorScript | null>;
  /** Current git branch per terminal id; null or absent keeps the launch's branch. */
  branches?: ReadonlyMap<string, string | null>;
}): SurvivorDecision[] {
  const relinked = new Set<string>();
  return input.services.map((service): SurvivorDecision => {
    if (!input.terminals.getTerminal(service.terminalId)) return { action: "gone", service };
    const proven = provenLaunch(service, input.terminals);
    if (!proven) return { action: "leave", service, reason: "not_proven" };
    if (!input.workspaces.known) return { action: "leave", service, reason: "workspace_unknown" };
    const workspace = input.workspaces.byId.get(proven.launch.workspaceId);
    if (!workspace || workspace.archived) {
      return { ...proven, action: "stop", reason: "workspace_unavailable" };
    }
    if (workspace.cwd !== proven.terminal.cwd) {
      return { action: "leave", service, reason: "workspace_changed" };
    }
    const script = input.scripts.get(scriptKey(proven.launch)) ?? null;
    const sameScript =
      script !== null &&
      script.scriptConfig === proven.launch.scriptConfig &&
      (script.fixedPort === null || script.fixedPort === proven.launch.port);
    if (!sameScript) return { action: "leave", service, reason: "script_changed" };
    if (relinked.has(scriptKey(proven.launch))) {
      return { action: "leave", service, reason: "duplicate" };
    }
    relinked.add(scriptKey(proven.launch));
    // Read the same way the launcher's git snapshot is; unreadable keeps the launch's branch,
    // so the route keeps the hostname it had.
    const branchName = input.branches?.get(service.terminalId) ?? proven.launch.branchName;
    return { ...proven, action: "relink", fixedPort: script.fixedPort, branchName };
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

/** Serializes record writes so the last state wins, and skips unchanged ones. */
export function createSurvivingServicesWriter(input: {
  recordPath: string;
  logger: pino.Logger;
}): (services: SurvivingService[]) => void {
  let queue: Promise<void> = Promise.resolve();
  let last: string | null = null;
  return (services) => {
    const text = `${JSON.stringify({ version: 2, services: services.slice(0, MAX_SERVICES) })}\n`;
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

const BRANCH_READ_TIMEOUT_MS = 1_000;

/** The checkout's branch, or null (keep the launch's) when git errs or is slow. */
async function readBranchWithin(
  readBranch: (cwd: string) => Promise<string | null>,
  cwd: string,
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), BRANCH_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([readBranch(cwd).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the record, the workspaces and each proven service's script within `deadlineMs`, then
 * re-links or stops what it proved. Past the deadline nothing is re-linked or stopped and the
 * daemon starts as before: those services show as stopped and keep running unlinked.
 */
export async function relinkWorkspaceScripts(input: {
  recordPath: string;
  terminals: AdoptedTerminals;
  readWorkspaces(): Promise<SurvivorWorkspaces>;
  readScript(cwd: string, scriptName: string): Promise<SurvivorScript | null>;
  readBranch(cwd: string): Promise<string | null>;
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
    const fields = { terminalId: decision.service.terminalId };
    if (decision.action === "relink") {
      // One service's route or port conflict must not keep the others, or the daemon, down.
      try {
        input.restore(decision);
        // The coordinator reads this exact message in a release to decide whether a Host
        // install may keep terminals; see execution-installation/host-install-terminals.ts.
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
  readWorkspaces(): Promise<SurvivorWorkspaces>;
  readScript(cwd: string, scriptName: string): Promise<SurvivorScript | null>;
  readBranch(cwd: string): Promise<string | null>;
  logger: pino.Logger;
}): Promise<SurvivorDecision[]> {
  const services = await readSurvivingServices(input.recordPath, input.logger);
  const proven = services.flatMap((service) => provenLaunch(service, input.terminals) ?? []);
  if (proven.length === 0) {
    return decideSurvivors({
      services,
      terminals: input.terminals,
      workspaces: { known: false },
      scripts: new Map(),
    });
  }
  const workspaces = await input.readWorkspaces();
  // Read concurrently: each branch read may take its full second, and the caller's deadline
  // is all-or-nothing, so reading one after another let three slow checkouts re-link nothing.
  const scriptReads = new Map<string, Promise<SurvivorScript | null>>();
  const branchReads: Promise<[string, string | null]>[] = [];
  if (workspaces.known) {
    for (const { launch, terminal, service } of proven) {
      const workspace = workspaces.byId.get(launch.workspaceId);
      if (!workspace || workspace.archived) continue;
      if (!scriptReads.has(scriptKey(launch))) {
        scriptReads.set(scriptKey(launch), input.readScript(workspace.cwd, launch.scriptName));
      }
      branchReads.push(
        readBranchWithin(input.readBranch, terminal.cwd).then((branch) => [
          service.terminalId,
          branch,
        ]),
      );
    }
  }
  const [scriptEntries, branchEntries] = await Promise.all([
    Promise.all(
      [...scriptReads].map(
        async ([key, read]) => [key, await read] as [string, SurvivorScript | null],
      ),
    ),
    Promise.all(branchReads),
  ]);
  return decideSurvivors({
    services,
    terminals: input.terminals,
    workspaces,
    scripts: new Map(scriptEntries),
    branches: new Map(branchEntries),
  });
}

/**
 * The registry's workspaces, only when it loaded its file cleanly and lists at least one.
 * Anything else (a read or parse error, no file, an empty list) is unknown.
 */
export async function readSurvivorWorkspaces(registry: {
  loadedCleanly(): Promise<boolean>;
  list(): Promise<readonly { workspaceId: string; cwd: string; archivedAt: string | null }[]>;
}): Promise<SurvivorWorkspaces> {
  if (!(await registry.loadedCleanly())) return { known: false };
  const records = await registry.list();
  if (records.length === 0) return { known: false };
  const byId = new Map<string, SurvivorWorkspace>();
  for (const record of records) {
    byId.set(record.workspaceId, { cwd: record.cwd, archived: record.archivedAt !== null });
  }
  return { known: true, byId };
}
