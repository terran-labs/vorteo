import { FactoryQueueSnapshots } from "./queue-cache.js";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ProjectFactoryQueue,
  ProjectFactoryInstructions,
  ProjectFactoryRoleId,
} from "@getpaseo/server/factory-project";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import type { CreateAgentCommandInput } from "../../agent/create-agent/create.js";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
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
import {
  daemonFactoryAccounts,
  readDestinationAccounts,
  type DestinationHosts,
  type FactoryAccounts,
  type InstallationAccountsAuthority,
} from "./account-choice.js";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { FactoryGitHub, GitHubResponse } from "./claims.js";
import type { GhRunner } from "./tick-gate.js";
import { projectFactoryStatePath } from "./state.js";
import type { DevAgent, IssueAgentHosts } from "./issue-agent-host.js";
import { DEV_HOST_SOURCE_KEY } from "../../execution-installation/dev-host-link.js";
import type { HostSummary } from "@getpaseo/protocol/hosts";
import {
  createFactoryHomeAuthority,
  type FactoryHomePort,
} from "../../execution-installation/factory-home.js";

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
let github: FakeGitHub;
let accounts: FactoryAccounts;
let issueHosts: IssueAgentHosts;

const MAIN = "m".repeat(40);

/** One shared GitHub repository: ref creation is atomic, as on GitHub. */
class FakeGitHub implements FactoryGitHub {
  readonly refs = new Map<string, string>([["heads/main", MAIN]]);
  readonly comments = new Map<number, { body: string; updated_at: string }[]>();
  readonly commitDates = new Map<string, string>();
  factoryJson: string | null = null;
  /** Creates the next ref, then fails as if the daemon crashed before reading the response. */
  crashAfterCreate = false;
  /** Runs before a ref is created, as another installation acting in that moment would. */
  beforeCreate: (() => Promise<void>) | null = null;

  async rest(method: string, route: string, body?: unknown): Promise<GitHubResponse> {
    const resource = route.replace(/^repos\/[^/]+\/[^/]+/, "");
    const response =
      method === "GET" ? this.read(resource) : await this.write(method, resource, body);
    if (!response) throw new Error(`unexpected GitHub call ${method} ${route}`);
    return response;
  }

  private read(resource: string): GitHubResponse | null {
    const ok = (value: unknown) => ({ status: 200, body: value });
    const missing = { status: 404, body: { message: "Not Found" } };
    if (resource === "") return ok({ default_branch: "main" });
    if (resource.startsWith("/git/ref/")) {
      const sha = this.refs.get(resource.slice("/git/ref/".length));
      return sha ? ok({ ref: `refs/${resource.slice(9)}`, object: { sha } }) : missing;
    }
    if (resource.startsWith("/git/matching-refs/")) {
      const prefix = resource.slice("/git/matching-refs/".length);
      return ok(
        [...this.refs]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, sha]) => ({ ref: `refs/${name}`, object: { sha } })),
      );
    }
    const comments = /^\/issues\/(\d+)\/comments/.exec(resource);
    if (comments) return ok(this.comments.get(Number(comments[1])) ?? []);
    if (resource.startsWith("/pulls?")) return ok([]);
    if (resource.startsWith("/git/commits/"))
      return ok({ committer: { date: this.commitDates.get(resource.slice(13)) ?? T0 } });
    if (resource === "/contents/.github/factory.json")
      return this.factoryJson === null
        ? missing
        : ok({ content: Buffer.from(this.factoryJson).toString("base64"), encoding: "base64" });
    return null;
  }

  private async write(
    method: string,
    resource: string,
    body: unknown,
  ): Promise<GitHubResponse | null> {
    if (method === "POST" && resource === "/git/refs") {
      await this.beforeCreate?.();
      const { ref, sha } = body as { ref: string; sha: string };
      const name = ref.replace(/^refs\//, "");
      if (this.refs.has(name))
        return { status: 422, body: { message: "Reference already exists" } };
      this.refs.set(name, sha);
      if (this.crashAfterCreate) {
        this.crashAfterCreate = false;
        throw new Error("daemon stopped");
      }
      return { status: 201, body: { ref, object: { sha } } };
    }
    const rename = /^\/branches\/([^/]+)\/rename$/.exec(resource);
    if (method === "POST" && rename) {
      // GitHub moves the branch and its commits to the new name in one step.
      const from = `heads/${decodeURIComponent(rename[1]!)}`;
      const sha = this.refs.get(from);
      if (!sha) return { status: 404, body: { message: "Branch not found" } };
      this.refs.delete(from);
      this.refs.set(`heads/${(body as { new_name: string }).new_name}`, sha);
      return { status: 201, body: { commit: { sha } } };
    }
    if (method === "DELETE" && resource.startsWith("/git/refs/")) {
      this.refs.delete(resource.slice("/git/refs/".length));
      return { status: 204, body: null };
    }
    return null;
  }
}

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
  readonly initialPrompts = new Map<string, string | undefined>();
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
    this.initialPrompts.set(id, input.initialPrompt ?? undefined);
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

function service(
  gh?: GhRunner,
  installation: { paseoHome?: string; serverId?: string; home?: FactoryHomePort } = {},
): ProjectFactoryService {
  const instance = new ProjectFactoryService({
    paseoHome: installation.paseoHome ?? home,
    serverId: installation.serverId ?? "srv_test",
    home: installation.home,
    github,
    accounts,
    hosts: () => issueHosts,
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
  github = new FakeGitHub();
  issueHosts = {
    directory: async () => ({ self: { serverId: "srv_test", label: "Host" }, hosts: [] }),
    use: async () => {
      throw new Error("no connected hosts");
    },
  };
  accounts = {
    readyProviders: async () => [],
    providerType: () => null,
    profileAccount: () => null,
    readUsage: async () => ({ fetchedAt: T0, providers: [] }),
    defaultProvider: async () => null,
    destinationAccounts: async () => new Map(),
  };
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
      issueAgents: "dev",
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
  test("serves a saved queue while one refresh runs and keeps it through failures and pauses", async () => {
    const directory = path.join(home, "factory", "queues");
    mkdirSync(directory, { recursive: true });
    const saved: ProjectFactoryQueue = {
      fetchedAt: T0,
      error: null,
      issues: [
        {
          number: 1,
          title: "Issue",
          url: "https://example.test/1",
          label: "running",
          stage: "building",
          pr: null,
          agents: [],
        },
      ],
    };
    writeFileSync(
      path.join(directory, `${PROJECT}.json`),
      JSON.stringify({ repository: REPO, queue: saved }),
    );
    const snapshots = new FactoryQueueSnapshots(directory, logger);
    let calls = 0;
    let complete: ((snapshot: ProjectFactoryQueue) => void) | undefined;
    const pending = new Promise<ProjectFactoryQueue>((resolve) => {
      complete = resolve;
    });
    const input = {
      projectId: PROJECT,
      repository: REPO,
      enabled: true,
      paused: true,
      now: clock,
      refresh: () => {
        calls += 1;
        return pending;
      },
    };
    expect(await snapshots.read(input)).toEqual({ ...saved, refreshing: false });
    expect(calls).toBe(0);
    input.paused = false;
    expect(await snapshots.read(input)).toEqual({ ...saved, refreshing: true });
    expect(await snapshots.read(input)).toEqual({ ...saved, refreshing: true });
    expect(calls).toBe(1);
    const updated = { ...saved, fetchedAt: new Date(clock.getTime() + 1_000).toISOString() };
    if (!complete) throw new Error("Refresh was not prepared");
    complete(updated);
    await vi.waitFor(async () => {
      expect((await snapshots.read(input)).refreshing).toBe(false);
    });
    const restarted = new FactoryQueueSnapshots(directory, logger);
    expect(await restarted.read({ ...input, paused: true })).toEqual({
      ...updated,
      refreshing: false,
    });
    expect(calls).toBe(1);
    const failed = {
      ...input,
      now: new Date(clock.getTime() + 30_000),
      refresh: async () => {
        throw new Error("GitHub timed out");
      },
    };
    expect(await snapshots.read(failed)).toEqual({ ...updated, refreshing: true });
    await vi.waitFor(async () => {
      expect((await snapshots.read(failed)).refreshing).toBe(false);
    });
    expect(await snapshots.read({ ...failed, paused: true })).toEqual({
      ...updated,
      error: "GitHub timed out",
      issueAgentHost: null,
      refreshing: false,
    });
    const degraded = {
      ...input,
      now: new Date(clock.getTime() + 60_000),
      refresh: async () => ({
        ...updated,
        fetchedAt: new Date(clock.getTime() + 60_000).toISOString(),
        error: "Host agent list timed out.",
        partial: true,
        issues: [],
      }),
    };
    expect((await snapshots.read(degraded)).refreshing).toBe(true);
    await vi.waitFor(async () => {
      expect((await snapshots.read(degraded)).refreshing).toBe(false);
    });
    expect(await snapshots.read(degraded)).toMatchObject({
      ...updated,
      error: "Host agent list timed out.",
      partial: true,
      refreshing: false,
    });
    const afterPartial = new FactoryQueueSnapshots(directory, logger);
    expect(await afterPartial.read({ ...input, paused: true })).toEqual({
      ...updated,
      refreshing: false,
    });
    const devUnavailable: ProjectFactoryQueue = {
      ...updated,
      fetchedAt: new Date(clock.getTime() + 90_000).toISOString(),
      issues: [{ ...saved.issues[0]!, title: "Fresh GitHub title" }],
      partial: false,
      degraded: "Dev agent data unavailable: offline",
      issueAgentHost: { serverId: "dev", unavailable: "offline" },
    };
    const devInput = {
      ...input,
      now: new Date(clock.getTime() + 90_000),
      refresh: async () => devUnavailable,
    };
    await snapshots.read(devInput);
    await vi.waitFor(async () => {
      expect((await snapshots.read(devInput)).refreshing).toBe(false);
    });
    expect(await snapshots.read(devInput)).toEqual({ ...devUnavailable, refreshing: false });
    const afterDevLoss = new FactoryQueueSnapshots(directory, logger);
    expect(await afterDevLoss.read({ ...input, paused: true })).toEqual({
      ...devUnavailable,
      refreshing: false,
    });
  });

  test("a cold paused queue takes one non-error snapshot read while a disabled Factory takes none", async () => {
    const snapshots = new FactoryQueueSnapshots(path.join(home, "factory", "cold-queues"), logger);
    let calls = 0;
    let complete: ((snapshot: ProjectFactoryQueue) => void) | undefined;
    const pending = new Promise<ProjectFactoryQueue>((resolve) => {
      complete = resolve;
    });
    const input = {
      projectId: PROJECT,
      repository: REPO,
      paused: true,
      enabled: false,
      now: clock,
      refresh: () => {
        calls += 1;
        return pending;
      },
    };
    expect(await snapshots.read(input)).toEqual({
      fetchedAt: T0,
      error: null,
      issues: [],
      refreshing: false,
    });
    expect(calls).toBe(0);
    input.enabled = true;
    expect(await snapshots.read(input)).toEqual({
      fetchedAt: T0,
      error: null,
      issues: [],
      refreshing: true,
    });
    expect((await snapshots.read(input)).refreshing).toBe(true);
    expect(calls).toBe(1);
    if (!complete) throw new Error("Cold refresh was not prepared");
    complete({ fetchedAt: T0, error: null, issues: [] });
    await vi.waitFor(async () => {
      expect((await snapshots.read(input)).refreshing).toBe(false);
    });
    expect(calls).toBe(1);
    let retries = 0;
    const failedCold = {
      ...input,
      projectId: "failed-cold",
      refresh: async () => {
        retries += 1;
        if (retries === 1) throw new Error("Temporary GitHub failure");
        return { fetchedAt: T0, error: null, issues: [] };
      },
    };
    await snapshots.read(failedCold);
    await vi.waitFor(async () => {
      expect((await snapshots.read(failedCold)).refreshing).toBe(false);
    });
    await snapshots.read({ ...failedCold, now: new Date(clock.getTime() + 30_000) });
    expect(retries).toBe(1);
    const retry = { ...failedCold, now: new Date(clock.getTime() + 5 * 60_000) };
    await snapshots.read(retry);
    await vi.waitFor(async () => {
      expect((await snapshots.read(retry)).refreshing).toBe(false);
    });
    expect(retries).toBe(2);
  });

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

  test("old files load without rewriting and planning and issue-agent settings survive restart", async () => {
    const factory = service();
    await addProject();
    await enable(factory);
    const file = projectFactoryStatePath(home);
    const legacy = JSON.parse(readFileSync(file, "utf8"));
    delete legacy.projects[PROJECT].workers.plannerProfileId;
    delete legacy.projects[PROJECT].workers.planning;
    const original = JSON.stringify(legacy);
    writeFileSync(file, original);
    // A Factory saved before the setting existed runs new issue agents in Dev.
    expect((await factory.get(PROJECT)).workers).toEqual({
      plannerProfileId: null,
      planning: true,
      workerProfileId: null,
      reviewerProfileId: null,
      issueAgents: "dev",
    });
    expect(readFileSync(file, "utf8")).toBe(original);
    await factory.invoke("factory.project.configure", {
      projectId: PROJECT,
      plannerProfileId: "planner",
      planning: false,
      issueAgents: "host",
    });
    const restarted = await service().get(PROJECT);
    expect(restarted.workers).toMatchObject({
      plannerProfileId: "planner",
      planning: false,
      issueAgents: "host",
    });
    expect(restarted).not.toHaveProperty("issueAgentHost");
  });

  test("derives stages from paged GitHub evidence and project agents, retains stale snapshots on read errors for 30 seconds", async () => {
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
    // Issue agents run in Dev by default. Dev's workspace ids differ, so its agents count by
    // this installation's label; another installation's agent on the same Dev does not.
    const devAgent = (
      id: string,
      installation: string,
      number: string,
      role: string,
    ): DevAgent => ({
      id,
      status: "idle",
      labels: {
        "factory.installation": installation,
        "factory.issue": number,
        "factory.role": role,
      },
    });
    let devReadable = true;
    let devEnabled = true;
    const saved = (sourceId: string, serverId: string, enabled: boolean): HostSummary => ({
      registrationId: `reg_${serverId}`,
      serverId,
      label: "Dev container",
      source: { id: sourceId, key: DEV_HOST_SOURCE_KEY },
      metadata: {},
      enabled,
      status: enabled ? "online" : "disabled",
      targetDescription: serverId,
      lastOnlineAt: T0,
      nextRetryAt: null,
      error: null,
    });
    issueHosts = {
      // Another producer may save its own server under the Dev key; only the owner's counts.
      directory: async () => ({
        self: { serverId: "srv_test", label: "Host" },
        hosts: [saved("plugin:rogue", "srv_rogue", true), saved("owner", "srv_dev", devEnabled)],
      }),
      async use(serverId, action) {
        if (serverId !== "srv_dev" || !devReadable) throw new Error("Dev route closed");
        return action({
          fetchAgents: async () => ({
            entries: [
              devAgent("dev-lead", `srv_test/${PROJECT}`, "1", "lead"),
              devAgent("rival-worker", `srv_rival/${PROJECT}`, "1", "worker"),
            ].map((agent) => ({ agent })),
            pageInfo: { nextCursor: null, hasMore: false },
          }),
        });
      },
    };
    expect((await factory.get(PROJECT)).issueAgentHost).toEqual({
      serverId: "srv_dev",
      unavailable: null,
    });
    // The owner's opt-out holds even while the other producer's entry is online.
    devEnabled = false;
    expect((await factory.get(PROJECT)).issueAgentHost).toEqual({
      serverId: "srv_dev",
      unavailable: "the Dev host is turned off",
    });
    devEnabled = true;
    factory.stop();
    const read = async () => {
      let response = factoryProjectQueue.output.parse(
        await factory.invoke("factory.project.queue", { projectId: PROJECT }),
      );
      await vi.waitFor(async () => {
        response = factoryProjectQueue.output.parse(
          await factory.invoke("factory.project.queue", { projectId: PROJECT }),
        );
        expect(response.refreshing).not.toBe(true);
      });
      return response;
    };
    const result = factoryProjectQueue.output.parse(await read());
    expect(result).toMatchObject({
      error: null,
      fetchedAt: T0,
      issueAgentHost: { serverId: "srv_dev", unavailable: null },
      issues: [
        {
          number: 1,
          stage: "planning",
          pr: null,
          agents: [{ agentId: "dev-lead", role: "lead", serverId: "srv_dev" }],
        },
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
      ...result,
      issueAgentHost: null,
      error: "GitHub unavailable",
    });
    expect(await read()).toEqual(failure);
    expect(graphql).toHaveBeenCalledTimes(4);
    clock = new Date(clock.getTime() + 30_000);
    fail = false;
    apiFailure = true;
    expect(await read()).toEqual({
      ...result,
      issueAgentHost: null,
      error: "Repository access denied",
    });
    expect(graphql).toHaveBeenCalledTimes(5);
    clock = new Date(clock.getTime() + 30_000);
    apiFailure = false;
    execFailure = true;
    expect(await read()).toEqual({
      ...result,
      issueAgentHost: null,
      error: "Authentication required",
    });
    clock = new Date(clock.getTime() + 30_000);
    execFailure = false;
    labelOverflow = true;
    expect(await read()).toEqual({
      ...result,
      issueAgentHost: null,
      error: "Issue labels are incomplete.",
    });
    // After a switch to host mode, the Dev lead still running keeps its issue's stage.
    clock = new Date(clock.getTime() + 30_000);
    labelOverflow = false;
    await factory.invoke("factory.project.configure", { projectId: PROJECT, issueAgents: "host" });
    const switched = factoryProjectQueue.output.parse(await read());
    expect(switched.issues[0]).toMatchObject({
      number: 1,
      stage: "planning",
      agents: [{ agentId: "dev-lead", serverId: "srv_dev" }],
    });
    // An unreadable Dev still renders this host's agents and says why Dev's are missing.
    clock = new Date(clock.getTime() + 30_000);
    devReadable = false;
    const local = factoryProjectQueue.output.parse(await read());
    expect(local.issueAgentHost).toEqual({
      serverId: "srv_dev",
      unavailable: "Dev's agents could not be read: Dev route closed",
    });
    expect(local.issues.slice(0, 2)).toMatchObject([
      { number: 1, stage: "queued", agents: [] },
      { number: 2, stage: "planning", agents: [{ agentId: "lead", role: "lead" }] },
    ]);
  });
});

describe("several installations on one repository", () => {
  const RIVAL = "srv_rival/prj_app";
  const claim = (target: ProjectFactoryService, issue: number) =>
    target.invoke("factory.project.claim", { projectId: PROJECT, issue }) as Promise<{
      outcome: string;
      marker: string | null;
      headSha: string | null;
    }>;
  const release = (target: ProjectFactoryService, issue: number) =>
    target.invoke("factory.project.claim.release", { projectId: PROJECT, issue });
  async function rival(serverId = "srv_rival") {
    const rivalHome = mkdtempSync(path.join(os.tmpdir(), `vorteo-project-factory-${serverId}-`));
    const other = service(undefined, { paseoHome: rivalHome, serverId });
    await enable(other);
    return other;
  }

  test("two simultaneous claims produce one owner; the other never adopts it", async () => {
    const ours = service();
    await enable(ours);
    const theirs = await rival();

    const outcomes = await Promise.all([claim(ours, 7), claim(theirs, 7)]);
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["claimed", "foreign"]);
    const loser = outcomes[0]!.outcome === "foreign" ? ours : theirs;
    // A 422 is someone else's branch: asking again never turns it into this installation's.
    expect((await claim(loser, 7)).outcome).toBe("foreign");
    const winner = loser === ours ? theirs : ours;
    const held = await claim(winner, 7);
    expect(held.outcome).toBe("held");
    expect(held.marker).toContain("<!-- factory-claim v1 installation=");
    expect(github.refs.get("heads/factory/issue-7")).toBe(MAIN);
  });

  test("a crash between creating the branch and recording it recovers as this installation's", async () => {
    const ours = service();
    await enable(ours);
    github.crashAfterCreate = true;
    await expect(claim(ours, 8)).rejects.toThrow("daemon stopped");

    const restarted = service();
    expect(await claim(restarted, 8)).toMatchObject({ outcome: "held", headSha: MAIN });
    // Turning Factory off and on again keeps this installation's claims.
    await restarted.invoke("factory.project.disable", { projectId: PROJECT });
    await enable(restarted);
    expect((await claim(restarted, 8)).outcome).toBe("held");

    // The same crash while another installation had posted its marker is not recovered as ours.
    github.crashAfterCreate = true;
    await expect(claim(restarted, 9)).rejects.toThrow("daemon stopped");
    github.comments.set(9, [
      {
        body: `<!-- factory-claim v1 installation=${RIVAL} branch=factory/issue-9 -->`,
        updated_at: T0,
      },
    ]);
    // GitHub cannot tell that rival from this installation's own branch, so the owner decides.
    expect((await claim(restarted, 9)).outcome).toBe("conflict");

    // So does a release archived since the intent; the question stands until the owner keeps it.
    github.crashAfterCreate = true;
    await expect(claim(restarted, 11)).rejects.toThrow("daemon stopped");
    github.refs.set("heads/factory-released/issue-11/20261103T110000Z", MAIN);
    expect((await claim(restarted, 11)).outcome).toBe("conflict");
    expect((await claim(restarted, 11)).outcome).toBe("conflict");
    const keptAfterArchive = await restarted.invoke("factory.project.claim", {
      projectId: PROJECT,
      issue: 11,
      keep: true,
    });
    expect(keptAfterArchive).toMatchObject({ outcome: "held" });
    expect((await claim(restarted, 11)).outcome).toBe("held");

    // A rival marker on a held branch is a conflict until the owner picks this installation.
    github.comments.set(8, [
      {
        body: `<!-- factory-claim v1 installation=${RIVAL} branch=factory/issue-8 -->`,
        updated_at: T0,
      },
    ]);
    expect((await claim(restarted, 8)).outcome).toBe("conflict");
    expect((await claim(restarted, 8)).outcome).toBe("conflict");
    const kept = await restarted.invoke("factory.project.claim", {
      projectId: PROJECT,
      issue: 8,
      keep: true,
    });
    expect(kept).toMatchObject({ outcome: "held" });
    expect((await claim(restarted, 8)).outcome).toBe("held");
  });

  test("a stale foreign claim is raised once and released only into an archive", async () => {
    const ours = service();
    const foreman = roleAgent(await enable(ours), "factory-intake");
    const theirs = await rival();
    expect((await claim(theirs, 5)).outcome).toBe("claimed");
    github.commitDates.set(MAIN, "2026-11-01T00:00:00.000Z");
    const staleTicks = () =>
      agents.prompts.filter(
        (prompt) => prompt.agentId === foreman && prompt.prompt.includes("Stale Factory claims"),
      );

    // First seen now, so an old base commit alone is not stale.
    await ours.tick(PROJECT, "factory-intake");
    expect(staleTicks()).toHaveLength(0);
    await expect(release(ours, 5)).rejects.toThrow("Ask the owner first");

    clock = new Date(Date.parse(T0) + 25 * 60 * 60_000);
    await ours.tick(PROJECT, "factory-intake");
    await ours.tick(PROJECT, "factory-intake");
    expect(staleTicks()).toHaveLength(1);
    expect(staleTicks()[0]!.prompt).toContain("factory/issue-5");

    // A push since the owner was asked makes the claim active again.
    github.refs.set("heads/factory/issue-5", "p".repeat(40));
    await expect(release(ours, 5)).rejects.toThrow("Ask the owner first");
    github.refs.set("heads/factory/issue-5", MAIN);

    expect(await release(ours, 5)).toMatchObject({ outcome: "archived", headSha: MAIN });
    expect(github.refs.has("heads/factory/issue-5")).toBe(false);
    expect([...github.refs].filter(([name]) => name.startsWith("heads/factory-released/"))).toEqual(
      [["heads/factory-released/issue-5/20261104T130000Z", MAIN]],
    );
    // A third installation claims the freed issue at the same commit; the archive already
    // existed when it claimed, so only the former owner reads it as a release.
    const third = await rival("srv_third");
    expect((await claim(third, 5)).outcome).toBe("claimed");
    expect((await claim(theirs, 5)).outcome).toBe("lost");
    expect((await claim(third, 5)).outcome).toBe("held");

    // A release landing between a claimant's first archive read and its branch creation does
    // not read as that claimant's release.
    github.refs.set("heads/factory/issue-6", MAIN);
    github.beforeCreate = async () => {
      github.beforeCreate = null;
      github.refs.delete("heads/factory/issue-6");
      github.refs.set("heads/factory-released/issue-6/20261104T130000Z", MAIN);
    };
    expect((await claim(third, 6)).outcome).toBe("claimed");
    expect((await claim(third, 6)).outcome).toBe("held");
  });

  test("factory.json turns Triage and Releases off unless it names this installation", async () => {
    github.factoryJson = JSON.stringify({
      version: 1,
      triage: RIVAL,
      releases: `srv_test/${PROJECT}`,
    });
    const ours = service();
    const state = await enable(ours);
    const triage = roleAgent(state, "factory-triage");
    const releases = roleAgent(state, "factory-releases");
    // Turning Factory on never starts a Triage pass another installation owns.
    expect(agents.initialPrompts.get(triage)).toContain("Do nothing now");
    expect(agents.initialPrompts.get(releases)).not.toContain("Do nothing now");
    const woke = (agentId: string) =>
      agents.prompts.filter((prompt) => prompt.agentId === agentId).length;

    await ours.tick(PROJECT, "factory-triage");
    await ours.tick(PROJECT, "factory-releases");
    expect(woke(triage)).toBe(0);
    expect(woke(releases)).toBe(1);
    const shown = await ours.get(PROJECT);
    expect(shown.installation).toBe(`srv_test/${PROJECT}`);
    expect(shown.assignment).toMatchObject({ source: "file", triage: RIVAL });
    expect(shown.roles.find((role) => role.role === "factory-triage")?.status?.line).toBe(
      `Off here: .github/factory.json assigns Triage to ${RIVAL}`,
    );

    github.factoryJson = null;
    await ours.tick(PROJECT, "factory-triage");
    expect(woke(triage)).toBe(1);
    expect(
      (await ours.get(PROJECT)).roles.find((role) => role.role === "factory-triage")?.status,
    ).toBeNull();
  });

  test("refuses a second project for a repository this installation already runs", async () => {
    await enable(service());
    await addProject("prj_other");
    await expect(
      service().invoke("factory.project.enable", {
        projectId: "prj_other",
        repository: "Acme/App",
      }),
    ).rejects.toThrow(`Project ${PROJECT} already runs Factory for Acme/App`);
  });
});

describe("one Factory home per installation", () => {
  /** A Host and a Dev daemon with their own state, decided by the coordinator's authority. */
  function installation() {
    const daemons: Partial<Record<"host" | "container", ProjectFactoryService>> = {};
    const reachable = { host: true, container: true };
    const authority = createFactoryHomeAuthority({
      environments: ["host", "container"],
      read: async (kind) => {
        const daemon = daemons[kind];
        if (!daemon || !reachable[kind]) throw new Error(`${kind} is down`);
        return daemon.list();
      },
    });
    const port = (environment: "host" | "container"): FactoryHomePort => ({
      environment,
      ask: (request) => authority.decide(environment, request),
    });
    const devHome = mkdtempSync(path.join(os.tmpdir(), "vorteo-project-factory-dev-"));
    const start = (environment: "host" | "container", withHome = true) =>
      (daemons[environment] = service(undefined, {
        paseoHome: environment === "host" ? home : devHome,
        serverId: environment === "host" ? "srv_host" : "srv_dev",
        home: withHome ? port(environment) : undefined,
      }));
    return { start, reachable };
  }

  test("Dev refuses a repository the Host runs, names the Host and keeps nothing", async () => {
    const { start, reachable } = installation();
    const host = start("host");
    const dev = start("container");
    const enabled = await enable(host);
    expect(enabled.home).toEqual({ environment: "host", projectId: PROJECT, here: true });
    const created = agents.created;

    await expect(enable(dev)).rejects.toThrow("runs in the Host environment");
    expect((await dev.list()).projects).toEqual([]);
    expect(agents.created).toBe(created);

    // Neither environment claims a home it cannot confirm with the other.
    await host.invoke("factory.project.disable", { projectId: PROJECT });
    reachable.host = false;
    await expect(enable(dev)).rejects.toThrow("unconfirmed");
    reachable.host = true;
    await enable(dev);
    reachable.container = false;
    await expect(enable(host)).rejects.toThrow("unconfirmed");
    expect((await host.list()).projects.find((p) => p.projectId === PROJECT)?.state).toBe("off");
    // Two environments turning Factory on at once never both win.
    reachable.container = true;
    await dev.invoke("factory.project.disable", { projectId: PROJECT });
    const results = await Promise.allSettled([enable(host), enable(dev)]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeLessThan(2);
  });

  test("an existing Host Factory keeps running; a Dev Factory from an earlier release stands down", async () => {
    const { start, reachable } = installation();
    // Both were turned on before the home lock existed; Dev's clone is its own project.
    const foreman = roleAgent(await enable(start("host", false)), "factory-intake");
    await addProject("prj_dev");
    const devForeman = roleAgent(
      (await start("container", false).invoke("factory.project.enable", {
        projectId: "prj_dev",
        repository: REPO,
      })) as Awaited<ReturnType<typeof enable>>,
      "factory-intake",
    );

    const host = start("host");
    const dev = start("container");
    await host.start();
    await dev.start();
    expect(host.hasTimer(PROJECT, "factory-intake")).toBe(true);
    expect((await host.get(PROJECT)).home).toEqual({
      environment: "host",
      projectId: PROJECT,
      here: true,
    });

    await host.tick(PROJECT, "factory-intake");
    await dev.tick("prj_dev", "factory-intake");
    expect(agents.prompts.filter((prompt) => prompt.agentId === foreman)).toHaveLength(1);
    expect(agents.prompts.filter((prompt) => prompt.agentId === devForeman)).toHaveLength(0);
    const state = await dev.get("prj_dev");
    expect(state.home).toEqual({ environment: "host", projectId: PROJECT, here: false });
    expect(state.roles.find((role) => role.role === "factory-intake")?.status?.line).toBe(
      `Off here: Factory home is the Host environment, which runs ${REPO}.`,
    );

    // An unanswered check keeps the recorded decision, also after a restart.
    reachable.host = false;
    await dev.tick("prj_dev", "factory-intake");
    await start("container").tick("prj_dev", "factory-intake");
    expect(agents.prompts.filter((prompt) => prompt.agentId === devForeman)).toHaveLength(0);
  });
});

describe("account choice for new Factory agents", () => {
  test("picks the fresh account with the most remaining quota and records it", async () => {
    const factory = service();
    await enable(factory);
    await factory.invoke("factory.project.configure", {
      projectId: PROJECT,
      workerProfileId: "shared-profile/codex/primary-direct",
    });
    const fresh = T0;
    const reading = (providerId: string, remaining: (number | null)[], fetchedAt = fresh) => ({
      providerId,
      status: "available" as const,
      fetchedAt,
      windows: remaining.map((remainingPct, index) => ({
        id: `w${index}`,
        label: `w${index}`,
        remainingPct,
      })),
    });
    let ready = ["codex-a", "codex-b", "codex-stale", "codex-out", "codex-unknown", "claude-x"];
    accounts = {
      readyProviders: async () => ready,
      providerType: ({ provider, profileId }) =>
        (profileId ?? provider ?? "").includes("claude") ? "claude" : "codex",
      profileAccount: (profileId) => (profileId === "local-codex" ? "codex-a" : null),
      readUsage: async () => ({
        fetchedAt: T0,
        providers: [
          reading("codex-a", [80, 40]),
          reading("codex-b", [70, 90]),
          reading("codex-stale", [99], "2026-11-03T11:50:00.000Z"),
          reading("codex-out", [0, 50]),
          reading("codex-unknown", [null]),
          reading("claude-x", [100]),
        ] as never,
      }),
      defaultProvider: async () => "codex-a",
      destinationAccounts: async () => new Map(),
    };
    const pick = (avoid?: string) =>
      service().invoke("factory.project.pick_account", {
        projectId: PROJECT,
        stage: "worker",
        issue: 7,
        ...(avoid ? { avoid } : {}),
      }) as Promise<{ provider: string | null; considered: { verdict: string }[] }>;

    const best = await pick();
    expect(best).toMatchObject({ provider: "codex-b", remainingPct: 70 });
    // Only accounts of the profile's provider type are considered.
    expect(best.considered.map((item) => item.verdict)).toEqual([
      "qualifies",
      "qualifies",
      "stale",
      "exhausted",
      "unknown",
    ]);
    // A reviewer leaves the worker's account out.
    expect((await pick("codex-b")).provider).toBe("codex-a");
    // With nothing qualifying, the Foreman falls back to the configured default.
    ready = ["codex-stale", "codex-out"];
    expect((await pick()).provider).toBeNull();
    // So it does when usage cannot be read at all.
    ready = ["codex-a", "codex-b"];
    const readUsage = accounts.readUsage;
    accounts.readUsage = async () => {
      throw new Error("usage service down");
    };
    expect((await pick()).provider).toBeNull();
    accounts.readUsage = readUsage;
    // A profile bound to one account launches there, unranked: another account would not match it.
    await factory.invoke("factory.project.configure", {
      projectId: PROJECT,
      workerProfileId: "local-codex",
    });
    expect(await pick()).toMatchObject({ provider: "codex-a", bound: true, considered: [] });
    // A bound reviewer cannot leave the worker's account, so nothing qualifies.
    expect(await pick("codex-a")).toMatchObject({ provider: null, bound: true });

    // Turning Factory off and on again keeps the history.
    await factory.invoke("factory.project.disable", { projectId: PROJECT });
    await enable(factory);
    const state = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    expect(
      state.projects[PROJECT].accountPicks.map(
        (item: { provider: string | null }) => item.provider,
      ),
    ).toEqual(["codex-b", "codex-a", null, null, "codex-a", null]);
  });

  test("the daemon's accounts date a reading by its usage list when it has no time of its own", async () => {
    accounts = daemonFactoryAccounts({
      providers: {
        listProviders: async () => [{ provider: "codex", enabled: true, status: "ready" }] as never,
      },
      readUsage: async () => ({
        fetchedAt: T0,
        providers: [
          {
            providerId: "codex",
            status: "available",
            windows: [{ id: "weekly", label: "Weekly", remainingPct: 48 }],
          },
        ] as never,
      }),
      // A standalone daemon launches only with a chosen primary connection, so name codex.
      getSettings: () => ({ primaryConnection: { provider: "codex" } }) as never,
      hosts: () => ({
        use: async () => {
          throw new Error("no connected hosts");
        },
      }),
      serverId: "srv_test",
      readInstallationSettings: async () => null,
    });
    const factory = service();
    await enable(factory);
    expect(
      await factory.invoke("factory.project.pick_account", { projectId: PROJECT, stage: "worker" }),
    ).toMatchObject({ provider: "codex", remainingPct: 48 });
  });

  test("an agent bound for another host starts on that host's id for the same account", async () => {
    // a2 aliases a only through a local installation account id; lookalike has the same id on
    // both hosts but no definition, so nothing proves it is one account.
    const host: Record<string, { shared?: string; remainingPct: number }> = {
      "codex-host-a": { shared: "acct-a", remainingPct: 40 },
      "codex-host-a2": { shared: "acct-a", remainingPct: 95 },
      "codex-host-b": { shared: "acct-b", remainingPct: 90 },
      "codex-host-c": { shared: "acct-c", remainingPct: 60 },
      "codex-account-same": { remainingPct: 85 },
      "codex-lookalike": { remainingPct: 99 },
    };
    const usage = (providerId: string, remainingPct: number): ProviderUsage => ({
      providerId,
      displayName: providerId,
      status: "available",
      planLabel: null,
      windows: [{ id: "weekly", label: "Weekly", remainingPct }],
    });
    const definition = (
      id: string,
      bindings: Record<string, string>,
      extra: Partial<InstallationProvider> = {},
    ): InstallationProvider => ({ id, providerType: "codex", bindings, policy: {}, ...extra });
    let authority: InstallationAccountsAuthority | null = {
      serverId: "srv_test",
      settings: {
        providerDefinitions: [
          definition("account/a", { srv_test: "codex-host-a", srv_dev: "codex-primary" }),
          // Excluded for Dev, though ready there.
          definition("account/b", { srv_test: "codex-host-b", srv_dev: "codex-dev-b" }),
          definition("account/c", { srv_test: "codex-host-c", srv_dev: "codex-dev-c" }),
          // A managed setup gets the same deterministic id in every environment.
          definition(
            "setup/same",
            { srv_test: "codex-account-same", srv_dev: "codex-account-same" },
            {
              accountSetup: {
                provider: "codex",
                creationId: "0b6f6f5e-7a8e-4a7e-9c1e-3f1d2c4b5a69",
              },
            },
          ),
        ],
        resourceExclusions: {
          srv_dev: { providerIds: ["account/b"], terminalProfileIds: [], metadataProviderIds: [] },
        },
      },
    };
    let reachable = true;
    const dev: DestinationHosts = {
      async use(serverId, action) {
        if (serverId !== "srv_dev" || !reachable) throw new Error(`${serverId} is offline`);
        return action({
          getDaemonConfig: async () => ({
            config: {
              providers: {
                "codex-primary": { extends: "codex", installationAccountId: "acct-a" },
                "codex-dev-b": { extends: "codex", installationAccountId: "acct-b" },
                "codex-dev-c": { extends: "codex", installationAccountId: "acct-c" },
                "codex-account-same": { extends: "codex" },
                "codex-lookalike": { extends: "codex" },
              },
            },
          }),
          getProvidersSnapshot: async () => ({
            entries: [
              "codex-primary",
              "codex-dev-b",
              "codex-dev-c",
              "codex-account-same",
              "codex-lookalike",
            ].map((provider) => ({ provider, enabled: true, status: "ready" as const })),
          }),
        });
      },
    };
    accounts = {
      readyProviders: async () => Object.keys(host),
      providerType: () => "codex",
      profileAccount: (profileId) => (profileId === "local-codex" ? "codex-host-a" : null),
      readUsage: async () => ({
        fetchedAt: T0,
        providers: Object.entries(host).map(([id, item]) => usage(id, item.remainingPct)),
      }),
      defaultProvider: async () => "codex-host-a",
      destinationAccounts: (serverId) =>
        readDestinationAccounts({
          hosts: () => dev,
          serverId,
          authority,
          localProviders: Object.fromEntries(
            Object.entries(host).map(([id, item]) => [
              id,
              { extends: "codex", ...(item.shared ? { installationAccountId: item.shared } : {}) },
            ]),
          ),
        }),
    };
    const factory = service();
    await enable(factory);
    const pick = (input: { serverId?: string; avoid?: string }) =>
      factory.invoke("factory.project.pick_account", {
        projectId: PROJECT,
        stage: "worker",
        ...input,
      });

    for (const [input, expected] of [
      // This daemon, named or not, ranks its own accounts as before.
      [{}, { provider: "codex-lookalike", remainingPct: 99 }],
      [{ serverId: "srv_test" }, { provider: "codex-lookalike", remainingPct: 99 }],
      // Only definitions binding both hosts map: b is excluded for Dev, and neither the alias
      // a2 nor the same-id lookalike has one. The managed setup's identical id qualifies.
      [
        { serverId: "srv_dev" },
        {
          serverId: "srv_dev",
          provider: "codex-account-same",
          remainingPct: 85,
          considered: [
            { provider: "codex-primary", localProvider: "codex-host-a", verdict: "qualifies" },
            { provider: "codex-dev-c", localProvider: "codex-host-c", verdict: "qualifies" },
            {
              provider: "codex-account-same",
              localProvider: "codex-account-same",
              verdict: "qualifies",
            },
          ],
        },
      ],
      [{ serverId: "srv_dev", avoid: "codex-account-same" }, { provider: "codex-dev-c" }],
    ] as const)
      expect(await pick(input)).toMatchObject(expected);
    expect(await pick({})).not.toHaveProperty("serverId");

    // Installation policy wins while the destination still reports the account ready.
    authority.settings.providerDefinitions = [
      definition(
        "setup/same",
        { srv_test: "codex-account-same", srv_dev: "codex-account-same" },
        { policy: { enabled: false } },
      ),
    ];
    expect(await pick({ serverId: "srv_dev" })).toMatchObject({ provider: null });

    // Without installation settings, only a shared installation account id links accounts,
    // and avoiding one by either id avoids every local alias of it.
    authority = null;
    for (const [input, expected] of [
      [{ serverId: "srv_dev" }, { provider: "codex-primary", remainingPct: 95 }],
      [{ serverId: "srv_dev", avoid: "codex-primary" }, { provider: "codex-dev-b" }],
      [{ serverId: "srv_dev", avoid: "codex-host-a" }, { provider: "codex-dev-b" }],
    ] as const)
      expect(await pick(input)).toMatchObject(expected);

    // An unreadable or unknown host fails rather than falling back to this daemon's accounts.
    reachable = false;
    await expect(pick({ serverId: "srv_dev" })).rejects.toThrow(
      "Cannot read the accounts of host srv_dev",
    );
    await expect(pick({ serverId: "srv_gone" })).rejects.toThrow(
      "Cannot read the accounts of host srv_gone",
    );
    // A profile bound to one account cannot launch on another host.
    reachable = true;
    await factory.invoke("factory.project.configure", {
      projectId: PROJECT,
      workerProfileId: "local-codex",
    });
    await expect(pick({ serverId: "srv_dev" })).rejects.toThrow(
      "Profile local-codex is bound to one account and cannot launch on host srv_dev",
    );
    const state = JSON.parse(readFileSync(projectFactoryStatePath(home), "utf8"));
    expect(
      state.projects[PROJECT].accountPicks.map(
        (item: { serverId?: string }) => item.serverId ?? null,
      ),
    ).toEqual([null, null, "srv_dev", "srv_dev", null, "srv_dev", "srv_dev", "srv_dev", "srv_dev"]);
  });

  test("the daemon's accounts fall back when usage cannot be read and no profile is set", async () => {
    accounts = daemonFactoryAccounts({
      providers: {
        listProviders: async () => [{ provider: "codex", enabled: true, status: "ready" }] as never,
      },
      readUsage: async () => {
        throw new Error("usage service down");
      },
      getSettings: () => ({}) as never,
      hosts: () => ({
        use: async () => {
          throw new Error("no connected hosts");
        },
      }),
      serverId: "srv_test",
      readInstallationSettings: async () => null,
    });
    const factory = service();
    await enable(factory);
    expect(
      await factory.invoke("factory.project.pick_account", { projectId: PROJECT, stage: "worker" }),
    ).toMatchObject({ provider: null, profileId: null });
  });
});
