import type { Logger } from "pino";
import {
  PROJECT_FACTORY_INSTRUCTION_CONFLICTS,
  PROJECT_FACTORY_RPCS,
  ProjectFactoryRepositorySchema,
  factoryProjectConfigure,
  factoryProjectDisable,
  factoryProjectEnable,
  factoryProjectGet,
  factoryProjectInstructionsAcknowledge,
  factoryProjectInstructionsGet,
  factoryProjectInstructionsPropose,
  factoryProjectInstructionsResolve,
  factoryProjectInstructionsSet,
  factoryProjectPause,
  factoryProjectResume,
  factoryProjectSendThread,
  factoryProjectStatusSet,
  type ProjectFactoryInstructions,
  type ProjectFactoryRoleId,
  type ProjectFactoryState,
} from "@getpaseo/server/factory-project";

import type { AgentStorage, StoredAgentRecord } from "../../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../../agent/create-agent/create.js";
import { computeNextRunAt } from "../../schedule/cron.js";
import type { ScheduleService } from "../../schedule/service.js";
import { launchAttempts, type Launch } from "../../system-project/launch-selection.js";
import { OPTIMIZER_ROLE, SYSTEM_PROJECT_KIND } from "../../system-project/manifest.js";
import {
  OPTIMIZER_AGENT_LABEL,
  OPTIMIZER_SCHEDULE_NAME,
} from "../../system-project/optimizer-agent.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../../workspace-registry.js";
import { generateWorkspaceId } from "../../workspace-registry-model.js";
import type { CharterInput } from "./charters/shared.js";
import {
  charterVersion,
  effectiveInstructions,
  hasDrifted,
  rebase,
  saveRevision,
} from "./instructions.js";
import {
  PROJECT_FACTORY_ROLE_LABEL,
  PROJECT_FACTORY_ROLES,
  projectFactoryInstallationId,
  projectFactoryRole,
  roleLabelValue,
  type ProjectFactoryRole,
} from "./roles.js";
import {
  ProjectFactoryStateDamagedError,
  ProjectFactoryStateStore,
  emptyRoleState,
  projectFactoryStatePath,
  type ProjectState,
  type RoleState,
} from "./state.js";
import { computeFingerprint, defaultGhRunner, shouldWake, type GatedRole } from "./tick-gate.js";

const GATED_ROLES: ReadonlySet<string> = new Set([
  "factory-intake",
  "factory-triage",
  "factory-builds",
]);

export type PromptOutcome = "sent" | "busy";

export interface ProjectFactoryServiceInput {
  paseoHome: string;
  serverId: string;
  projects: Pick<ProjectRegistry, "get">;
  workspaces: Pick<WorkspaceRegistry, "get" | "setProjectFactoryMember">;
  agentStorage: Pick<AgentStorage, "list" | "get">;
  createAgent: BoundCreateAgentCommand;
  /** Creates a role workspace with the given ID in the project, at its root. */
  createWorkspace: (input: {
    workspaceId: string;
    projectId: string;
    cwd: string;
    title: string;
  }) => Promise<PersistedWorkspaceRecord>;
  agents: {
    setLabels(agentId: string, labels: Record<string, string>): Promise<void>;
    setSystemPrompt(agentId: string, systemPrompt: string): Promise<void>;
    /**
     * Sends a prompt as a new turn. A busy agent is left alone and reports "busy", unless
     * `steer` is set, when the prompt joins its running turn.
     */
    sendPrompt(
      agentId: string,
      prompt: string,
      options: { steer: boolean },
    ): Promise<PromptOutcome>;
    /** Moves the agent to another provider or profile through the profile switch path. */
    /**
     * Moves the agent to another provider or profile. The new session starts with
     * `standingInstructions` ahead of the switch's carried context.
     */
    switchLaunch(agentId: string, launch: Launch, standingInstructions: string): Promise<void>;
  };
  /** The launch the Optimizer would use now, or null when no provider is usable. */
  defaultLaunch: () => Promise<Launch | null>;
  /** The provider a profile launches with, for a launch configured by profile alone. */
  profileProvider?: (profileId: string) => string | null;
  schedules: Pick<ScheduleService, "list" | "pause" | "resume">;
  /** Hash of the GitHub state a gated role reacts to; null wakes the agent. */
  fingerprint?: (role: GatedRole, repository: string) => Promise<string | null>;
  onWorkspacesChanged?: (workspaceIds: string[]) => void;
  logger: Logger;
  now?: () => Date;
  timeZone?: string;
}

class ProjectFactoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFactoryError";
  }
}

/**
 * Per-project Factory: five standing role workspaces, each with one chartered agent and one
 * heartbeat. Enable is idempotent across reruns and restarts: role agents are found by the
 * state file, then by their role label, then by adoption, and only then created.
 *
 * Heartbeats are timers this service owns rather than entries in Schedules. The schedule
 * service has no precondition hook or daemon-callback target, and its quota-governed path
 * bypasses its own prompt executor, so it cannot skip an unchanged tick or prepend changed
 * project instructions once. Pause and resume start and stop these timers.
 */
export class ProjectFactoryService {
  private readonly store: ProjectFactoryStateStore;
  private readonly logger: Logger;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Bumped by pause, disable and stop, so a callback already queued never rearms. */
  private readonly timerGenerations = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  static supports(method: string): boolean {
    return PROJECT_FACTORY_RPCS.some((rpc) => rpc.name === method);
  }

  constructor(private readonly input: ProjectFactoryServiceInput) {
    this.store = new ProjectFactoryStateStore(projectFactoryStatePath(input.paseoHome));
    this.logger = input.logger.child({ module: "project-factory" });
  }

  /** Restarts heartbeats and checks for charter drift on every enabled project. */
  async start(): Promise<void> {
    await this.serialize(async () => {
      const file = await this.store.read();
      for (const [projectId, project] of Object.entries(file.projects)) {
        await this.reconcileOptimizerReview(projectId, project);
        if (!project.enabled) continue;
        const record = await this.input.projects.get(projectId);
        if (!record || record.archivedAt) continue;
        await this.refreshSystemPrompts(record, project);
        await this.reviewDrift(record);
        if (!project.paused) this.startTimers(projectId);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async invoke(method: string, rawInput: unknown): Promise<unknown> {
    switch (method) {
      case factoryProjectGet.name:
        return this.get(factoryProjectGet.input.parse(rawInput).projectId);
      case factoryProjectEnable.name:
        return this.enable(factoryProjectEnable.input.parse(rawInput));
      case factoryProjectPause.name:
        return this.setPaused(factoryProjectPause.input.parse(rawInput).projectId, true);
      case factoryProjectResume.name:
        return this.setPaused(factoryProjectResume.input.parse(rawInput).projectId, false);
      case factoryProjectDisable.name:
        return this.disable(factoryProjectDisable.input.parse(rawInput).projectId);
      case factoryProjectConfigure.name:
        return this.configure(factoryProjectConfigure.input.parse(rawInput));
      case factoryProjectStatusSet.name:
        return this.setStatus(factoryProjectStatusSet.input.parse(rawInput));
      case factoryProjectSendThread.name:
        return this.sendThread(factoryProjectSendThread.input.parse(rawInput));
      case factoryProjectInstructionsGet.name: {
        const { projectId, role } = factoryProjectInstructionsGet.input.parse(rawInput);
        return this.getInstructions(projectId, role);
      }
      case factoryProjectInstructionsSet.name:
        return this.setInstructions(factoryProjectInstructionsSet.input.parse(rawInput));
      case factoryProjectInstructionsPropose.name:
        return this.proposeInstructions(factoryProjectInstructionsPropose.input.parse(rawInput));
      case factoryProjectInstructionsAcknowledge.name: {
        const { projectId, role } = factoryProjectInstructionsAcknowledge.input.parse(rawInput);
        return this.acknowledgeInstructions(projectId, role);
      }
      case factoryProjectInstructionsResolve.name:
        return this.resolveInstructions(factoryProjectInstructionsResolve.input.parse(rawInput));
      default:
        throw new ProjectFactoryError(`Unknown Factory method: ${method}`);
    }
  }

  async get(projectId: string): Promise<ProjectFactoryState> {
    const record = await this.requireProject(projectId);
    let project: ProjectState | undefined;
    try {
      project = (await this.store.read()).projects[projectId];
    } catch (error) {
      if (!(error instanceof ProjectFactoryStateDamagedError)) throw error;
      return this.describe(record, undefined, error.message);
    }
    if (record.archivedAt) return this.describe(record, project, "This project is archived.");
    return this.describe(record, project, null);
  }

  async enable(request: {
    projectId: string;
    repository: string;
    adopt?: Partial<Record<ProjectFactoryRoleId, string>>;
  }): Promise<ProjectFactoryState> {
    const repository = ProjectFactoryRepositorySchema.safeParse(request.repository);
    if (!repository.success)
      throw new ProjectFactoryError("Use a GitHub repository as owner/name, such as acme/app.");
    return this.serialize(async () => {
      const record = await this.requireActiveProject(request.projectId);
      await this.validateAdoption(request.projectId, request.adopt ?? {});
      await this.store.mutate((file) => {
        const current = file.projects[request.projectId];
        file.projects[request.projectId] = {
          repository: repository.data,
          workers: current?.workers ?? { workerProfileId: null, reviewerProfileId: null },
          roles: current?.roles ?? {},
          ...(current?.pausedOptimizerScheduleId
            ? { pausedOptimizerScheduleId: current.pausedOptimizerScheduleId }
            : {}),
          enabled: true,
          paused: false,
        };
      });
      const changed: string[] = [];
      for (const role of PROJECT_FACTORY_ROLES) {
        const workspaceId = await this.ensureRole(record, role, request.adopt?.[role.id]);
        if (workspaceId) changed.push(workspaceId);
      }
      if (changed.length > 0) this.input.onWorkspacesChanged?.(changed);
      // A changed repository or other charter input reaches every agent like an instructions edit.
      const configured = await this.requireConfiguredProject(request.projectId);
      await this.refreshSystemPrompts(record, configured);
      await this.pauseOptimizerReview(record);
      await this.reviewDrift(record);
      this.startTimers(request.projectId);
      return this.describe(record, await this.readProject(request.projectId), null);
    });
  }

  private setPaused(projectId: string, paused: boolean): Promise<ProjectFactoryState> {
    return this.serialize(async () => {
      const record = await this.requireActiveProject(projectId);
      await this.mutateProject(projectId, (project) => {
        if (!project.enabled) throw new ProjectFactoryError("Factory is off for this project.");
        project.paused = paused;
      });
      if (paused) this.stopTimers(projectId);
      else this.startTimers(projectId);
      return this.describe(record, await this.readProject(projectId), null);
    });
  }

  private disable(projectId: string): Promise<ProjectFactoryState> {
    return this.serialize(async () => {
      const record = await this.requireProject(projectId);
      this.stopTimers(projectId);
      const project = await this.readProject(projectId);
      if (!project) return this.describe(record, undefined, null);
      const installationId = projectFactoryInstallationId(projectId);
      const changed: string[] = [];
      for (const role of Object.values(project.roles)) {
        if (!role?.workspaceId || !this.input.workspaces.setProjectFactoryMember) continue;
        await this.input.workspaces.setProjectFactoryMember(role.workspaceId, null, installationId);
        changed.push(role.workspaceId);
      }
      if (changed.length > 0) this.input.onWorkspacesChanged?.(changed);
      await this.mutateProject(projectId, (current) => {
        current.enabled = false;
        current.paused = false;
      });
      await this.reconcileOptimizerReview(projectId, await this.readProject(projectId));
      return this.describe(record, await this.readProject(projectId), null);
    });
  }

  private configure(request: {
    projectId: string;
    role?: ProjectFactoryRoleId;
    provider?: string | null;
    profileId?: string | null;
    workerProfileId?: string | null;
    reviewerProfileId?: string | null;
  }): Promise<ProjectFactoryState> {
    return this.serialize(async () => {
      const record = await this.requireActiveProject(request.projectId);
      if (!request.role && (request.provider !== undefined || request.profileId !== undefined))
        throw new ProjectFactoryError("Name the role whose provider or profile you are setting.");
      const project = await this.mutateProject(request.projectId, (current) => {
        if (request.workerProfileId !== undefined)
          current.workers.workerProfileId = request.workerProfileId;
        if (request.reviewerProfileId !== undefined)
          current.workers.reviewerProfileId = request.reviewerProfileId;
        if (!request.role) return;
        const role = (current.roles[request.role] ??= emptyRoleState());
        if (request.provider !== undefined) role.launch.provider = request.provider;
        if (request.profileId !== undefined) role.launch.profileId = request.profileId;
        role.resetLaunch = !role.launch.provider && !role.launch.profileId;
      });
      const outcome = request.role
        ? await this.applyLaunch(record, request.projectId, request.role)
        : "none";
      return { state: this.describe(record, project, null), outcome };
    }).then(({ state, outcome }) => {
      // Deliver the charter promptly after a switch instead of waiting for the next heartbeat.
      if (outcome === "switched" && request.role)
        void this.tick(request.projectId, request.role).catch((error) =>
          this.logger.warn(
            { err: error, role: request.role },
            "Factory tick after a switch failed",
          ),
        );
      return state;
    });
  }

  private setStatus(request: {
    projectId: string;
    role: ProjectFactoryRoleId;
    line: string;
  }): Promise<ProjectFactoryState> {
    // Cheap by design: one state write, no agent wake, outside the operation queue.
    return (async () => {
      const record = await this.requireProject(request.projectId);
      const project = await this.mutateProject(request.projectId, (current) => {
        const role = (current.roles[request.role] ??= emptyRoleState());
        role.status = request.line
          ? { line: request.line, updatedAt: this.now().toISOString() }
          : null;
      });
      return this.describe(record, project, null);
    })();
  }

  private sendThread(request: { projectId: string; agentId: string }): Promise<{ queued: true }> {
    return this.serialize(async () => {
      await this.requireActiveProject(request.projectId);
      const project = await this.readProject(request.projectId);
      if (!project?.enabled) throw new ProjectFactoryError("Factory is off for this project.");
      if (project.paused)
        throw new ProjectFactoryError("Factory is paused for this project. Resume it first.");
      const thread = await this.input.agentStorage.get(request.agentId);
      if (!thread) throw new ProjectFactoryError(`Thread ${request.agentId} was not found.`);
      const triage = project.roles["factory-triage"]?.agentId;
      if (!triage) throw new ProjectFactoryError("This project's Triage agent is not set up yet.");
      const title = thread.title?.trim() || "Untitled";
      await this.input.agents.sendPrompt(
        triage,
        `Turn Vorteo thread ${request.agentId} (title: ${title}) into one Factory task issue for ${project.repository}, following your charter.`,
        { steer: true },
      );
      return { queued: true as const };
    });
  }

  async getInstructions(
    projectId: string,
    roleId: ProjectFactoryRoleId,
  ): Promise<ProjectFactoryInstructions> {
    const record = await this.requireProject(projectId);
    const project = await this.requireConfiguredProject(projectId);
    return this.describeInstructions(record, project, roleId);
  }

  private setInstructions(request: {
    projectId: string;
    role: ProjectFactoryRoleId;
    additions: string;
    expectedRevision: number;
  }): Promise<ProjectFactoryInstructions> {
    return this.changeInstructions(request.projectId, request.role, (role, charter) => {
      assertRevision(role, request.expectedRevision);
      return saveRevision(role.instructions, request.additions, charter, this.now().toISOString());
    });
  }

  private proposeInstructions(request: {
    projectId: string;
    role: ProjectFactoryRoleId;
    text: string;
    rationale: string;
  }): Promise<ProjectFactoryInstructions> {
    return this.changeInstructions(request.projectId, request.role, (role) => ({
      ...role.instructions,
      review: {
        status: "proposed",
        proposal: {
          text: request.text,
          rationale: request.rationale,
          proposedAt: this.now().toISOString(),
        },
      },
    }));
  }

  private acknowledgeInstructions(
    projectId: string,
    roleId: ProjectFactoryRoleId,
  ): Promise<ProjectFactoryInstructions> {
    return this.changeInstructions(projectId, roleId, (role, charter) =>
      rebase(role.instructions, charter),
    );
  }

  private resolveInstructions(request: {
    projectId: string;
    role: ProjectFactoryRoleId;
    accept: boolean;
    expectedRevision: number;
    proposedAt?: string;
  }): Promise<ProjectFactoryInstructions> {
    return this.changeInstructions(request.projectId, request.role, (role, charter) => {
      assertRevision(role, request.expectedRevision);
      const proposal = role.instructions.review.proposal;
      if (!request.accept) return rebase(role.instructions, charter);
      if (role.instructions.review.status !== "proposed" || !proposal)
        throw new ProjectFactoryError(`${PROJECT_FACTORY_INSTRUCTION_CONFLICTS.noProposal}.`);
      if (proposal.proposedAt !== request.proposedAt)
        throw new ProjectFactoryError(
          `${PROJECT_FACTORY_INSTRUCTION_CONFLICTS.proposalReplaced}. Review the new proposal and try again.`,
        );
      return saveRevision(role.instructions, proposal.text, charter, this.now().toISOString());
    });
  }

  private changeInstructions(
    projectId: string,
    roleId: ProjectFactoryRoleId,
    change: (role: RoleState, charterText: string) => RoleState["instructions"],
  ): Promise<ProjectFactoryInstructions> {
    return this.serialize(async () => {
      const record = await this.requireProject(projectId);
      const configured = await this.requireConfiguredProject(projectId);
      const charter = this.charterText(record, configured, roleId);
      const project = await this.mutateProject(projectId, (current) => {
        const role = (current.roles[roleId] ??= emptyRoleState());
        role.instructions = change(role, charter);
      });
      const agentId = project.roles[roleId]?.agentId;
      const instructions = project.roles[roleId]?.instructions;
      if (agentId && instructions)
        await this.input.agents.setSystemPrompt(
          agentId,
          effectiveInstructions(charter, instructions),
        );
      return this.describeInstructions(record, project, roleId);
    });
  }

  /** One heartbeat for one role: skip, or wake the agent with its tick prompt. */
  async tick(projectId: string, roleId: ProjectFactoryRoleId): Promise<void> {
    await this.serialize(async () => {
      const project = await this.readProject(projectId);
      if (!project?.enabled || project.paused) return;
      const record = await this.input.projects.get(projectId);
      if (!record || record.archivedAt) return;
      if (roleId === "factory-mechanic") await this.reviewDrift(record);
      const roleState = project.roles[roleId];
      const agentId = roleState?.agentId;
      if (!roleState || !agentId) return;
      const agent = await this.input.agentStorage.get(agentId);
      if (!agent || agent.archivedAt) return;
      const role = projectFactoryRole(roleId);
      const { effective, hash, undelivered, launchPending } = await this.prepareDelivery(
        record,
        project,
        roleId,
        agent,
      );
      const now = this.now();
      const current = GATED_ROLES.has(roleId)
        ? await this.readFingerprint(roleId as GatedRole, project.repository)
        : null;
      const decision = shouldWake({
        role: roleId,
        current,
        last: roleState.gate.fingerprint,
        lastWakeAt: roleState.gate.lastWakeAt,
        now,
        pending: undelivered || launchPending,
      });
      if (!decision.wake) return;
      const prompt = undelivered
        ? `${changedInstructionsPrompt(effective)}\n\n${role.tickPrompt}`
        : role.tickPrompt;
      const outcome = await this.input.agents.sendPrompt(agentId, prompt, { steer: false });
      // A busy agent keeps the old gate, so the next tick still sees the change.
      if (outcome === "busy") return;
      await this.mutateProject(projectId, (next) => {
        const state = next.roles[roleId];
        if (!state) return;
        state.gate = { fingerprint: current, lastWakeAt: now.toISOString() };
        state.delivered = { agentId, hash };
      });
    });
  }

  /**
   * Applies a pending launch, then works out what the agent must receive. A switch replaces the
   * session's prompt and clears the delivered marker, so both are read again after it.
   */
  private async prepareDelivery(
    record: PersistedProjectRecord,
    project: ProjectState,
    roleId: ProjectFactoryRoleId,
    agent: StoredAgentRecord,
  ) {
    const launch = await this.applyLaunch(record, record.projectId, roleId);
    const fresh = (await this.readProject(record.projectId)) ?? project;
    const delivered = fresh.roles[roleId]?.delivered;
    const effective = await this.syncSystemPrompt(
      record,
      fresh,
      roleId,
      (await this.input.agentStorage.get(agent.id)) ?? agent,
    );
    const hash = charterVersion(effective);
    return {
      effective,
      hash,
      undelivered: delivered?.agentId !== agent.id || delivered.hash !== hash,
      launchPending: launch === "pending",
    };
  }

  /**
   * The role's effective instructions, recomputed from every charter input and the additions,
   * so a renamed project or a new repository lands too. Updates the stored prompt when it differs.
   */
  private async syncSystemPrompt(
    record: PersistedProjectRecord,
    project: ProjectState,
    roleId: ProjectFactoryRoleId,
    agent: StoredAgentRecord,
  ): Promise<string> {
    const effective = effectiveInstructions(
      this.charterText(record, project, roleId),
      project.roles[roleId]?.instructions ?? emptyRoleState().instructions,
    );
    if (agent.config?.systemPrompt !== effective)
      await this.input.agents.setSystemPrompt(agent.id, effective);
    return effective;
  }

  /** Binds or creates one role. Returns its workspace ID when its membership was set. */
  private async ensureRole(
    record: PersistedProjectRecord,
    role: ProjectFactoryRole,
    adoptId: string | undefined,
  ): Promise<string | null> {
    const projectId = record.projectId;
    const project = await this.requireConfiguredProject(projectId);
    const state = project.roles[role.id] ?? emptyRoleState();
    const label = roleLabelValue(projectId, role.id);
    const charter = this.charterText(record, project, role.id);
    const instructions = effectiveInstructions(charter, state.instructions);

    let agent = state.agentId ? await this.input.agentStorage.get(state.agentId) : null;
    let adoptedNow = false;
    if (!agent) {
      const agents = await this.input.agentStorage.list();
      agent =
        agents.find((candidate) => candidate.labels?.[PROJECT_FACTORY_ROLE_LABEL] === label) ??
        null;
      const adopted =
        agent ??
        (adoptId ? await this.input.agentStorage.get(adoptId) : null) ??
        (role.id === "factory-mechanic" && isSystemProject(record)
          ? (agents.find(
              (candidate) =>
                candidate.labels?.[OPTIMIZER_AGENT_LABEL] === OPTIMIZER_ROLE &&
                !candidate.archivedAt,
            ) ?? null)
          : null);
      if (adopted && !agent) {
        await this.input.agents.setLabels(adopted.id, { [PROJECT_FACTORY_ROLE_LABEL]: label });
        await this.input.agents.setSystemPrompt(adopted.id, instructions);
        await this.input.agents.sendPrompt(
          adopted.id,
          `${adoptedPrompt(instructions)}\n\n${role.firstPrompt}`,
          { steer: true },
        );
        this.logger.info({ projectId, role: role.id, agentId: adopted.id }, "Adopted Factory role");
        adoptedNow = true;
      }
      agent = adopted;
    }

    let workspaceId = agent?.workspaceId ?? null;
    if (agent && !workspaceId)
      throw new ProjectFactoryError(
        `Agent ${agent.id} has no workspace, so it cannot hold a role.`,
      );
    if (agent) {
      await this.recordRole(projectId, role.id, {
        agentId: agent.id,
        workspaceId,
        ...(adoptedNow
          ? { delivered: { agentId: agent.id, hash: charterVersion(instructions) } }
          : {}),
      });
    } else {
      workspaceId = await this.ensureRoleWorkspace(record, role, state.workspaceId);
      await this.createRoleAgent(record, project, role, workspaceId, instructions);
    }
    return workspaceId ? this.bindMembership(record, role, workspaceId) : null;
  }

  private async ensureRoleWorkspace(
    record: PersistedProjectRecord,
    role: ProjectFactoryRole,
    recorded: string | null,
  ): Promise<string> {
    const existing = recorded ? await this.input.workspaces.get(recorded) : null;
    if (existing && !existing.archivedAt) return existing.workspaceId;
    // Recorded before creation, so a crash between the two reuses this ID instead of a second.
    const workspaceId = recorded && !existing ? recorded : generateWorkspaceId();
    await this.recordRole(record.projectId, role.id, { workspaceId });
    await this.input.createWorkspace({
      workspaceId,
      projectId: record.projectId,
      cwd: record.rootPath,
      title: `${projectName(record)} :: ${role.title}`,
    });
    return workspaceId;
  }

  private async createRoleAgent(
    record: PersistedProjectRecord,
    project: ProjectState,
    role: ProjectFactoryRole,
    workspaceId: string,
    systemPrompt: string,
  ): Promise<void> {
    const configured = project.roles[role.id]?.launch;
    const launch: Launch | null = configured?.provider
      ? {
          provider: configured.provider,
          ...(configured.profileId ? { profileId: configured.profileId } : {}),
        }
      : await this.input.defaultLaunch();
    if (!launch)
      throw new ProjectFactoryError(
        "No provider is ready to run Factory agents. Connect an account, then turn Factory on again.",
      );
    let lastError: unknown = null;
    for (const attempt of launchAttempts(launch)) {
      const created: { id: string | null } = { id: null };
      try {
        await this.input.createAgent({
          kind: "mcp",
          provider: attempt.provider,
          ...(attempt.profileId ? { profileId: attempt.profileId } : {}),
          title: role.title,
          cwd: record.rootPath,
          workspaceId,
          config: { systemPrompt },
          labels: { [PROJECT_FACTORY_ROLE_LABEL]: roleLabelValue(record.projectId, role.id) },
          initialPrompt: role.firstPrompt,
          promptFailure: "log",
          background: true,
          notifyOnFinish: false,
          // Recorded before the first prompt runs, so no later failure can lead to a second agent.
          onCreated: async ({ agentId }) => {
            created.id = agentId;
            await this.recordRole(record.projectId, role.id, {
              agentId,
              workspaceId,
              delivered: { agentId, hash: charterVersion(systemPrompt) },
              appliedLaunch: {
                provider: attempt.provider,
                profileId: attempt.profileId ?? null,
              },
            });
          },
        });
      } catch (error) {
        if (created.id) return;
        lastError = error;
        this.logger.warn(
          { err: error, role: role.id, provider: attempt.provider, profileId: attempt.profileId },
          "Could not create a Factory role agent with this launch",
        );
        continue;
      }
      if (created.id) {
        this.logger.info(
          { projectId: record.projectId, role: role.id, agentId: created.id },
          "Created Factory role agent",
        );
        return;
      }
    }
    throw new ProjectFactoryError(
      `Could not create the ${role.title} agent: ${lastError instanceof Error ? lastError.message : "unknown error"}`,
    );
  }

  /** Sets membership unless the workspace is a system workspace, which keeps its own. */
  private async bindMembership(
    record: PersistedProjectRecord,
    role: ProjectFactoryRole,
    workspaceId: string,
  ): Promise<string | null> {
    const workspace = await this.input.workspaces.get(workspaceId);
    if (!workspace || workspace.systemMembership || !this.input.workspaces.setProjectFactoryMember)
      return null;
    if (workspace.projectId !== record.projectId)
      throw new ProjectFactoryError(
        `The ${role.title} workspace belongs to another project, so it cannot hold this role.`,
      );
    const installationId = projectFactoryInstallationId(record.projectId);
    await this.input.workspaces.setProjectFactoryMember(
      workspaceId,
      {
        installationId,
        projectId: record.projectId,
        serverId: this.input.serverId,
        role: role.membershipRole,
      },
      installationId,
    );
    return workspaceId;
  }

  private async validateAdoption(
    projectId: string,
    adopt: Partial<Record<ProjectFactoryRoleId, string>>,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const [roleId, agentId] of Object.entries(adopt)) {
      if (seen.has(agentId))
        throw new ProjectFactoryError(`Agent ${agentId} cannot hold two Factory roles.`);
      seen.add(agentId);
      const agent = await this.input.agentStorage.get(agentId);
      if (!agent || agent.archivedAt)
        throw new ProjectFactoryError(`Agent ${agentId} to adopt was not found.`);
      const workspace = agent.workspaceId
        ? await this.input.workspaces.get(agent.workspaceId)
        : null;
      if (!workspace || workspace.projectId !== projectId)
        throw new ProjectFactoryError(`Agent ${agentId} is not in this project's workspaces.`);
      const bound = agent.labels?.[PROJECT_FACTORY_ROLE_LABEL];
      const wanted = roleLabelValue(projectId, roleId as ProjectFactoryRoleId);
      if (bound && bound !== wanted)
        throw new ProjectFactoryError(
          `Agent ${agentId} is already bound to Factory role ${bound}.`,
        );
    }
  }

  /** Factory's hourly Mechanic replaces the Optimizer's daily review while it is on. */
  private async pauseOptimizerReview(record: PersistedProjectRecord): Promise<void> {
    const project = await this.readProject(record.projectId);
    const mechanic = project?.roles["factory-mechanic"]?.agentId;
    if (!project || !mechanic || project.pausedOptimizerScheduleId) return;
    const review = (await this.input.schedules.list()).find(
      (schedule) =>
        schedule.status === "active" &&
        schedule.name === OPTIMIZER_SCHEDULE_NAME &&
        schedule.target.type === "agent" &&
        schedule.target.agentId === mechanic,
    );
    if (!review) return;
    // Ownership first: a crash or failure after this point is finished by reconciliation.
    await this.mutateProject(record.projectId, (current) => {
      current.pausedOptimizerScheduleId = review.id;
    });
    await this.reconcileOptimizerReview(record.projectId, await this.readProject(record.projectId));
  }

  /**
   * Makes an owned Optimizer review match Factory: paused while Factory is on, resumed and
   * released once it is off. A failed resume keeps the record, so the next start retries.
   */
  private async reconcileOptimizerReview(
    projectId: string,
    project: ProjectState | undefined,
  ): Promise<void> {
    const scheduleId = project?.pausedOptimizerScheduleId;
    if (!project || !scheduleId) return;
    const schedule = (await this.input.schedules.list()).find((item) => item.id === scheduleId);
    try {
      if (project.enabled) {
        if (schedule?.status === "active") await this.input.schedules.pause(scheduleId);
        return;
      }
      if (schedule?.status === "paused") await this.input.schedules.resume(scheduleId);
    } catch (error) {
      this.logger.warn(
        { err: error, projectId, scheduleId },
        "Could not reconcile the Optimizer review heartbeat; retrying on the next start",
      );
      return;
    }
    await this.mutateProject(projectId, (current) => {
      delete current.pausedOptimizerScheduleId;
    });
  }

  /**
   * Flags roles whose project instructions predate the shipped charter, and tells the Mechanic.
   * The notice is recorded only after it is queued, so a failure or a missing Mechanic retries on
   * the next start or Mechanic tick. A crash between queueing and recording can repeat a notice;
   * that rare duplicate is accepted instead of keeping an outbox.
   */
  private async reviewDrift(record: PersistedProjectRecord): Promise<void> {
    const notify: { role: ProjectFactoryRole; version: string }[] = [];
    const project = await this.mutateProject(record.projectId, (current) => {
      for (const role of PROJECT_FACTORY_ROLES) {
        const state = current.roles[role.id];
        if (!state) continue;
        const charter = this.charterText(record, current, role.id);
        if (!hasDrifted(state.instructions, charter)) continue;
        if (state.instructions.review.status === "none")
          state.instructions.review = { status: "needed" };
        const version = charterVersion(charter);
        if (state.instructions.notifiedCharterVersion !== version) notify.push({ role, version });
      }
    });
    const mechanic = project.roles["factory-mechanic"]?.agentId;
    if (!mechanic) return;
    for (const { role, version } of notify) {
      try {
        await this.input.agents.sendPrompt(
          mechanic,
          `The shipped ${role.title} charter changed in this Vorteo update, and this project has its own instructions for that role. The old and new charter texts are available through factory.project.instructions.get (paseo factory project instructions show ${record.projectId} ${role.id}). Review them: acknowledge when nothing conflicts, or propose revised instructions for the owner.`,
          { steer: true },
        );
      } catch (error) {
        this.logger.warn(
          { err: error, role: role.id },
          "Could not tell the Mechanic about charter drift",
        );
        continue;
      }
      await this.mutateProject(record.projectId, (current) => {
        const state = current.roles[role.id];
        if (state) state.instructions.notifiedCharterVersion = version;
      });
    }
  }

  /** Keeps each role agent's stored system prompt on the current shipped charter. */
  private async refreshSystemPrompts(
    record: PersistedProjectRecord,
    project: ProjectState,
  ): Promise<void> {
    for (const role of PROJECT_FACTORY_ROLES) {
      const state = project.roles[role.id];
      if (!state?.agentId) continue;
      const agent = await this.input.agentStorage.get(state.agentId);
      if (!agent || agent.archivedAt) continue;
      const prompt = effectiveInstructions(
        this.charterText(record, project, role.id),
        state.instructions,
      );
      if (agent.config?.systemPrompt !== prompt)
        await this.input.agents.setSystemPrompt(agent.id, prompt);
    }
  }

  /**
   * Applies a configured launch that differs from the agent's last applied one. A launch set by
   * profile alone takes that profile's provider. A cleared launch switches once to the default
   * the Optimizer would use, rather than following every later change of the default.
   * A switch starts the new session with the role's effective instructions and clears the
   * delivered marker, so the next prompt carries them in full as a safety net.
   */
  private async applyLaunch(
    record: PersistedProjectRecord,
    projectId: string,
    roleId: ProjectFactoryRoleId,
  ): Promise<"none" | "pending" | "switched"> {
    const project = await this.readProject(projectId);
    const state = project?.roles[roleId];
    if (!project || !state?.agentId) return "none";
    const target = await this.targetLaunch(state);
    if (!target) return "none";
    const applied = state.appliedLaunch;
    const sameAsApplied =
      applied?.provider === target.provider &&
      (applied.profileId ?? null) === (target.profileId ?? null);
    if (sameAsApplied) {
      if (state.resetLaunch) await this.recordLaunch(projectId, roleId, target);
      return "none";
    }
    const effective = effectiveInstructions(
      this.charterText(record, project, roleId),
      state.instructions,
    );
    try {
      await this.input.agents.switchLaunch(state.agentId, target, effective);
    } catch (error) {
      // A busy thread cannot switch; the next tick tries again.
      this.logger.info({ err: error, projectId, role: roleId }, "Factory role launch is pending");
      return "pending";
    }
    await this.recordLaunch(projectId, roleId, target, { switched: true });
    return "switched";
  }

  private async targetLaunch(state: RoleState): Promise<Launch | null> {
    const { provider, profileId } = state.launch;
    if (profileId) {
      const resolved = provider ?? this.input.profileProvider?.(profileId) ?? null;
      return resolved ? { provider: resolved, profileId } : null;
    }
    if (provider) return { provider };
    return state.resetLaunch ? this.input.defaultLaunch() : null;
  }

  private async recordLaunch(
    projectId: string,
    roleId: ProjectFactoryRoleId,
    launch: Launch,
    options?: { switched: boolean },
  ): Promise<void> {
    await this.mutateProject(projectId, (current) => {
      const role = current.roles[roleId];
      if (!role) return;
      role.appliedLaunch = { provider: launch.provider, profileId: launch.profileId ?? null };
      delete role.resetLaunch;
      if (options?.switched) delete role.delivered;
    });
  }

  private async readFingerprint(role: GatedRole, repository: string): Promise<string | null> {
    const read =
      this.input.fingerprint ??
      ((gated: GatedRole, repo: string) =>
        computeFingerprint(gated, { repository: repo, gh: defaultGhRunner }));
    try {
      return await read(role, repository);
    } catch {
      return null;
    }
  }

  private startTimers(projectId: string): void {
    for (const role of PROJECT_FACTORY_ROLES) this.scheduleTick(projectId, role);
  }

  private stopTimers(projectId: string): void {
    for (const role of PROJECT_FACTORY_ROLES) {
      const key = timerKey(projectId, role.id);
      this.timerGenerations.set(key, (this.timerGenerations.get(key) ?? 0) + 1);
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private scheduleTick(projectId: string, role: ProjectFactoryRole): void {
    if (this.stopped) return;
    const key = timerKey(projectId, role.id);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const generation = this.timerGenerations.get(key) ?? 0;
    const now = this.now();
    const next = computeNextRunAt(
      {
        type: "cron",
        expression: role.cron,
        ...(this.timeZone() ? { timezone: this.timeZone() } : {}),
      },
      now,
    );
    const timer = setTimeout(
      () => {
        this.timers.delete(key);
        void this.tick(projectId, role.id)
          .catch((error) =>
            this.logger.warn({ err: error, projectId, role: role.id }, "Factory tick failed"),
          )
          .finally(() => {
            // Paused or turned off since this fired: stay disarmed.
            if ((this.timerGenerations.get(key) ?? 0) !== generation) return;
            if (!this.timers.has(key)) this.scheduleTick(projectId, role);
          });
      },
      Math.max(0, next.getTime() - now.getTime()),
    );
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** Whether a role heartbeat is armed; exposed for tests. */
  hasTimer(projectId: string, roleId: ProjectFactoryRoleId): boolean {
    return this.timers.has(timerKey(projectId, roleId));
  }

  private describe(
    record: PersistedProjectRecord,
    project: ProjectState | undefined,
    unavailable: string | null,
  ): ProjectFactoryState {
    const state = factoryState(project, unavailable);
    return {
      schemaVersion: 1,
      serverId: this.input.serverId,
      projectId: record.projectId,
      state,
      repository: project?.repository || null,
      reason: unavailable,
      workers: project?.workers ?? { workerProfileId: null, reviewerProfileId: null },
      roles: PROJECT_FACTORY_ROLES.map((role) => {
        const roleState = project?.roles[role.id] ?? emptyRoleState();
        return {
          role: role.id,
          title: role.title,
          workspaceId: roleState.workspaceId,
          agentId: roleState.agentId,
          heartbeat: project?.enabled ? { cron: role.cron, paused: project.paused } : null,
          launch: roleState.launch,
          status: roleState.status,
          instructions: {
            revision: roleState.instructions.revision,
            review: roleState.instructions.review.status,
          },
        };
      }),
    };
  }

  private describeInstructions(
    record: PersistedProjectRecord,
    project: ProjectState,
    roleId: ProjectFactoryRoleId,
  ): ProjectFactoryInstructions {
    const state = project.roles[roleId]?.instructions ?? emptyRoleState().instructions;
    const shippedCharter = this.charterText(record, project, roleId);
    return {
      role: roleId,
      shippedCharter,
      charterVersion: charterVersion(shippedCharter),
      additions: state.additions,
      revision: state.revision,
      updatedAt: state.updatedAt,
      history: state.history,
      basedOn: state.basedOn,
      review: state.review,
    };
  }

  private charterText(
    record: PersistedProjectRecord,
    project: Pick<ProjectState, "repository">,
    roleId: ProjectFactoryRoleId,
  ): string {
    const input: CharterInput = {
      projectName: projectName(record),
      repository: project.repository,
      paseoHome: this.input.paseoHome,
      isSystemProject: isSystemProject(record),
      projectId: record.projectId,
    };
    return projectFactoryRole(roleId).charter(input);
  }

  private async recordRole(
    projectId: string,
    roleId: ProjectFactoryRoleId,
    patch: Partial<RoleState>,
  ): Promise<void> {
    await this.mutateProject(projectId, (project) => {
      project.roles[roleId] = { ...(project.roles[roleId] ?? emptyRoleState()), ...patch };
    });
  }

  private async mutateProject(
    projectId: string,
    change: (project: ProjectState) => void,
  ): Promise<ProjectState> {
    return this.store.mutate((file) => {
      const project = file.projects[projectId];
      if (!project) throw new ProjectFactoryError("Turn on Factory for this project first.");
      change(project);
      return structuredClone(project);
    });
  }

  private async readProject(projectId: string): Promise<ProjectState | undefined> {
    return (await this.store.read()).projects[projectId];
  }

  private async requireConfiguredProject(projectId: string): Promise<ProjectState> {
    const project = await this.readProject(projectId);
    if (!project) throw new ProjectFactoryError("Turn on Factory for this project first.");
    return project;
  }

  private async requireProject(projectId: string): Promise<PersistedProjectRecord> {
    const record = await this.input.projects.get(projectId);
    if (!record) throw new ProjectFactoryError(`Unknown project: ${projectId}`);
    return record;
  }

  private async requireActiveProject(projectId: string): Promise<PersistedProjectRecord> {
    const record = await this.requireProject(projectId);
    if (record.archivedAt) throw new ProjectFactoryError("This project is archived.");
    return record;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private now(): Date {
    return this.input.now?.() ?? new Date();
  }

  private timeZone(): string | undefined {
    return this.input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

function factoryState(
  project: ProjectState | undefined,
  unavailable: string | null,
): ProjectFactoryState["state"] {
  if (unavailable) return "unavailable";
  if (!project?.enabled) return "off";
  return project.paused ? "paused" : "on";
}

function assertRevision(role: RoleState, expected: number): void {
  if (role.instructions.revision !== expected)
    throw new ProjectFactoryError(
      `${PROJECT_FACTORY_INSTRUCTION_CONFLICTS.revision}; they are now at revision ${role.instructions.revision}. Reload and try again.`,
    );
}

function changedInstructionsPrompt(effective: string): string {
  return `Your standing instructions changed. These replace the earlier ones:\n\n${effective}`;
}

function adoptedPrompt(instructions: string): string {
  return `You now hold a standing Factory role. These are your standing instructions from now on; they replace any earlier ones.\n\n${instructions}`;
}

function projectName(record: PersistedProjectRecord): string {
  return record.customName ?? record.displayName;
}

function isSystemProject(record: PersistedProjectRecord): boolean {
  return record.systemProject?.kind === SYSTEM_PROJECT_KIND;
}

function timerKey(projectId: string, roleId: ProjectFactoryRoleId): string {
  return `${projectId}\u0000${roleId}`;
}
