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
import { ProjectFactoryService, type PromptOutcome } from "./service.js";
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

function service(): ProjectFactoryService {
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
