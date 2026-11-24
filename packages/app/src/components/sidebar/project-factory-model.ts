import { buildPluginSurfaceRoute } from "@/plugins/routes";
import { parseGitHubRemoteUrl } from "@getpaseo/protocol/git-remote";
import type { ProjectFactoryState } from "./project-factory";
export const validFactoryRepository = (value: string) =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
export function factoryActions(
  state: ProjectFactoryState["state"],
): ("enable" | "pause" | "resume" | "disable")[] {
  if (state === "off") return ["enable"];
  if (state === "on") return ["pause", "disable"];
  if (state === "paused") return ["resume", "disable"];
  return [];
}
export function factoryRepositoryFromRemote(remote: string | null | undefined) {
  return remote ? (parseGitHubRemoteUrl(remote)?.repo ?? "") : "";
}

export function freshFactoryStatus(
  status: { line: string; updatedAt: string } | null | undefined,
  now = Date.now(),
) {
  if (
    !status ||
    !Number.isFinite(Date.parse(status.updatedAt)) ||
    now - Date.parse(status.updatedAt) >= 86_400_000
  )
    return null;
  return status;
}

export async function sendThreadToFactory(
  invoke: (method: string, input: unknown) => Promise<unknown>,
  projectId: string,
  agentId: string,
) {
  await invoke("factory.project.send_thread", { projectId, agentId });
}
export function factoryModelConfiguration(
  projectId: string,
  field: "role" | "plannerProfileId" | "workerProfileId" | "reviewerProfileId",
  profileId: string | null,
  role?: import("./factory-instructions-model").RoleId,
  provider?: string | null,
) {
  if (field === "role") return { projectId, role, provider: provider ?? null, profileId };
  return { projectId, [field]: profileId };
}

/** Where the Foreman starts issue agents. Absent on daemons too old to report it. */
export type FactoryIssueAgents = NonNullable<ProjectFactoryState["workers"]["issueAgents"]>;

/**
 * Moves issue agents to `next`. Moving them to this host runs the project's code here, so the
 * owner confirms that first; a declined confirmation changes nothing. Resolves to the new state,
 * or null when nothing was sent.
 */
export async function chooseFactoryIssueAgents(input: {
  projectId: string;
  current: FactoryIssueAgents;
  next: FactoryIssueAgents;
  confirmHost: () => Promise<boolean>;
  invoke: (method: string, input: unknown) => Promise<unknown>;
}): Promise<unknown> {
  if (input.next === input.current) return null;
  if (input.next === "host" && !(await input.confirmHost())) return null;
  return input.invoke("factory.project.configure", {
    projectId: input.projectId,
    issueAgents: input.next,
  });
}

/**
 * Whether the owner may make this thread the project's Foreman (#360). Offered only where the
 * daemon accepts the adoption: the thread wears this project's Foreman label, is not archived,
 * and no Foreman is recorded, which is what a lost Factory state file leaves behind. Enable then
 * refuses to create a second Foreman until the owner adopts the labelled one or archives it.
 */
export function canMakeFactoryForeman(input: {
  projectId: string;
  labels: Readonly<Record<string, string>> | undefined;
  archived: boolean;
  factory: Pick<ProjectFactoryState, "state" | "roles"> | undefined;
}): boolean {
  const { factory } = input;
  if (!factory || factory.state === "unavailable" || input.archived) return false;
  if (input.labels?.["vorteo.factory-role"] !== `${input.projectId}:factory-intake`) return false;
  return !factory.roles.find((role) => role.role === "factory-intake")?.agentId;
}

/** The installation prefix the daemon gives per-project Factory members. */
const PROJECT_FACTORY_INSTALLATION_PREFIX = "project-factory:";

/**
 * Hosts whose part of the project already has a per-project Factory member. Only these read
 * Factory state in the sidebar; an ordinary project makes no Factory requests at all.
 */
export function projectFactoryTargets<Host extends { serverId: string; projectId: string }>(
  hosts: readonly Host[],
  workspaces: readonly { serverId: string; workspaceKey: string }[],
  entries: ReadonlyMap<string, { factoryMembership?: { installationId: string } }>,
): Host[] {
  const servers = new Set(
    workspaces
      .filter((workspace) =>
        entries
          .get(workspace.workspaceKey)
          ?.factoryMembership?.installationId.startsWith(PROJECT_FACTORY_INSTALLATION_PREFIX),
      )
      .map((workspace) => workspace.serverId),
  );
  return hosts.filter((host) => servers.has(host.serverId));
}

/** Resolve the row destination only when the corresponding Factory surface exists. */
export function factoryOverviewRoute(
  target: { serverId: string; projectId: string; installationId: string },
  plugin: { surfaces: readonly { id: string }[] } | undefined,
) {
  if (!plugin) return null;
  if (target.installationId.startsWith("project-factory:")) {
    return {
      pathname: "/h/[serverId]/factory/[projectId]" as const,
      params: { serverId: target.serverId, projectId: target.projectId },
    };
  }
  return plugin.surfaces.some((surface) => surface.id === "overview")
    ? buildPluginSurfaceRoute(
        target.serverId,
        "factory",
        { kind: "surface", id: "overview" },
        { projectId: target.projectId },
      )
    : null;
}
