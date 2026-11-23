import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalSession } from "../terminal/terminal.js";
import {
  decideSurvivors,
  readSurvivingServices,
  relinkWorkspaceScripts,
  survivorKey,
  type AdoptedTerminals,
  type SurvivingService,
  type SurvivorScript,
  type SurvivorWorkspace,
} from "./workspace-script-relink.js";
import {
  WorkspaceScriptRuntimeStore,
  type RunningService,
} from "./workspace-script-runtime-store.js";
import { ScriptRouteStore } from "./service-proxy.js";
import { restoreSurvivingService } from "./worktree-bootstrap.js";

const logger = pino({ level: "silent" });
const WORKER = { pid: 4242, startedAt: "Mon Nov 23 09:38:23 2026" };

function service(overrides: Partial<SurvivingService> = {}): SurvivingService {
  return {
    terminalId: "5f0c7a9e-1111-4c3b-9d0e-000000000001",
    workspaceId: "ws-1",
    scriptName: "web",
    cwd: "/repo/ws-1",
    port: 41001,
    projectSlug: "repo",
    branchName: "main",
    scriptConfig: "a".repeat(64),
    worker: WORKER,
    ...overrides,
  };
}

function terminal(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: service().terminalId,
    name: "web",
    cwd: "/repo/ws-1",
    workspaceId: "ws-1",
    ...overrides,
  } as TerminalSession;
}

function adopted(
  sessions: TerminalSession[],
  worker: typeof WORKER | null = WORKER,
): AdoptedTerminals {
  return {
    getTerminal: (id) => sessions.find((session) => session.id === id),
    workerIdentityOf: (id) => (sessions.some((session) => session.id === id) ? worker : null),
  };
}

const ACTIVE: SurvivorWorkspace = { cwd: "/repo/ws-1", archived: false };
const SAME_SCRIPT: SurvivorScript = { scriptConfig: "a".repeat(64), fixedPort: null };

function decide(input: {
  entry?: SurvivingService;
  sessions?: TerminalSession[];
  worker?: typeof WORKER | null;
  workspace?: SurvivorWorkspace | null;
  script?: SurvivorScript | null;
}) {
  const entry = input.entry ?? service();
  const [decision] = decideSurvivors({
    services: [entry],
    terminals: adopted(
      input.sessions ?? [terminal()],
      input.worker === undefined ? WORKER : input.worker,
    ),
    workspaces: new Map([
      [entry.workspaceId, input.workspace === undefined ? ACTIVE : input.workspace],
    ]),
    scripts: new Map([
      [survivorKey(entry), input.script === undefined ? SAME_SCRIPT : input.script],
    ]),
  });
  return decision;
}

describe("surviving workspace script terminals", () => {
  // The dangerous half: a terminal the daemon cannot prove it launched as this script is never
  // stopped or re-linked, even when its workspace is gone. Proof is the ledger's terminal id on
  // an adopted terminal of the same verified worker (pid and birth time) with the same
  // workspace, name and directory.
  it("leaves alone any terminal whose identity is not proven, even in an archived workspace", () => {
    const archived = { cwd: "/repo/ws-1", archived: true };
    const unproven = [
      { label: "another worker", worker: { pid: 4242, startedAt: "Sun Nov 22 21:00:00 2026" } },
      { label: "a reused worker pid", worker: { pid: 9999, startedAt: WORKER.startedAt } },
      { label: "an unknown worker", worker: null },
      { label: "another name", sessions: [terminal({ name: "shell" })] },
      { label: "another workspace", sessions: [terminal({ workspaceId: "ws-2" })] },
      { label: "another directory", sessions: [terminal({ cwd: "/repo/ws-1/sub" })] },
    ];
    for (const { label, ...input } of unproven) {
      expect({ label, decision: decide({ ...input, workspace: archived }) }).toMatchObject({
        label,
        decision: { action: "leave", reason: "not_proven" },
      });
    }
    expect(decide({ sessions: [], workspace: archived })).toMatchObject({ action: "gone" });
  });

  it("stops a proven script terminal whose workspace was archived or removed while down", () => {
    expect(decide({ workspace: { cwd: "/repo/ws-1", archived: true } })).toMatchObject({
      action: "stop",
      reason: "workspace_unavailable",
    });
    expect(decide({ workspace: null })).toMatchObject({ action: "stop" });
  });

  it("re-links a proven service only while its script is unchanged", () => {
    expect(decide({})).toMatchObject({ action: "relink", fixedPort: null });
    expect(decide({ script: { scriptConfig: "b".repeat(64), fixedPort: null } })).toMatchObject({
      action: "leave",
      reason: "script_changed",
    });
    expect(decide({ script: null })).toMatchObject({ action: "leave", reason: "script_changed" });
  });

  it("gives a re-linked service its route back and still notices when it exits", () => {
    const exitListeners: Array<(info: { exitCode: number | null }) => void> = [];
    const session = {
      ...terminal(),
      onExit: (listener: (info: { exitCode: number | null }) => void) => {
        exitListeners.push(listener);
        return () => undefined;
      },
    } as unknown as TerminalSession;
    const decision = decide({ sessions: [session] });
    if (decision?.action !== "relink") throw new Error(`expected relink, got ${decision?.action}`);
    const routes = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    let changes = 0;

    restoreSurvivingService({
      decision,
      serviceProxy: routes,
      serviceProxyPublicBaseUrl: null,
      runtimeStore,
      logger,
      onLifecycleChanged: () => {
        changes += 1;
      },
    });

    expect(runtimeStore.get({ workspaceId: "ws-1", scriptName: "web" })).toMatchObject({
      type: "service",
      lifecycle: "running",
      terminalId: session.id,
    });
    expect(routes.listRoutes()).toEqual([
      expect.objectContaining({ workspaceId: "ws-1", scriptName: "web", port: 41001 }),
    ]);

    exitListeners.forEach((listener) => listener({ exitCode: 0 }));
    expect(runtimeStore.get({ workspaceId: "ws-1", scriptName: "web" })).toMatchObject({
      lifecycle: "stopped",
      exitCode: 0,
    });
    expect(routes.listRoutes()).toEqual([]);
    expect(changes).toBe(1);
  });

  it("never re-links a service its owner stopped", () => {
    const store = new WorkspaceScriptRuntimeStore();
    const persisted: RunningService[][] = [];
    store.persistRunningServices((services) => persisted.push(services));
    store.set({
      workspaceId: "ws-1",
      scriptName: "web",
      type: "service",
      lifecycle: "running",
      terminalId: service().terminalId,
      exitCode: null,
      service: {
        port: 41001,
        projectSlug: "repo",
        branchName: "main",
        scriptConfig: "a".repeat(64),
      },
    });
    expect(persisted.at(-1)).toHaveLength(1);

    // Stop withdraws the service from the record before its terminal is killed, so a daemon
    // replaced mid-stop never brings it back.
    store.markStopRequested({ workspaceId: "ws-1", scriptName: "web" });
    expect(persisted.at(-1)).toEqual([]);
    expect(store.isRunning({ workspaceId: "ws-1", scriptName: "web" })).toBe(true);
  });

  describe("the record file", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(path.join(tmpdir(), "script-relink-"));
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it("fails closed on a linked, oversized or malformed record", async () => {
      const ledger = path.join(home, "workspace-script-terminals.json");
      const real = path.join(home, "elsewhere.json");
      writeFileSync(real, JSON.stringify({ version: 1, services: [service()] }));
      symlinkSync(real, ledger);
      expect(await readSurvivingServices(ledger, logger)).toEqual([]);
      rmSync(ledger);
      writeFileSync(ledger, JSON.stringify({ version: 1, services: [{ ...service(), port: 0 }] }));
      expect(await readSurvivingServices(ledger, logger)).toEqual([]);
      writeFileSync(ledger, " ".repeat(300_000));
      expect(await readSurvivingServices(ledger, logger)).toEqual([]);
      writeFileSync(ledger, JSON.stringify({ version: 1, services: [service()] }));
      expect(await readSurvivingServices(ledger, logger)).toEqual([service()]);
    });

    it("lets the daemon start when the lookups outlast the deadline", async () => {
      const ledger = path.join(home, "workspace-script-terminals.json");
      writeFileSync(ledger, JSON.stringify({ version: 1, services: [service()] }));
      const restored: string[] = [];
      const stopped: string[] = [];
      const decisions = await relinkWorkspaceScripts({
        recordPath: ledger,
        terminals: adopted([terminal()]),
        lookupWorkspace: () => new Promise(() => undefined),
        readScript: async () => SAME_SCRIPT,
        restore: (decision) => restored.push(decision.service.terminalId),
        stopTerminal: async (terminalId) => {
          stopped.push(terminalId);
        },
        deadlineMs: 20,
        logger,
      });
      expect(decisions).toEqual([]);
      expect(restored).toEqual([]);
      expect(stopped).toEqual([]);
    });
  });
});
