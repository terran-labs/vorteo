import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalSession } from "../terminal/terminal.js";
import type { TerminalScriptLaunch } from "../terminal/terminal-worker-protocol.js";
import { ScriptRouteStore } from "./service-proxy.js";
import {
  decideSurvivors,
  readSurvivingServices,
  readSurvivorWorkspaces,
  relinkWorkspaceScripts,
  type AdoptedTerminals,
  type SurvivingService,
  type SurvivorScript,
  type SurvivorWorkspace,
  type SurvivorWorkspaces,
} from "./workspace-script-relink.js";
import {
  WorkspaceScriptRuntimeStore,
  type RunningService,
} from "./workspace-script-runtime-store.js";
import {
  adoptWorkspaceServicePort,
  ServicePortTakenError,
} from "./workspace-service-port-registry.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";
import { restoreSurvivingService } from "./worktree-bootstrap.js";

const logger = pino({ level: "silent" });
const WORKER = { pid: 4242, startedAt: "Mon Nov 23 09:38:23 2026" };
const NONCE = "n0nce-launch-0000000000000001";
const TERMINAL_ID = "5f0c7a9e-1111-4c3b-9d0e-000000000001";
const CONFIG = "a".repeat(64);

function launch(overrides: Partial<TerminalScriptLaunch> = {}): TerminalScriptLaunch {
  return {
    kind: "workspace-script",
    workspaceId: "ws-1",
    scriptName: "web",
    port: 41001,
    projectSlug: "repo",
    branchName: "feature/preview",
    scriptConfig: CONFIG,
    nonce: NONCE,
    ...overrides,
  };
}

function record(overrides: Partial<SurvivingService> = {}): SurvivingService {
  return { terminalId: TERMINAL_ID, launchNonce: NONCE, worker: WORKER, ...overrides };
}

function terminal(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: TERMINAL_ID,
    name: "web",
    cwd: "/repo/ws-1",
    workspaceId: "ws-1",
    ...overrides,
  } as TerminalSession;
}

interface Adopted {
  session: TerminalSession;
  marker: TerminalScriptLaunch | null;
  worker?: typeof WORKER | null;
}

function adopted(terminals: Adopted[]): AdoptedTerminals {
  const find = (id: string) => terminals.find((entry) => entry.session.id === id);
  return {
    getTerminal: (id) => find(id)?.session,
    workerIdentityOf: (id) => {
      const entry = find(id);
      if (!entry) return null;
      return entry.worker === undefined ? WORKER : entry.worker;
    },
    scriptLaunchOf: (id) => find(id)?.marker ?? null,
  };
}

const ACTIVE: SurvivorWorkspace = { cwd: "/repo/ws-1", archived: false };
const SAME_SCRIPT: SurvivorScript = { scriptConfig: CONFIG, fixedPort: null };

function known(workspace: SurvivorWorkspace | null): SurvivorWorkspaces {
  const byId = new Map<string, SurvivorWorkspace>([["ws-other", ACTIVE]]);
  if (workspace) byId.set("ws-1", workspace);
  return { known: true, byId };
}

function decide(input: {
  records?: SurvivingService[];
  terminals?: Adopted[];
  workspaces?: SurvivorWorkspaces;
  script?: SurvivorScript | null;
}) {
  return decideSurvivors({
    services: input.records ?? [record()],
    terminals: adopted(input.terminals ?? [{ session: terminal(), marker: launch() }]),
    workspaces: input.workspaces ?? known(ACTIVE),
    scripts: new Map([[`ws-1\u0000web`, input.script === undefined ? SAME_SCRIPT : input.script]]),
  });
}

const ARCHIVED = known({ ...ACTIVE, archived: true });

function writeEmptyList(file: string): void {
  writeFileSync(file, "[]");
}

function leaveIntact(): void {}

async function readFeatureBranch(): Promise<string | null> {
  return "feature/preview";
}

async function readNoBranch(): Promise<string | null> {
  return null;
}

function readNeverAnswers(): Promise<string | null> {
  return new Promise(() => undefined);
}

function ignoreChange(): void {}

function hostnameOf(route: { hostname: string }): string {
  return route.hostname;
}

function withExitWatch(session: TerminalSession): TerminalSession {
  return { ...session, onExit: () => () => undefined } as unknown as TerminalSession;
}

describe("surviving workspace script terminals", () => {
  // The dangerous half. Only the worker's launch marker proves a script terminal. A terminal an
  // agent or client created has none, however its name, workspace and directory match, and a
  // record (agent-writable in Dev) cannot supply one. Unproven terminals are never stopped or
  // re-linked, even when their workspace is gone.
  it("leaves alone an agent's terminal named like the service, even with a forged record", () => {
    const agentTerminal = { session: terminal({ id: "agent-terminal" }), marker: null };
    const forged = record({ terminalId: "agent-terminal" });
    for (const workspaces of [known(ACTIVE), ARCHIVED, known(null)]) {
      expect(decide({ records: [forged], terminals: [agentTerminal], workspaces })).toEqual([
        { action: "leave", service: forged, reason: "not_proven" },
      ]);
    }
  });

  it("leaves alone a terminal whose marker, worker or name does not match the record", () => {
    const unproven: Array<{ label: string; terminal: Adopted }> = [
      {
        label: "another launch",
        terminal: { session: terminal(), marker: launch({ nonce: "other-launch-000000000000" }) },
      },
      {
        label: "another worker birth",
        terminal: {
          session: terminal(),
          marker: launch(),
          worker: { ...WORKER, startedAt: "Sun Nov 22 21:00:00 2026" },
        },
      },
      {
        label: "a reused worker pid",
        terminal: { session: terminal(), marker: launch(), worker: { ...WORKER, pid: 9999 } },
      },
      {
        label: "an unknown worker",
        terminal: { session: terminal(), marker: launch(), worker: null },
      },
      {
        label: "a renamed terminal",
        terminal: { session: terminal({ name: "shell" }), marker: launch() },
      },
      {
        label: "another workspace",
        terminal: { session: terminal({ workspaceId: "ws-2" }), marker: launch() },
      },
      {
        label: "a malformed marker",
        terminal: { session: terminal(), marker: launch({ port: 0 }) },
      },
    ];
    for (const { label, terminal: entry } of unproven) {
      expect({
        label,
        decision: decide({ terminals: [entry], workspaces: ARCHIVED })[0],
      }).toMatchObject({
        label,
        decision: { action: "leave", reason: "not_proven" },
      });
    }
    expect(decide({ terminals: [], workspaces: ARCHIVED })[0]).toMatchObject({ action: "gone" });
  });

  it("stops a proven service only when a clean registry says its workspace is archived or gone", () => {
    expect(decide({ workspaces: ARCHIVED })[0]).toMatchObject({
      action: "stop",
      reason: "workspace_unavailable",
    });
    expect(decide({ workspaces: known(null) })[0]).toMatchObject({ action: "stop" });
    expect(decide({ workspaces: { known: false } })[0]).toMatchObject({
      action: "leave",
      reason: "workspace_unknown",
    });
  });

  describe("an unreadable workspace registry", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(path.join(tmpdir(), "script-relink-registry-"));
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    async function workspacesAfter(damage: (file: string) => void): Promise<SurvivorWorkspaces> {
      const file = path.join(home, "workspaces.json");
      rmSync(file, { force: true });
      const writer = new FileBackedWorkspaceRegistry(file, logger);
      await writer.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: "ws-1",
          projectId: "proj-1",
          cwd: "/repo/ws-1",
          kind: "directory",
          displayName: "ws-1",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          archivedAt: null,
        }),
      );
      damage(file);
      return readSurvivorWorkspaces(new FileBackedWorkspaceRegistry(file, logger));
    }

    it("reads as unknown, so nothing is stopped, when the file is truncated, invalid, unreadable or missing", async () => {
      const damages: Array<[string, (file: string) => void]> = [
        ["truncated", (file) => writeFileSync(file, '[{"workspaceId":"ws-1",')],
        [
          "one invalid record",
          (file) => writeFileSync(file, JSON.stringify([{ workspaceId: "ws-1" }])),
        ],
        ["unreadable", (file) => chmodSync(file, 0o000)],
        ["missing", (file) => rmSync(file)],
      ];
      for (const [label, damage] of damages) {
        const workspaces = await workspacesAfter(damage);
        expect({ label, known: workspaces.known }).toEqual({ label, known: false });
        expect(decide({ workspaces })[0]).toMatchObject({
          action: "leave",
          reason: "workspace_unknown",
        });
      }
      // A clean file that lists nothing says nothing either.
      expect((await workspacesAfter(writeEmptyList)).known).toBe(false);
      const clean = await workspacesAfter(leaveIntact);
      expect(clean.known).toBe(true);
      expect(decide({ workspaces: clean })[0]).toMatchObject({ action: "relink" });
    });
  });

  it("stays unknown after a failed load even once something else has been written", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "script-relink-registry-"));
    try {
      const file = path.join(home, "workspaces.json");
      writeFileSync(file, '[{"workspaceId":"ws-1",');
      const registry = new FileBackedWorkspaceRegistry(file, logger);
      await registry.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: "ws-other",
          projectId: "proj-1",
          cwd: "/repo/other",
          kind: "directory",
          displayName: "other",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          archivedAt: null,
        }),
      );
      const workspaces = await readSurvivorWorkspaces(registry);
      expect(workspaces.known).toBe(false);
      expect(decide({ workspaces })[0]).toMatchObject({
        action: "leave",
        reason: "workspace_unknown",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("re-links a proven service only while its workspace directory and script are unchanged", () => {
    expect(decide({})[0]).toMatchObject({ action: "relink", fixedPort: null });
    const leaves: Array<[string, Parameters<typeof decide>[0], string]> = [
      [
        "moved workspace",
        { workspaces: known({ ...ACTIVE, cwd: "/repo/moved" }) },
        "workspace_changed",
      ],
      [
        "changed script",
        { script: { scriptConfig: "b".repeat(64), fixedPort: null } },
        "script_changed",
      ],
      ["removed script", { script: null }, "script_changed"],
      [
        "other fixed port",
        { script: { scriptConfig: CONFIG, fixedPort: 41002 } },
        "script_changed",
      ],
    ];
    for (const [label, input, reason] of leaves) {
      expect({ label, decision: decide(input)[0] }).toMatchObject({
        label,
        decision: { action: "leave", reason },
      });
    }
  });

  it("re-links one terminal per script", () => {
    const secondNonce = "second-launch-00000000000";
    const decisions = decide({
      records: [record(), record({ terminalId: "second", launchNonce: secondNonce })],
      terminals: [
        { session: terminal(), marker: launch() },
        { session: terminal({ id: "second" }), marker: launch({ nonce: secondNonce }) },
      ],
    });
    expect(decisions.map((decision) => decision.action)).toEqual(["relink", "leave"]);
    expect(decisions[1]).toMatchObject({ reason: "duplicate" });
  });

  it("restores a re-linked service from its marker and still notices its exit", () => {
    const exitListeners: Array<(info: { exitCode: number | null }) => void> = [];
    const session = {
      ...terminal(),
      onExit: (listener: (info: { exitCode: number | null }) => void) => {
        exitListeners.push(listener);
        return () => undefined;
      },
    } as unknown as TerminalSession;
    const [decision] = decide({ terminals: [{ session, marker: launch() }] });
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
      lifecycle: "running",
      terminalId: session.id,
      service: { launchNonce: NONCE },
    });
    expect(routes.listRoutes()).toEqual([
      expect.objectContaining({ workspaceId: "ws-1", scriptName: "web", port: 41001 }),
    ]);

    exitListeners.forEach((listener) => listener({ exitCode: 0 }));
    expect(runtimeStore.get({ workspaceId: "ws-1", scriptName: "web" })).toMatchObject({
      lifecycle: "stopped",
    });
    expect(routes.listRoutes()).toEqual([]);
    expect(changes).toBe(1);
  });

  // A re-linked service must come back at the address it had: a held link to the old hostname
  // would otherwise be dead.
  it("keeps the hostname of a service launched on a non-default branch", async () => {
    const launched = new ScriptRouteStore().registerWorkspaceService({
      port: 41001,
      workspaceId: "ws-1",
      projectSlug: "repo",
      branchName: "feature/preview",
      scriptName: "web",
      publicBaseUrl: null,
    }).hostname;
    const home = mkdtempSync(path.join(tmpdir(), "script-relink-branch-"));
    const file = path.join(home, "workspace-script-terminals.json");
    writeFileSync(file, JSON.stringify({ version: 2, services: [record()] }));
    try {
      for (const readBranch of [readFeatureBranch, readNoBranch, readNeverAnswers]) {
        const routes = new ScriptRouteStore();
        await relinkWorkspaceScripts({
          recordPath: file,
          terminals: adopted([{ session: withExitWatch(terminal()), marker: launch() }]),
          readWorkspaces: async () => known(ACTIVE),
          readScript: async () => SAME_SCRIPT,
          readBranch,
          restore: (decision) =>
            restoreSurvivingService({
              decision,
              serviceProxy: routes,
              serviceProxyPublicBaseUrl: null,
              runtimeStore: new WorkspaceScriptRuntimeStore(),
              logger,
              onLifecycleChanged: ignoreChange,
            }),
          stopTerminal: async () => undefined,
          deadlineMs: 3_000,
          logger,
        });
        expect({
          readBranch: readBranch.name,
          hostnames: routes.listRoutes().map(hostnameOf),
        }).toEqual({
          readBranch: readBranch.name,
          hostnames: [launched],
        });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to adopt a port another service holds", () => {
    adoptWorkspaceServicePort({
      workspaceId: "ws-port",
      scriptName: "api",
      port: 41500,
      fixed: false,
    });
    expect(() =>
      adoptWorkspaceServicePort({
        workspaceId: "ws-port-2",
        scriptName: "web",
        port: 41500,
        fixed: false,
      }),
    ).toThrow(ServicePortTakenError);
    expect(() =>
      adoptWorkspaceServicePort({
        workspaceId: "ws-port",
        scriptName: "web",
        port: 41500,
        fixed: true,
      }),
    ).toThrow(ServicePortTakenError);
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
      terminalId: TERMINAL_ID,
      exitCode: null,
      service: { launchNonce: NONCE },
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
      const file = path.join(home, "workspace-script-terminals.json");
      const real = path.join(home, "elsewhere.json");
      writeFileSync(real, JSON.stringify({ version: 2, services: [record()] }));
      symlinkSync(real, file);
      expect(await readSurvivingServices(file, logger)).toEqual([]);
      rmSync(file);
      writeFileSync(
        file,
        JSON.stringify({ version: 2, services: [{ ...record(), launchNonce: "x" }] }),
      );
      expect(await readSurvivingServices(file, logger)).toEqual([]);
      writeFileSync(file, " ".repeat(300_000));
      expect(await readSurvivingServices(file, logger)).toEqual([]);
      writeFileSync(file, JSON.stringify({ version: 2, services: [record()] }));
      expect(await readSurvivingServices(file, logger)).toEqual([record()]);
    });

    it("lets the daemon start when the lookups outlast the deadline", async () => {
      const file = path.join(home, "workspace-script-terminals.json");
      writeFileSync(file, JSON.stringify({ version: 2, services: [record()] }));
      const restored: string[] = [];
      const stopped: string[] = [];
      const decisions = await relinkWorkspaceScripts({
        recordPath: file,
        terminals: adopted([{ session: terminal(), marker: launch() }]),
        readWorkspaces: () => new Promise(() => undefined),
        readScript: async () => SAME_SCRIPT,
        readBranch: readFeatureBranch,
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
