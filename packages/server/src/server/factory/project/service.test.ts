import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ProjectFactoryInstructions,
  ProjectFactoryRoleId,
} from "@getpaseo/server/factory-project";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import type { CreateAgentCommandInput } from "../../agent/create-agent/create.js";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { SYSTEM_PROJECT_KIND } from "../../system-project/manifest.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../../workspace-registry.js";
import { charterVersion } from "./instructions.js";
import { PROJECT_FACTORY_ROLE_LABEL, PROJECT_FACTORY_ROLES } from "./roles.js";
import { DRAIN_ENDED, drainNotice, ProjectFactoryService, type PromptOutcome } from "./service.js";
import { factoryProjectQueue } from "@getpaseo/server/factory-project";
import type { GhRunner } from "./tick-gate.js";
import { projectFactoryStatePath } from "./state.js";

const T0 = "2026-11-03T12:00:00.000Z";
const PROJECT = "prj_app";
const REPO = "acme/app";
const logger = createTestLogger();

let home: string;
let projects: FileBackedProjectRegistry;
let workspaces: FileBackedWorkspaceRegistry;
let agents: FakeAgents;
let schedules: FakeSchedules;
let fingerprints: Map<string, string | null>;
let clock: Date;
let services: ProjectFactoryService[];

interface SentPrompt {
  agentId: string;
  prompt: string;
  steer: boolean;
}

class FakeAgents {
  readonly records = new Map<string, StoredAgentRecord>();
  readonly prompts: SentPrompt[] = [];
  readonly switches: { agentId: string; provider: string; profileId?: string }[] = [];
  readonly switchCharters: string[] = [];
  created = 0;
  busy = new Set<string>();
  switchFails = false;
  /** Agents whose next prompts throw. */
  failing = new Set<string>();
  /** When set, prompts to these agents wait for this promise. */
  hold: { agents: Set<string>; until: Promise<void> } | null = null;

  add(input: { id: string; workspaceId: string; title?: string; labels?: Record<string, string> }) {
    const record = {
      id: input.id,
      provider: "claude",
      cwd: home,
      workspaceId: input.workspaceId,
      title: input.title ?? input.id,
      labels: input.labels ?? {},
      config: {},
      createdAt: T0,
      updatedAt: T0,
      archivedAt: null,
      lastStatus: "idle",
    } as unknown as StoredAgentRecord;
    this.records.set(input.id, record);
    return record;
  }

  storage = {
    list: async () => [...this.records.values()],
    get: async (id: string) => this.records.get(id) ?? null,
  };

  createAgent = async (input: CreateAgentCommandInput) => {
    if (input.kind !== "mcp") throw new Error("unexpected create kind");
    this.created += 1;
    const id = `agent-${this.created}-${input.title}`;
    const record = this.add({
      id,
      workspaceId: input.workspaceId!,
      title: input.title ?? undefined,
      labels: input.labels,
    });
    (record as { config: unknown }).config = input.config;
    await input.onCreated?.({ agentId: id } as never);
    return {} as never;
  };

  ops = {
    setLabels: async (agentId: string, labels: Record<string, string>) => {
      const record = this.records.get(agentId)!;
      record.labels = { ...record.labels, ...labels };
    },
    setSystemPrompt: async (agentId: string, systemPrompt: string) => {
      const record = this.records.get(agentId)!;
      record.config = { ...record.config, systemPrompt };
    },
    sendPrompt: async (
      agentId: string,
      prompt: string,
      options: { steer: boolean },
    ): Promise<PromptOutcome> => {
      if (this.failing.has(agentId)) throw new Error("provider unavailable");
      if (this.hold?.agents.has(agentId)) await this.hold.until;
      if (this.busy.has(agentId) && !options.steer) return "busy";
      this.prompts.push({ agentId, prompt, steer: options.steer });
      return "sent";
    },
    switchLaunch: async (
      agentId: string,
      launch: { provider: string; profileId?: string },
      standingInstructions: string,
    ) => {
      if (this.switchFails) throw new Error("This thread is busy.");
      this.switches.push({ agentId, ...launch });
      this.switchCharters.push(standingInstructions);
      // Like the real switch, the new session's stored prompt is the handoff, not the charter.
      const record = this.records.get(agentId)!;
      record.config = { ...record.config, systemPrompt: "Switched accounts. Carried context." };
    },
  };
}

class FakeSchedules {
  readonly items: StoredSchedule[] = [];
  failPause = false;
  failResume = false;
  list = async () => this.items;
  pause = async (id: string) => {
    if (this.failPause) throw new Error("schedule store busy");
    const item = this.items.find((schedule) => schedule.id === id)!;
    item.status = "paused";
    return item;
  };
  resume = async (id: string) => {
    if (this.failResume) throw new Error("schedule store busy");
    const item = this.items.find((schedule) => schedule.id === id)!;
    item.status = "active";
    return item;
  };
}

function service(gh?: GhRunner): ProjectFactoryService {
  const instance = new ProjectFactoryService({
    paseoHome: home,
    serverId: "srv_test",
    projects,
    workspaces,
    agentStorage: agents.storage,
    createAgent: agents.createAgent,
    createWorkspace: async (input) => {
      const record = createPersistedWorkspaceRecord({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        cwd: input.cwd,
        kind: "directory",
        displayName: input.title,
        title: input.title,
        createdAt: T0,
        updatedAt: T0,
      });
      await workspaces.upsert(record);
      return record;
    },
    agents: agents.ops,
    defaultLaunch: async () => ({ provider: "claude", profileId: "default-profile" }),
    profileProvider: (profileId) => (profileId === "local-fast" ? "opencode" : null),
    schedules,
    gh,
    fingerprint: async (role) => fingerprints.get(role) ?? null,
    logger,
    now: () => clock,
    timeZone: "UTC",
  });
  services.push(instance);
  return instance;
}

async function addProject(projectId = PROJECT, system = false) {
  const record = createPersistedProjectRecord({
    projectId,
    rootPath: path.join(home, projectId),
    kind: "git",
    displayName: system ? "Vorteo System" : "App",
    createdAt: T0,
    updatedAt: T0,
  });
  if (system)
    await projects.writeSystemProject({ ...record, systemProject: { kind: SYSTEM_PROJECT_KIND } });
  else await projects.upsert(record);
}

async function addWorkspace(workspaceId: string, projectId = PROJECT) {
  await workspaces.upsert(
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId,
      cwd: path.join(home, projectId),
      kind: "directory",
      displayName: workspaceId,
      createdAt: T0,
      updatedAt: T0,
    }),
  );
}

/** Vorteo System with its Optimizer agent and active review heartbeat. */
async function seedSystemProject() {
  rmSync(path.join(home, "projects"), { recursive: true, force: true });
  projects = new FileBackedProjectRegistry(path.join(home, "projects", "projects.json"), logger);
  workspaces = new FileBackedWorkspaceRegistry(
    path.join(home, "projects", "workspaces.json"),
    logger,
  );
  await addProject(PROJECT, true);
  await workspaces.writeSystemWorkspace({
    ...createPersistedWorkspaceRecord({
      workspaceId: "wks_optimizer",
      projectId: PROJECT,
      cwd: home,
      kind: "directory",
      displayName: "optimization-runner",
      title: "Vorteo :: Mechanic",
      createdAt: T0,
      updatedAt: T0,
    }),
    systemMembership: { role: "optimization-runner" },
    standing: true,
    protected: true,
  });
  agents.add({
    id: "optimizer",
    workspaceId: "wks_optimizer",
    labels: { "vorteo.system-agent": "optimization-runner" },
  });
  schedules.items.push({
    id: "sched-optimizer",
    name: "Optimizer review",
    status: "active",
    target: { type: "agent", agentId: "optimizer" },
  } as StoredSchedule);
}

function enable(target = service(), adopt?: Partial<Record<ProjectFactoryRoleId, string>>) {
  return target.invoke("factory.project.enable", {
    projectId: PROJECT,
    repository: REPO,
    ...(adopt ? { adopt } : {}),
  }) as ReturnType<ProjectFactoryService["enable"]>;
}

function roleAgent(state: Awaited<ReturnType<typeof enable>>, role: ProjectFactoryRoleId) {
  const agentId = state.roles.find((entry) => entry.role === role)?.agentId;
  if (!agentId) throw new Error(`no agent for ${role}`);
  return agentId;
}

function instructions(target: ProjectFactoryService, role: ProjectFactoryRoleId) {
  return target.getInstructions(PROJECT, role);
}

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "vorteo-project-factory-"));
  projects = new FileBackedProjectRegistry(path.join(home, "projects", "projects.json"), logger);
  workspaces = new FileBackedWorkspaceRegistry(
    path.join(home, "projects", "workspaces.json"),
    logger,
  );
  agents = new FakeAgents();
  schedules = new FakeSchedules();
  fingerprints = new Map();
  clock = new Date(T0);
  services = [];
  await addProject();
});

afterEach(() => {
  for (const instance of services) instance.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("enable", () => {
  test("creates one workspace, agent and heartbeat per role, in folder order", async () => {
    const factory = service();
    const state = await enable(factory);

    expect(state.state).toBe("on");
    expect(state.roles.map((role) => role.title)).toEqual([
      "Triage",
      "Foreman",
      "Builds",
      "Releases",
      "Mechanic",
    ]);
    expect(agents.created).toBe(5);
    const members = (await workspaces.list()).filter((workspace) => workspace.factoryMembership);
    expect(members.map((workspace) => workspace.title).sort()).toEqual([
      "App :: Builds",
      "App :: Foreman",
      "App :: Mechanic",
      "App :: Releases",
      "App :: Triage",
    ]);
    expect(members.map((workspace) => workspace.factoryMembership?.role).sort()).toEqual([
      "builds",
      "factory",
      "factory",
      "factory",
      "factory",
    ]);
    expect(members[0]?.factoryMembership).toMatchObject({
      installationId: `project-factory:${PROJECT}`,
      projectId: PROJECT,
      serverId: "srv_test",
    });
    const foreman = agents.records.get(roleAgent(state, "factory-intake"))!;
    expect(foreman.labels[PROJECT_FACTORY_ROLE_LABEL]).toBe(`${PROJECT}:factory-intake`);
    expect(foreman.config?.systemPrompt).toContain("You are the Foreman.");
    expect(state.roles.every((role) => role.heartbeat?.paused === false)).toBe(true);
    expect(PROJECT_FACTORY_ROLES.every((role) => factory.hasTimer(PROJECT, role.id))).toBe(true);
  });

  test("a rerun and a restarted service create nothing new", async () => {
    const first = await enable();
    const rerun = await enable();
    const restarted = service();
    await restarted.start();
    const afterRestart = await enable(restarted);

    expect(agents.created).toBe(5);
    expect(rerun.roles).toEqual(first.roles);
    expect(afterRestart.roles).toEqual(first.roles);
    expect((await workspaces.list()).filter((w) => w.factoryMembership)).toHaveLength(5);
    expect(restarted.hasTimer(PROJECT, "factory-mechanic")).toBe(true);
  });

  test("a lost state file reuses the labelled agents and their workspaces", async () => {
    const first = await enable();
    rmSync(projectFactoryStatePath(home));
    const recovered = await enable(service());

    expect(agents.created).toBe(5);
    expect(recovered.roles.map((role) => [role.agentId, role.workspaceId])).toEqual(
      first.roles.map((role) => [role.agentId, role.workspaceId]),
    );
  });

  test("adopt binds an existing agent and its workspace without creating one", async () => {
    await addWorkspace("wks_existing");
    agents.add({ id: "agent-existing", workspaceId: "wks_existing" });

    const state = await enable(service(), { "factory-intake": "agent-existing" });

    expect(agents.created).toBe(4);
    expect(state.roles.find((role) => role.role === "factory-intake")).toMatchObject({
      agentId: "agent-existing",
      workspaceId: "wks_existing",
    });
    const adopted = agents.records.get("agent-existing")!;
    expect(adopted.labels[PROJECT_FACTORY_ROLE_LABEL]).toBe(`${PROJECT}:factory-intake`);
    expect(adopted.config?.systemPrompt).toContain("You are the Foreman.");
    expect((await workspaces.get("wks_existing"))?.factoryMembership?.role).toBe("factory");
    const sent = agents.prompts.filter((prompt) => prompt.agentId === "agent-existing");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.prompt).toContain("You are the Foreman.");
  });

  test.each([
    ["an unknown agent", { "factory-intake": "agent-missing" }, "was not found"],
    [
      "one agent for two roles",
      { "factory-intake": "a1", "factory-builds": "a1" },
      "two Factory roles",
    ],
  ])("refuses to adopt %s", async (_name, adopt, message) => {
    await addWorkspace("wks_existing");
    agents.add({ id: "a1", workspaceId: "wks_existing" });
    await expect(enable(service(), adopt)).rejects.toThrow(message);
    expect(agents.created).toBe(0);
  });

  test("refuses an agent bound to another role or in another project", async () => {
    await addProject("prj_other");
    await addWorkspace("wks_existing");
    await addWorkspace("wks_other", "prj_other");
    agents.add({
      id: "bound",
      workspaceId: "wks_existing",
      labels: { [PROJECT_FACTORY_ROLE_LABEL]: `${PROJECT}:factory-builds` },
    });
    agents.add({ id: "elsewhere", workspaceId: "wks_other" });

    await expect(enable(service(), { "factory-intake": "bound" })).rejects.toThrow(
      "already bound to Factory role",
    );
    await expect(enable(service(), { "factory-intake": "elsewhere" })).rejects.toThrow(
      "not in this project",
    );
  });

  test("refuses an invalid repository and an unknown project", async () => {
    const factory = service();
    await expect(
      factory.invoke("factory.project.enable", { projectId: PROJECT, repository: "not a repo" }),
    ).rejects.toThrow();
    await expect(factory.enable({ projectId: PROJECT, repository: "acme" })).rejects.toThrow(
      "owner/name",
    );
    await expect(
      factory.invoke("factory.project.get", { projectId: "prj_missing" }),
    ).rejects.toThrow("Unknown project");
    expect(agents.created).toBe(0);
  });

  test("on Vorteo System the Mechanic adopts the Optimizer and keeps its system workspace", async () => {
    await seedSystemProject();

    const factory = service();
    const state = await enable(factory);

    expect(agents.created).toBe(4);
    expect(roleAgent(state, "factory-mechanic")).toBe("optimizer");
    const optimizerWorkspace = await workspaces.get("wks_optimizer");
    expect(optimizerWorkspace?.factoryMembership).toBeUndefined();
    expect(optimizerWorkspace?.systemMembership).toEqual({ role: "optimization-runner" });
    expect(agents.records.get("optimizer")?.config?.systemPrompt).toContain(
      "keep this Vorteo installation healthy",
    );
    expect(schedules.items[0]?.status).toBe("paused");

    await factory.invoke("factory.project.disable", { projectId: PROJECT });
    expect(schedules.items[0]?.status).toBe("active");
  });
});

describe("pause, resume and disable", () => {
  test("pause stops heartbeats, resume restarts them, disable releases the workspaces", async () => {
    const factory = service();
    await enable(factory);

    const paused = await factory.invoke("factory.project.pause", { projectId: PROJECT });
    expect(paused).toMatchObject({ state: "paused" });
    expect(factory.hasTimer(PROJECT, "factory-intake")).toBe(false);
    expect((paused as Awaited<ReturnType<typeof enable>>).roles[0]?.heartbeat?.paused).toBe(true);

    const resumed = await factory.invoke("factory.project.resume", { projectId: PROJECT });
    expect(resumed).toMatchObject({ state: "on" });
    expect(factory.hasTimer(PROJECT, "factory-intake")).toBe(true);

    const off = (await factory.invoke("factory.project.disable", {
      projectId: PROJECT,
    })) as Awaited<ReturnType<typeof enable>>;
    expect(off.state).toBe("off");
    expect(off.roles.every((role) => role.heartbeat === null && role.agentId !== null)).toBe(true);
    expect(factory.hasTimer(PROJECT, "factory-intake")).toBe(false);
    expect((await workspaces.list()).filter((w) => w.factoryMembership)).toEqual([]);
    expect(agents.records.size).toBe(5);

    await enable(factory);
    expect(agents.created).toBe(5);
    expect((await workspaces.list()).filter((w) => w.factoryMembership)).toHaveLength(5);
  });

  test("member workspaces refuse archive until Factory is off", async () => {
    const state = await enable();
    const workspaceId = state.roles[0]!.workspaceId!;
    await expect(workspaces.archive(workspaceId, T0)).rejects.toThrow();
    await service().invoke("factory.project.disable", { projectId: PROJECT });
    await expect(workspaces.archive(workspaceId, T0)).resolves.toBe(true);
  });

  test("a damaged state file reports unavailable and refuses changes", async () => {
    await enable();
    writeFileSync(projectFactoryStatePath(home), "{");
    const factory = service();
    await expect(factory.get(PROJECT)).resolves.toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("damaged"),
    });
    await expect(enable(factory)).rejects.toThrow("damaged");
    expect(readFileSync(projectFactoryStatePath(home), "utf8")).toBe("{");
  });
});

describe("heartbeat ticks", () => {
  test("a gated role skips an unchanged GitHub state and wakes on a change", async () => {
    const factory = service();
    const foreman = roleAgent(await enable(factory), "factory-intake");
    fingerprints.set("factory-intake", "state-a");
    const ticks = () => agents.prompts.filter((prompt) => prompt.agentId === foreman);

    await factory.tick(PROJECT, "factory-intake");
    clock = new Date(Date.parse(T0) + 10 * 60_000);
    await factory.tick(PROJECT, "factory-intake");
    expect(ticks()).toHaveLength(1);

    fingerprints.set("factory-intake", "state-b");
    await factory.tick(PROJECT, "factory-intake");
    expect(ticks()).toHaveLength(2);

    // The remembered fingerprint survives a restart.
    await service().tick(PROJECT, "factory-intake");
    expect(ticks()).toHaveLength(2);
  });

  test("a busy agent keeps the change for the next tick", async () => {
    const factory = service();
    const builds = roleAgent(await enable(factory), "factory-builds");
    fingerprints.set("factory-builds", "merged-1");
    agents.busy.add(builds);
    await factory.tick(PROJECT, "factory-builds");
    agents.busy.clear();
    await factory.tick(PROJECT, "factory-builds");
    expect(agents.prompts.filter((prompt) => prompt.agentId === builds)).toHaveLength(1);
  });

  test("ungated roles always wake, and a paused Factory never does", async () => {
    const factory = service();
    const releases = roleAgent(await enable(factory), "factory-releases");
    await factory.tick(PROJECT, "factory-releases");
    await factory.tick(PROJECT, "factory-releases");
    await factory.invoke("factory.project.pause", { projectId: PROJECT });
    await factory.tick(PROJECT, "factory-releases");
    expect(agents.prompts.filter((prompt) => prompt.agentId === releases)).toHaveLength(2);
  });
});

describe("project instructions", () => {
  test("a save survives a restart and reaches the agent once per revision", async () => {
    const factory = service();
    const releases = roleAgent(await enable(factory), "factory-releases");
    const saved = await factory.invoke("factory.project.instructions.set", {
      projectId: PROJECT,
      role: "factory-releases",
      additions: "Tag betas only.",
      expectedRevision: 0,
    });
    expect(saved).toMatchObject({
      revision: 1,
      additions: "Tag betas only.",
      review: { status: "none" },
    });
    expect(agents.records.get(releases)?.config?.systemPrompt).toMatch(
      /\n\nProject instructions \(revision 1\):\nTag betas only\.$/,
    );

    const restarted = service();
    await expect(instructions(restarted, "factory-releases")).resolves.toMatchObject({
      revision: 1,
      additions: "Tag betas only.",
      history: [{ revision: 1, additions: "Tag betas only." }],
    });

    await restarted.tick(PROJECT, "factory-releases");
    await restarted.tick(PROJECT, "factory-releases");
    const sent = agents.prompts.filter((prompt) => prompt.agentId === releases);
    expect(sent[0]?.prompt).toMatch(/^Your standing instructions changed\./);
    expect(sent[0]?.prompt).toContain("Project instructions (revision 1):\nTag betas only.");
    expect(sent[1]?.prompt).not.toContain("standing instructions changed");
  });

  test("a stale revision is refused", async () => {
    const factory = service();
    await enable(factory);
    const save = (expectedRevision: number) =>
      factory.invoke("factory.project.instructions.set", {
        projectId: PROJECT,
        role: "factory-intake",
        additions: `v${expectedRevision}`,
        expectedRevision,
      });
    await save(0);
    await expect(save(0)).rejects.toThrow("revision 1");
  });

  test("a shipped charter change flags review and tells the Mechanic once", async () => {
    const factory = service();
    const state = await enable(factory);
    const mechanic = roleAgent(state, "factory-mechanic");
    await factory.invoke("factory.project.instructions.set", {
      projectId: PROJECT,
      role: "factory-builds",
      additions: "Deploy with make ship.",
      expectedRevision: 0,
    });
    // Simulate an upgrade: the additions were reviewed against an older charter.
    const file = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    file.projects[PROJECT].roles["factory-builds"].instructions.basedOn = {
      charterVersion: charterVersion("old charter"),
      charterText: "old charter",
    };
    writeFileSync(projectFactoryStatePath(home), JSON.stringify(file));
    const before = agents.prompts.length;

    await service().start();
    await service().start();

    const notices = agents.prompts.slice(before).filter((prompt) => prompt.agentId === mechanic);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.prompt).toContain("factory.project.instructions.get");
    expect(notices[0]?.prompt).toContain("factory-builds");
    const flagged = await instructions(service(), "factory-builds");
    expect(flagged).toMatchObject({
      review: { status: "needed" },
      basedOn: { charterText: "old charter" },
      additions: "Deploy with make ship.",
    });
    expect(agents.records.get(roleAgent(state, "factory-builds"))?.config?.systemPrompt).toContain(
      flagged.shippedCharter,
    );

    const acknowledged = await service().invoke("factory.project.instructions.acknowledge", {
      projectId: PROJECT,
      role: "factory-builds",
    });
    expect(acknowledged).toMatchObject({
      review: { status: "none" },
      revision: 1,
      basedOn: { charterVersion: flagged.charterVersion },
    });
  });

  test("propose then accept applies a new revision; dismiss keeps the additions", async () => {
    const factory = service();
    await enable(factory);
    const set = await factory.invoke("factory.project.instructions.set", {
      projectId: PROJECT,
      role: "factory-triage",
      additions: "Autonomous mode off.",
      expectedRevision: 0,
    });
    expect(set).toMatchObject({ revision: 1 });
    const propose = () =>
      factory.invoke("factory.project.instructions.propose", {
        projectId: PROJECT,
        role: "factory-triage",
        text: "Autonomous mode off. Batch questions weekly.",
        rationale: "The new charter batches questions.",
      });

    const first = (await propose()) as ProjectFactoryInstructions;
    expect(first.review.status).toBe("proposed");
    // A re-proposal while the panel shows the first one must not be accepted unseen.
    clock = new Date(Date.parse(T0) + 60_000);
    const second = (await propose()) as ProjectFactoryInstructions;
    const resolve = (proposedAt?: string) =>
      factory.invoke("factory.project.instructions.resolve", {
        projectId: PROJECT,
        role: "factory-triage",
        accept: true,
        expectedRevision: 1,
        ...(proposedAt ? { proposedAt } : {}),
      });
    await expect(resolve()).rejects.toThrow();
    await expect(resolve(first.review.proposal!.proposedAt)).rejects.toThrow(
      "replaced this proposal",
    );
    const accepted = await resolve(second.review.proposal!.proposedAt);
    expect(accepted).toMatchObject({
      revision: 2,
      additions: "Autonomous mode off. Batch questions weekly.",
      review: { status: "none" },
    });

    await propose();
    const dismissed = await factory.invoke("factory.project.instructions.resolve", {
      projectId: PROJECT,
      role: "factory-triage",
      accept: false,
      expectedRevision: 2,
    });
    expect(dismissed).toMatchObject({
      revision: 2,
      additions: "Autonomous mode off. Batch questions weekly.",
      review: { status: "none" },
    });
  });
});

describe("configure, status and send thread", () => {
  test("a role launch switches the agent, waiting for the next tick when it is busy", async () => {
    const factory = service();
    const foreman = roleAgent(await enable(factory), "factory-intake");
    agents.switchFails = true;
    const configured = (await factory.invoke("factory.project.configure", {
      projectId: PROJECT,
      role: "factory-intake",
      provider: "codex",
      profileId: "fast",
      workerProfileId: "worker-profile",
      reviewerProfileId: "reviewer-profile",
    })) as Awaited<ReturnType<typeof enable>>;
    expect(configured.workers).toEqual({
      plannerProfileId: null,
      planning: true,
      workerProfileId: "worker-profile",
      reviewerProfileId: "reviewer-profile",
    });
    expect(configured.roles[1]?.launch).toEqual({ provider: "codex", profileId: "fast" });
    expect(agents.switches).toEqual([]);

    agents.switchFails = false;
    fingerprints.set("factory-intake", "same");
    await factory.tick(PROJECT, "factory-intake");
    await factory.tick(PROJECT, "factory-intake");
    expect(agents.switches).toEqual([{ agentId: foreman, provider: "codex", profileId: "fast" }]);
  });

  test("a status line is trimmed, bounded, cleared when empty and wakes nobody", async () => {
    const factory = service();
    await enable(factory);
    const before = agents.prompts.length;
    const set = (line: string) =>
      factory.invoke("factory.project.status.set", {
        projectId: PROJECT,
        role: "factory-builds",
        line,
      }) as ReturnType<ProjectFactoryService["get"]>;

    const state = await set("  deploying 1a2b3c  ");
    expect(state.roles[2]?.status).toEqual({ line: "deploying 1a2b3c", updatedAt: T0 });
    await expect(set("x".repeat(121))).rejects.toThrow();
    expect((await set("   ")).roles[2]?.status).toBeNull();
    expect(agents.prompts.length).toBe(before);
  });

  test("send thread queues one prompt for Triage, and is refused while Factory is off", async () => {
    agents.add({ id: "thread-1", workspaceId: "wks_any", title: "Flaky upload" });
    const factory = service();
    const send = () =>
      factory.invoke("factory.project.send_thread", { projectId: PROJECT, agentId: "thread-1" });
    await expect(send()).rejects.toThrow("Factory is off");

    const triage = roleAgent(await enable(factory), "factory-triage");
    await expect(send()).resolves.toEqual({ queued: true });
    expect(agents.prompts.at(-1)).toEqual({
      agentId: triage,
      prompt:
        "Turn Vorteo thread thread-1 (title: Flaky upload) into one Factory task issue for acme/app, following your charter.",
      steer: true,
    });

    await factory.invoke("factory.project.disable", { projectId: PROJECT });
    await expect(send()).rejects.toThrow("Factory is off");
  });
});

describe("review fixes", () => {
  test("a new repository reaches every stored prompt and the next tick once", async () => {
    const factory = service();
    const first = await enable(factory);
    await factory.invoke("factory.project.enable", { projectId: PROJECT, repository: "acme/new" });

    for (const role of first.roles) {
      const prompt = agents.records.get(role.agentId!)?.config?.systemPrompt;
      expect(prompt).toContain("acme/new");
      expect(prompt).not.toContain(REPO);
    }
    const releases = roleAgent(first, "factory-releases");
    await factory.tick(PROJECT, "factory-releases");
    await factory.tick(PROJECT, "factory-releases");
    const sent = agents.prompts.filter((prompt) => prompt.agentId === releases);
    expect(sent[0]?.prompt).toMatch(/^Your standing instructions changed\./);
    expect(sent[0]?.prompt).toContain("You are Releases for acme/new.");
    expect(sent[1]?.prompt).not.toContain("standing instructions changed");
  });

  test("a heartbeat that fires while a pause is queued never rearms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const factory = service();
      const releases = roleAgent(await enable(factory), "factory-releases");
      let release = () => {};
      agents.hold = {
        agents: new Set([releases]),
        until: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      // Occupy the queue, queue the pause, then let the hourly and faster timers fire behind it.
      const blocker = factory.tick(PROJECT, "factory-releases");
      const paused = factory.invoke("factory.project.pause", { projectId: PROJECT });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      release();
      await blocker;
      await paused;
      await factory.tick(PROJECT, "factory-triage");
      await vi.advanceTimersByTimeAsync(0);

      for (const role of PROJECT_FACTORY_ROLES)
        expect(factory.hasTimer(PROJECT, role.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("clearing a role launch switches once to the default; a profile alone takes its provider", async () => {
    const factory = service();
    const foreman = roleAgent(await enable(factory), "factory-intake");
    const configure = (input: Record<string, unknown>) =>
      factory.invoke("factory.project.configure", {
        projectId: PROJECT,
        role: "factory-intake",
        ...input,
      });

    await configure({ provider: "codex", profileId: null });
    await configure({ provider: null, profileId: null });
    fingerprints.set("factory-intake", "same");
    await factory.tick(PROJECT, "factory-intake");
    await configure({ profileId: "local-fast" });

    expect(agents.switches).toEqual([
      { agentId: foreman, provider: "codex" },
      { agentId: foreman, provider: "claude", profileId: "default-profile" },
      { agentId: foreman, provider: "opencode", profileId: "local-fast" },
    ]);
  });

  test("Optimizer review ownership survives a failed pause and a failed resume", async () => {
    await seedSystemProject();
    schedules.failPause = true;
    await enable(service());
    expect(schedules.items[0]?.status).toBe("active");

    schedules.failPause = false;
    await service().start();
    expect(schedules.items[0]?.status).toBe("paused");

    schedules.failResume = true;
    await service().invoke("factory.project.disable", { projectId: PROJECT });
    expect(schedules.items[0]?.status).toBe("paused");

    schedules.failResume = false;
    await service().start();
    expect(schedules.items[0]?.status).toBe("active");
    const file = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    expect(file.projects[PROJECT].pausedOptimizerScheduleId).toBeUndefined();
  });

  test("a drift notice that fails to reach the Mechanic is retried, then sent once", async () => {
    const factory = service();
    const mechanic = roleAgent(await enable(factory), "factory-mechanic");
    await factory.invoke("factory.project.instructions.set", {
      projectId: PROJECT,
      role: "factory-builds",
      additions: "Deploy with make ship.",
      expectedRevision: 0,
    });
    const file = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    file.projects[PROJECT].roles["factory-builds"].instructions.basedOn = {
      charterVersion: charterVersion("old charter"),
      charterText: "old charter",
    };
    writeFileSync(projectFactoryStatePath(home), JSON.stringify(file));
    const notices = () =>
      agents.prompts.filter(
        (prompt) => prompt.agentId === mechanic && prompt.prompt.includes("charter changed"),
      );

    agents.failing.add(mechanic);
    await service().start();
    expect(notices()).toHaveLength(0);

    agents.failing.clear();
    await service().start();
    await service().start();
    expect(notices()).toHaveLength(1);
  });
});

describe("launch switches keep the charter", () => {
  async function foremanWithSettledGate(factory: ProjectFactoryService) {
    const foreman = roleAgent(await enable(factory), "factory-intake");
    fingerprints.set("factory-intake", "same");
    await factory.tick(PROJECT, "factory-intake");
    return { foreman, sentBefore: agents.prompts.length };
  }

  function promptsTo(agentId: string, after: number) {
    return agents.prompts.slice(after).filter((prompt) => prompt.agentId === agentId);
  }

  function expectCharterDelivered(foreman: string, sentBefore: number) {
    const [next] = promptsTo(foreman, sentBefore);
    expect(next?.prompt).toMatch(/^Your standing instructions changed\./);
    expect(next?.prompt).toContain("You are the Foreman.");
    expect(agents.records.get(foreman)?.config?.systemPrompt).toContain("You are the Foreman.");
  }

  test("an immediate configure switch delivers the full charter promptly", async () => {
    const factory = service();
    const { foreman, sentBefore } = await foremanWithSettledGate(factory);

    await factory.invoke("factory.project.configure", {
      projectId: PROJECT,
      role: "factory-intake",
      provider: "codex",
    });

    expect(agents.switchCharters.at(-1)).toContain("You are the Foreman.");
    await vi.waitFor(() => expect(promptsTo(foreman, sentBefore)).not.toHaveLength(0));
    expectCharterDelivered(foreman, sentBefore);
  });

  test("a switch retried on a tick delivers the full charter in that tick", async () => {
    const factory = service();
    const { foreman, sentBefore } = await foremanWithSettledGate(factory);
    agents.switchFails = true;
    await factory.invoke("factory.project.configure", {
      projectId: PROJECT,
      role: "factory-intake",
      provider: "codex",
    });
    expect(agents.prompts.length).toBe(sentBefore);

    agents.switchFails = false;
    await factory.tick(PROJECT, "factory-intake");

    expect(agents.switches.at(-1)).toEqual({ agentId: foreman, provider: "codex" });
    expectCharterDelivered(foreman, sentBefore);
  });
});

describe("list, pause_all and resume_all", () => {
  async function threeProjects(factory: ProjectFactoryService) {
    await addProject("prj_paused");
    await addProject("prj_off");
    await enable(factory);
    for (const projectId of ["prj_paused", "prj_off"])
      await factory.invoke("factory.project.enable", {
        projectId,
        repository: `acme/${projectId}`,
      });
    await factory.invoke("factory.project.pause", { projectId: "prj_paused" });
    await factory.invoke("factory.project.disable", { projectId: "prj_off" });
  }

  async function foremanOf(factory: ProjectFactoryService, projectId: string) {
    const state = await factory.get(projectId);
    return roleAgent(state, "factory-intake");
  }

  type Listed = Awaited<ReturnType<ProjectFactoryService["list"]>>;
  const byId = (list: unknown) =>
    Object.fromEntries((list as Listed).projects.map((entry) => [entry.projectId, entry]));

  test("list reports every known project with its state, repository and pause", async () => {
    const factory = service();
    await threeProjects(factory);
    expect(byId(await factory.invoke("factory.project.list", {}))).toEqual({
      [PROJECT]: { projectId: PROJECT, state: "on", repository: REPO, paused: false, drain: null },
      prj_paused: {
        projectId: "prj_paused",
        state: "paused",
        repository: "acme/prj_paused",
        paused: true,
        drain: null,
      },
      prj_off: {
        projectId: "prj_off",
        state: "off",
        repository: "acme/prj_off",
        paused: false,
        drain: null,
      },
    });
  });

  test("pause_all pauses only projects that are on; resume_all resumes only those", async () => {
    const factory = service();
    await threeProjects(factory);

    const paused = byId(
      await factory.invoke("factory.project.pause_all", { reason: "upgrade to 26.11.300" }),
    );
    expect(paused[PROJECT]).toMatchObject({
      state: "paused",
      drain: { id: expect.stringMatching(/^drain-/), reason: "upgrade to 26.11.300", pausedAt: T0 },
    });
    expect(paused.prj_paused).toMatchObject({ state: "paused", drain: null });
    expect(paused.prj_off).toMatchObject({ state: "off", drain: null });
    expect(factory.hasTimer(PROJECT, "factory-intake")).toBe(false);

    const resumed = byId(await factory.invoke("factory.project.resume_all", {}));
    expect(resumed[PROJECT]).toMatchObject({ state: "on", drain: null });
    expect(resumed.prj_paused).toMatchObject({ state: "paused", drain: null });
    expect(resumed.prj_off).toMatchObject({ state: "off" });
    expect(factory.hasTimer(PROJECT, "factory-intake")).toBe(true);
    expect(factory.hasTimer("prj_paused", "factory-intake")).toBe(false);
  });

  test("both are idempotent", async () => {
    const factory = service();
    await threeProjects(factory);
    const empty = byId(await factory.invoke("factory.project.resume_all", {}));
    expect(empty[PROJECT]).toMatchObject({ state: "on", drain: null });

    await factory.invoke("factory.project.pause_all", { reason: "first" });
    clock = new Date(Date.parse(T0) + 60_000);
    const again = byId(await factory.invoke("factory.project.pause_all", { reason: "second" }));
    expect(again[PROJECT]?.drain).toMatchObject({ reason: "first", pausedAt: T0 });
    expect(again.prj_paused?.drain).toBeNull();

    await factory.invoke("factory.project.resume_all", {});
    const twice = byId(await factory.invoke("factory.project.resume_all", {}));
    expect(twice[PROJECT]).toMatchObject({ state: "on", drain: null });
    expect(twice.prj_paused).toMatchObject({ state: "paused" });
  });

  test("a manual pause or resume takes a project out of the drain", async () => {
    const factory = service();
    await threeProjects(factory);
    await factory.invoke("factory.project.pause_all", { reason: "drain before restart" });
    await factory.invoke("factory.project.resume", { projectId: PROJECT });
    await factory.invoke("factory.project.pause", { projectId: PROJECT });

    const resumed = byId(await factory.invoke("factory.project.resume_all", {}));
    expect(resumed[PROJECT]).toMatchObject({ state: "paused", drain: null });
  });

  test("a damaged state file makes list, pause_all and resume_all refuse", async () => {
    const factory = service();
    await enable(factory);
    writeFileSync(projectFactoryStatePath(home), "{");

    for (const [method, input] of [
      ["factory.project.list", {}],
      ["factory.project.pause_all", { reason: "drain before restart" }],
      ["factory.project.resume_all", {}],
    ] as const)
      await expect(factory.invoke(method, input)).rejects.toThrow("damaged");
    expect(factory.hasTimer(PROJECT, "factory-intake")).toBe(true);
    expect(readFileSync(projectFactoryStatePath(home), "utf8")).toBe("{");
  });

  test("pause_all steers one drain notice to each paused Foreman; resume_all ends it", async () => {
    const factory = service();
    await threeProjects(factory);
    const foremen = {
      [PROJECT]: await foremanOf(factory, PROJECT),
      prj_paused: await foremanOf(factory, "prj_paused"),
    };
    agents.busy.add(foremen[PROJECT]!);
    const sentTo = (agentId: string) =>
      agents.prompts.filter((prompt) => prompt.agentId === agentId).map((prompt) => prompt.prompt);
    const before = sentTo(foremen[PROJECT]!).length;

    const drained = byId(
      await factory.invoke("factory.project.pause_all", { reason: "drain before restart" }),
    );
    await factory.invoke("factory.project.pause_all", { reason: "drain before restart" });
    const notice = drainNotice(drained[PROJECT]!.drain!.id);
    expect(notice).toContain(`Drained ${drained[PROJECT]!.drain!.id}: <n> workers`);
    expect(sentTo(foremen[PROJECT]!).slice(before)).toEqual([notice]);
    expect(agents.prompts.at(-1)).toMatchObject({ agentId: foremen[PROJECT], steer: true });
    expect(sentTo(foremen.prj_paused!).some((prompt) => prompt.startsWith("Drain notice"))).toBe(
      false,
    );
    const file = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    expect(file.projects[PROJECT].drain.noticeSentAt).toBe(T0);

    await factory.invoke("factory.project.resume_all", {});
    expect(sentTo(foremen[PROJECT]!).slice(before)).toEqual([notice, DRAIN_ENDED]);
    expect(sentTo(foremen.prj_paused!)).not.toContain(DRAIN_ENDED);
  });

  test("a drain notice that fails is sent by the next pause_all", async () => {
    const factory = service();
    const foreman = roleAgent(await enable(factory), "factory-intake");
    agents.failing.add(foreman);
    await factory.invoke("factory.project.pause_all", { reason: "drain before restart" });
    agents.failing.clear();
    await factory.invoke("factory.project.pause_all", { reason: "drain before restart" });
    await factory.invoke("factory.project.pause_all", { reason: "drain before restart" });
    expect(
      agents.prompts.filter(
        (prompt) => prompt.agentId === foreman && prompt.prompt.startsWith("Drain notice"),
      ),
    ).toHaveLength(1);
  });

  test("a new drain gets a new id and clears an old acknowledgment", async () => {
    const factory = service();
    const foreman = roleAgent(await enable(factory), "factory-intake");
    const setForemanStatus = (line: string) =>
      factory.invoke("factory.project.status.set", {
        projectId: PROJECT,
        role: "factory-intake",
        line,
      });
    const first = byId(
      await factory.invoke("factory.project.pause_all", { reason: "drain before restart" }),
    )[PROJECT]!.drain!;
    await setForemanStatus(`Drained ${first.id}: 0 workers still finishing`);
    await factory.invoke("factory.project.resume_all", {});

    agents.failing.add(foreman);
    const second = byId(
      await factory.invoke("factory.project.pause_all", { reason: "drain before restart" }),
    )[PROJECT]!.drain!;

    expect(second.id).not.toBe(first.id);
    const shown = await factory.get(PROJECT);
    expect(shown.drain?.id).toBe(second.id);
    expect(shown.roles.find((role) => role.role === "factory-intake")?.status).toBeNull();
    const file = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    expect(file.projects[PROJECT].drain.noticeSentAt).toBeUndefined();
  });

  test("notices skip archived and missing projects and stay pending for them", async () => {
    const factory = service();
    await addProject("prj_gone");
    const foreman = roleAgent(await enable(factory), "factory-intake");
    const gone = roleAgent(
      (await factory.invoke("factory.project.enable", {
        projectId: "prj_gone",
        repository: "acme/gone",
      })) as Awaited<ReturnType<typeof enable>>,
      "factory-intake",
    );
    agents.failing.add(foreman);
    agents.failing.add(gone);
    await factory.invoke("factory.project.pause_all", { reason: "drain before restart" });
    agents.failing.clear();
    const record = (await projects.get(PROJECT))!;
    await projects.upsert({ ...record, archivedAt: T0 });
    await projects.remove("prj_gone");
    const before = agents.prompts.length;

    const listed = byId(
      await factory.invoke("factory.project.pause_all", { reason: "drain before restart" }),
    );
    expect(listed[PROJECT]).toMatchObject({ state: "unavailable" });
    expect(listed.prj_gone).toMatchObject({ state: "unavailable" });
    expect(agents.prompts.length).toBe(before);
    const file = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    expect(file.projects[PROJECT].drain.noticeSentAt).toBeUndefined();

    await projects.upsert({ ...record, archivedAt: null });
    await factory.invoke("factory.project.pause_all", { reason: "drain before restart" });
    expect(
      agents.prompts.filter((p) => p.agentId === foreman && p.prompt.startsWith("Drain notice")),
    ).toHaveLength(1);
  });

  test("a legacy drain without an id gets the id-bearing notice once", async () => {
    const factory = service();
    const foreman = roleAgent(await enable(factory), "factory-intake");
    await factory.invoke("factory.project.pause_all", { reason: "drain before restart" });
    factory.stop();
    // A drain recorded before ids existed, whose old notice was already sent.
    const file = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    file.projects[PROJECT].drain = { reason: "legacy", pausedAt: T0, noticeSentAt: T0 };
    writeFileSync(projectFactoryStatePath(home), JSON.stringify(file));
    const notices = () =>
      agents.prompts.filter((p) => p.agentId === foreman && p.prompt.startsWith("Drain notice"));
    const before = notices().length;

    const migrated = service();
    agents.failing.add(foreman);
    await migrated.invoke("factory.project.pause_all", { reason: "drain before restart" });
    expect(notices()).toHaveLength(before);
    agents.failing.clear();
    await migrated.invoke("factory.project.pause_all", { reason: "drain before restart" });
    expect(
      notices()
        .slice(before)
        .map((p) => p.prompt),
    ).toEqual([drainNotice(`drain-${T0}`)]);

    migrated.stop();
    const restarted = service();
    await restarted.start();
    await restarted.invoke("factory.project.pause_all", { reason: "drain before restart" });
    expect(notices().slice(before)).toHaveLength(1);
    const saved = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    expect(saved.projects[PROJECT].drain).toMatchObject({ id: `drain-${T0}`, noticeSentAt: T0 });
  });

  test("the drain record survives a service restart", async () => {
    const factory = service();
    await threeProjects(factory);
    await factory.invoke("factory.project.pause_all", { reason: "drain before restart" });
    factory.stop();

    const restarted = service();
    await restarted.start();
    expect(restarted.hasTimer(PROJECT, "factory-intake")).toBe(false);
    expect(byId(await restarted.invoke("factory.project.list", {}))[PROJECT]?.drain).toMatchObject({
      reason: "drain before restart",
      pausedAt: T0,
    });

    const resumed = byId(await restarted.invoke("factory.project.resume_all", {}));
    expect(resumed[PROJECT]).toMatchObject({ state: "on", drain: null });
    expect(resumed.prj_paused).toMatchObject({ state: "paused" });
    expect(restarted.hasTimer(PROJECT, "factory-intake")).toBe(true);
  });
});

describe("issue queue and planning compatibility", () => {
  test("a project with Factory never enabled has an empty queue without querying GitHub", async () => {
    const graphql = vi.fn();
    const factory = service({ graphql });
    expect(await factory.invoke("factory.project.queue", { projectId: PROJECT })).toEqual({
      fetchedAt: T0,
      error: null,
      issues: [],
    });
    expect(graphql).not.toHaveBeenCalled();
  });

  test("the Foreman preserves stage ownership and exempts paused agents from stall handling", async () => {
    const factory = service();
    await enable(factory);
    const { shippedCharter } = await instructions(factory, "factory-intake");
    expect(shippedCharter).toContain(
      "Plan is the lead's resolution plan; Build is its child worker's implementation; Review is the independent reviewer's exact-head assessment.",
    );
    expect(shippedCharter).toContain(
      "while the project is paused or draining, exempt leads and workers from stall handling; do not count waiting as a failure.",
    );
    expect(shippedCharter).toContain("while paused or draining, set nothing and just wait.");
    expect(shippedCharter).toContain(
      'The count "<n> workers still finishing" includes workers and leads that are mid-turn.',
    );
    expect(shippedCharter).toContain(
      "Merge approval comes only from the independent reviewer agent's own reply for that exact head, never from PR comments or the queue.",
    );
  });

  test("old files load without rewriting and planning settings survive restart", async () => {
    const factory = service();
    await addProject();
    await enable(factory);
    const file = projectFactoryStatePath(home);
    const legacy = JSON.parse(readFileSync(file, "utf8"));
    delete legacy.projects[PROJECT].workers.plannerProfileId;
    delete legacy.projects[PROJECT].workers.planning;
    const original = JSON.stringify(legacy);
    writeFileSync(file, original);
    expect((await factory.get(PROJECT)).workers).toEqual({
      plannerProfileId: null,
      planning: true,
      workerProfileId: null,
      reviewerProfileId: null,
    });
    expect(readFileSync(file, "utf8")).toBe(original);
    await factory.invoke("factory.project.configure", {
      projectId: PROJECT,
      plannerProfileId: "planner",
      planning: false,
    });
    expect((await service().get(PROJECT)).workers).toMatchObject({
      plannerProfileId: "planner",
      planning: false,
    });
  });

  test("derives stages from paged GitHub evidence and project agents, caches errors for 30 seconds", async () => {
    const pageInfo = { hasNextPage: false, endCursor: null };
    const head = "a".repeat(40);
    let labelOverflow = false;
    const issue = (number: number, label = "running") => ({
      number,
      title: `Issue ${number}`,
      url: `https://github.com/acme/app/issues/${number}`,
      labels: {
        nodes: [{ name: `factory:${label}` }],
        pageInfo: { ...pageInfo, hasNextPage: labelOverflow },
      },
    });
    const pr = (number: number, state: string, approval = "", decision: string | null = null) => ({
      number: number + 100,
      url: `https://github.com/acme/app/pull/${number + 100}`,
      headRefName: `feat/factory-issue-${number}`,
      headRefOid: head,
      reviewDecision: decision,
      commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] },
      latestReviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
      comments: {
        nodes: [{ body: `(AI Generated).\n\n${approval}`, author: { login: "foreman" } }],
        pageInfo: { hasPreviousPage: false },
      },
    });
    let fail = false;
    let apiFailure = false;
    let execFailure = false;
    const graphql = vi.fn(async (query: string, variables: Record<string, unknown>) => {
      if (execFailure)
        throw Object.assign(new Error("Command failed: gh api graphql -f query=..."), {
          stderr: "\n gh: Authentication required\nAdditional details",
        });
      if (apiFailure)
        return {
          data: { repository: null },
          errors: [{ message: "Repository access denied\nMore detail" }],
        };
      if (fail) throw new Error("GitHub unavailable\nprivate diagnostic details");
      if (query.includes("issues(first:")) {
        const nodes = variables.cursor
          ? [
              issue(8),
              issue(9),
              issue(10, "human-review"),
              issue(11),
              issue(12),
              issue(13),
              issue(14),
              issue(15),
              issue(16),
              issue(17),
            ]
          : [
              issue(1, "ready"),
              issue(2),
              issue(3),
              issue(4),
              issue(5),
              issue(6),
              issue(7, "blocked"),
            ];
        return {
          data: {
            viewer: { login: "foreman" },
            repository: {
              issues: {
                nodes,
                pageInfo: variables.cursor ? pageInfo : { hasNextPage: true, endCursor: "next" },
              },
            },
          },
        };
      }
      return {
        data: {
          repository: {
            pullRequests: {
              nodes: [
                pr(3, "PENDING"),
                pr(4, "FAILURE"),
                pr(5, "SUCCESS", `APPROVE ${"b".repeat(40)}`),
                pr(6, "SUCCESS", `APPROVE ${head}`),
                pr(7, "SUCCESS", `APPROVE ${head}`),
                pr(8, "SUCCESS", `APPROVE ${head}`, "CHANGES_REQUESTED"),
                pr(9, "SUCCESS", `APPROVE ${head}`),
                {
                  ...pr(11, "SUCCESS"),
                  latestReviews: {
                    nodes: [{ state: "APPROVED", commit: { oid: head } }],
                    pageInfo: { hasPreviousPage: false },
                  },
                },
                pr(12, "SUCCESS", `Review ${head}\n1. Fix the defect.`),
                {
                  ...pr(13, "SUCCESS"),
                  comments: {
                    nodes: [{ body: `APPROVE ${head}`, author: { login: "foreman" } }],
                    pageInfo: { hasPreviousPage: false },
                  },
                },
                pr(14, "SUCCESS", `Review ${"b".repeat(40)}\n1. Stale findings.`),
                pr(15, "SUCCESS", `Review ${head}`),
                {
                  ...pr(16, "SUCCESS"),
                  comments: {
                    nodes: [
                      {
                        body: `(AI Generated).\n\nAPPROVE ${head}`,
                        author: { login: "someone-else" },
                      },
                    ],
                    pageInfo: { hasPreviousPage: false },
                  },
                },
                {
                  ...pr(17, "SUCCESS"),
                  comments: {
                    nodes: [{ body: `(AI Generated).\n\nAPPROVE ${head}`, author: null }],
                    pageInfo: { hasPreviousPage: false },
                  },
                },
              ],
              pageInfo,
            },
          },
        },
      };
    });
    const factory = service({ graphql });
    await addProject();
    const configured = await enable(factory);
    const workspaceId = configured.roles[1]!.workspaceId!;
    agents.add({
      id: "lead",
      workspaceId,
      labels: { "factory.issue": "2", "factory.role": "lead" },
    });
    agents.add({
      id: "foreign-worker",
      workspaceId: "another-project",
      labels: { "factory.issue": "2", "factory.role": "worker" },
    });
    const worker = agents.add({
      id: "worker",
      workspaceId,
      labels: { "factory.issue": "9", "factory.role": "worker" },
    });
    worker.lastStatus = "running";
    const archived = agents.add({
      id: "archived-worker",
      workspaceId,
      labels: { "factory.issue": "2", "factory.role": "worker" },
    });
    archived.archivedAt = T0;
    await factory.invoke("factory.project.disable", { projectId: PROJECT });
    const read = () => factory.invoke("factory.project.queue", { projectId: PROJECT });
    const result = factoryProjectQueue.output.parse(await read());
    expect(result).toMatchObject({
      error: null,
      fetchedAt: T0,
      issues: [
        { number: 1, stage: "queued", pr: null },
        { number: 2, stage: "planning", agents: [{ agentId: "lead", role: "lead" }] },
        { number: 3, stage: "building" },
        { number: 4, stage: "repair" },
        { number: 5, stage: "review" },
        { number: 6, stage: "merging" },
        { number: 7, stage: "blocked" },
        { number: 8, stage: "repair" },
        { number: 9, stage: "building" },
        { number: 10, stage: "review" },
        { number: 11, stage: "merging" },
        { number: 12, stage: "repair" },
        { number: 13, stage: "review" },
        { number: 14, stage: "review" },
        { number: 15, stage: "review" },
        { number: 16, stage: "review" },
        { number: 17, stage: "review" },
      ],
    });
    expect(await read()).toEqual(result);
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(graphql.mock.calls.filter(([query]) => query.includes("viewer { login }")).length).toBe(
      1,
    );
    clock = new Date(clock.getTime() + 30_000);
    fail = true;
    const failure = await read();
    expect(failure).toEqual({
      fetchedAt: clock.toISOString(),
      error: "GitHub unavailable",
      issues: [],
    });
    expect(await read()).toEqual(failure);
    expect(graphql).toHaveBeenCalledTimes(4);
    clock = new Date(clock.getTime() + 30_000);
    fail = false;
    apiFailure = true;
    expect(await read()).toEqual({
      fetchedAt: clock.toISOString(),
      error: "Repository access denied",
      issues: [],
    });
    expect(graphql).toHaveBeenCalledTimes(5);
    clock = new Date(clock.getTime() + 30_000);
    apiFailure = false;
    execFailure = true;
    expect(await read()).toEqual({
      fetchedAt: clock.toISOString(),
      error: "Authentication required",
      issues: [],
    });
    clock = new Date(clock.getTime() + 30_000);
    execFailure = false;
    labelOverflow = true;
    expect(await read()).toEqual({
      fetchedAt: clock.toISOString(),
      error: "Issue labels are incomplete.",
      issues: [],
    });
  });
});
