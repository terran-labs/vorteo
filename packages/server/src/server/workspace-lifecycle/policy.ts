import {
  isStandingSchedule,
  workspaceArchiveBlockReason,
} from "@getpaseo/protocol/workspace-lifecycle";
import type { ScheduleStore } from "../schedule/store.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";

export class WorkspaceProtectedError extends Error {
  constructor(
    readonly workspaceId: string,
    reason = "Unprotect to archive",
  ) {
    super(
      `Archive blocked: this workspace is protected from archival. ${reason}. The workspace and its threads were not archived.`,
    );
    this.name = "WorkspaceProtectedError";
  }
}

export class WorkspaceFactoryManagedError extends Error {
  constructor(readonly workspaceId: string) {
    super("This workspace belongs to Factory. Use reconciled Factory cleanup or owner disable.");
    this.name = "WorkspaceFactoryManagedError";
  }
}

/** Raised when a request would change something the daemon manages for Vorteo System. */
export class SystemManagedError extends Error {
  constructor(subject: string) {
    super(
      `${subject} is managed by Vorteo System, so it cannot be archived, removed, moved, renamed or unprotected.`,
    );
    this.name = "SystemManagedError";
  }
}

/** Raised when one thread in a Vorteo System workspace cannot be archived yet. */
export class SystemThreadArchiveError extends Error {
  constructor(reason: string) {
    super(`Archive blocked: ${reason}. The thread was not archived.`);
    this.name = "SystemThreadArchiveError";
  }
}

/**
 * Archiving one finished thread in a Vorteo System workspace. The workspace keeps its
 * own protection: workspace archive, removal and thread deletion stay refused, and
 * archive keeps the thread's history retrievable. A running thread, one a standing
 * schedule still targets, or a Factory binding blocks it.
 */
export async function assertSystemThreadArchiveAllowed(
  dependencies: { schedules: Pick<ScheduleStore, "list">; now?: () => number },
  input: {
    workspace: Pick<PersistedWorkspaceRecord, "workspaceId" | "factoryMembership">;
    agentId: string;
    running: boolean;
  },
): Promise<void> {
  assertWorkspaceNotFactoryManaged(input.workspace);
  if (input.running)
    throw new SystemThreadArchiveError("this system thread is still running. Let it finish first");
  const now = dependencies.now?.() ?? Date.now();
  const scheduled = (await dependencies.schedules.list()).some(
    (schedule) =>
      isStandingSchedule(schedule, now) &&
      schedule.target.type === "agent" &&
      schedule.target.agentId === input.agentId,
  );
  if (scheduled)
    throw new SystemThreadArchiveError(
      "a standing schedule still targets this system thread. Complete or remove the schedule first",
    );
}

/**
 * Keeps daemon-owned system project fields fixed across ordinary writes.
 * `next` is null for removal. Kind may change, so the project can become a git
 * checkout once its source is set up. The key never follows the git remote,
 * so the system project never merges into another project's group.
 */
export function pinSystemProjectFields<T extends PersistedProjectRecord | null>(
  existing: PersistedProjectRecord | null,
  next: T,
): T {
  if (!existing?.systemProject) {
    if (next?.systemProject)
      throw new Error("The Vorteo System marker can only be written by daemon startup.");
    return next;
  }
  if (!next || next.archivedAt || next.customName !== existing.customName)
    throw new SystemManagedError("The Vorteo System project");
  return { ...next, systemProject: existing.systemProject, projectKey: existing.projectKey };
}

/** Keeps a system-managed workspace's identity, placement and protection fixed. */
export function pinSystemWorkspaceFields(
  existing: PersistedWorkspaceRecord | null,
  next: PersistedWorkspaceRecord,
): PersistedWorkspaceRecord {
  if (!existing?.systemMembership) {
    if (next.systemMembership)
      throw new Error("System workspace roles can only be written by daemon startup.");
    return next;
  }
  const moved =
    next.projectId !== existing.projectId ||
    next.cwd !== existing.cwd ||
    next.kind !== existing.kind ||
    next.title !== existing.title ||
    next.archivedAt !== existing.archivedAt ||
    next.standing === false ||
    next.protected === false;
  if (moved) throw new SystemManagedError("This system workspace");
  return {
    ...next,
    systemMembership: existing.systemMembership,
    standing: true,
    protected: true,
  };
}

/** Descriptor fields that let clients group and lock Vorteo System items. */
export function systemFieldsForDescriptor(
  workspace: Pick<PersistedWorkspaceRecord, "systemMembership">,
  project: Pick<PersistedProjectRecord, "systemProject"> | null | undefined,
): {
  projectSystem?: NonNullable<PersistedProjectRecord["systemProject"]>;
  systemMembership?: NonNullable<PersistedWorkspaceRecord["systemMembership"]>;
} {
  return {
    ...(project?.systemProject ? { projectSystem: project.systemProject } : {}),
    ...(workspace.systemMembership ? { systemMembership: workspace.systemMembership } : {}),
  };
}

export function assertWorkspaceNotSystemManaged(
  workspace: Pick<PersistedWorkspaceRecord, "systemMembership">,
): void {
  if (workspace.systemMembership) throw new SystemManagedError("This system workspace");
}

type FactoryMembership = NonNullable<PersistedWorkspaceRecord["factoryMembership"]>;
const PROJECT_FACTORY_INSTALLATION_PREFIX = "project-factory:";

/**
 * The membership a per-project Factory holds, or undefined. Memberships the retired Factory
 * controller wrote are inert: they no longer block archive, moves or System adoption, and
 * clients never see them.
 */
// COMPAT(retiredFactoryMembership): added after 26.11.902; drop retired memberships on load and
// remove this filter after 2027-05-10, once no retained registry holds one.
export function activeFactoryMembership(
  workspace: Pick<PersistedWorkspaceRecord, "factoryMembership">,
): FactoryMembership | undefined {
  const membership = workspace.factoryMembership;
  return membership?.installationId.startsWith(PROJECT_FACTORY_INSTALLATION_PREFIX)
    ? membership
    : undefined;
}

/** The record without a retired controller membership, as written by a new owner. */
export function withoutRetiredFactoryMembership<T extends PersistedWorkspaceRecord>(
  workspace: T,
): T {
  if (!workspace.factoryMembership || activeFactoryMembership(workspace)) return workspace;
  const { factoryMembership: _retired, ...retained } = workspace;
  return retained as T;
}

export function assertWorkspaceNotFactoryManaged(
  workspace: Pick<PersistedWorkspaceRecord, "workspaceId" | "factoryMembership">,
): void {
  if (activeFactoryMembership(workspace))
    throw new WorkspaceFactoryManagedError(workspace.workspaceId);
}

export function factoryMembershipForDescriptor({
  workspace,
  serverId,
}: {
  workspace: Pick<PersistedWorkspaceRecord, "projectId" | "factoryMembership">;
  serverId: string | undefined;
}): Pick<PersistedWorkspaceRecord, "factoryMembership"> {
  const membership = activeFactoryMembership(workspace);
  if (
    !membership ||
    membership.serverId !== serverId ||
    membership.projectId !== workspace.projectId
  ) {
    return {};
  }
  return { factoryMembership: membership };
}

export function assertWorkspaceUnprotected(
  workspace: Pick<
    PersistedWorkspaceRecord,
    "workspaceId" | "protected" | "factoryMembership" | "systemMembership"
  >,
): void {
  assertWorkspaceNotSystemManaged(workspace);
  // Even an invalid per-project Factory membership blocks destruction until it is cleared.
  assertWorkspaceNotFactoryManaged(workspace);
  if (workspace.protected) throw new WorkspaceProtectedError(workspace.workspaceId);
}

export function setWorkspaceLifecycle(
  workspace: PersistedWorkspaceRecord,
  change: { standing?: boolean; protected?: boolean },
): PersistedWorkspaceRecord {
  if (workspace.archivedAt)
    throw new Error("Restore this workspace before changing its lifecycle.");
  if (change.standing === undefined && change.protected === undefined) {
    throw new Error("Choose Standing or Protected to update.");
  }
  if (change.protected === false) assertWorkspaceNotFactoryManaged(workspace);
  // Leaving Standing never silently removes an independently useful protection.
  const protectOnStanding = change.standing === true && !workspace.standing;
  return {
    ...workspace,
    standing: change.standing ?? workspace.standing ?? false,
    protected: change.protected ?? (protectOnStanding || workspace.protected === true),
    updatedAt: new Date().toISOString(),
  };
}

export async function assertWorkspaceArchiveAllowed(
  dependencies: {
    workspaces: Pick<WorkspaceRegistry, "get">;
    schedules: Pick<ScheduleStore, "list">;
    agents: Pick<AgentStorage, "listByWorkspace">;
    now?: () => number;
  },
  workspaceId: string,
): Promise<void> {
  const workspace = await dependencies.workspaces.get(workspaceId);
  if (!workspace) return;
  const schedules = await dependencies.schedules.list();
  const agents = await dependencies.agents.listByWorkspace(workspaceId);
  const agentIds = new Set(agents.filter((agent) => !agent.archivedAt).map((agent) => agent.id));
  const now = dependencies.now?.() ?? Date.now();
  const scheduled = schedules.some(
    (schedule) =>
      isStandingSchedule(schedule, now) &&
      schedule.target.type === "agent" &&
      agentIds.has(schedule.target.agentId),
  );
  const reason = workspaceArchiveBlockReason({ protected: workspace.protected, scheduled });
  if (reason) throw new WorkspaceProtectedError(workspaceId, reason);
}
