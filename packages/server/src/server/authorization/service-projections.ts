import type { SessionOutboundMessage } from "../messages.js";

/**
 * Fixed projections of agent, workspace and project data for service principals.
 * Each keeps identity, status and timestamps only. Paths, permission requests,
 * journals, questions, errors, runtime metadata, scripts, terminals, git and
 * forge state stay inside Vorteo. Fields the wire schema requires are filled with
 * empty values so existing clients still validate the message.
 */

type Json = Record<string, unknown>;

const AGENT_FIELDS = [
  "id",
  "provider",
  "model",
  "status",
  "workspaceId",
  "title",
  "labels",
  "createdAt",
  "updatedAt",
  "lastUserMessageAt",
  "archivedAt",
  "requiresAttention",
  "attentionReason",
  "attentionTimestamp",
  "capabilities",
  "currentModeId",
] as const;

const WORKSPACE_FIELDS = [
  "id",
  "projectId",
  "projectDisplayName",
  "projectKind",
  "workspaceKind",
  "name",
  "title",
  "labels",
  "status",
  "statusEnteredAt",
  "activityAt",
  "createdAt",
  "lastUserMessageAt",
  "archivingAt",
  "pinnedAt",
] as const;

const PROJECT_FIELDS = ["projectId", "projectKey", "projectDisplayName", "projectKind"] as const;

function pick(source: unknown, fields: readonly string[]): Json {
  const record = (source ?? {}) as Json;
  const picked: Json = {};
  for (const field of fields) if (field in record) picked[field] = record[field];
  return picked;
}

export function projectAgentSnapshot(agent: unknown): Json {
  return {
    ...pick(agent, AGENT_FIELDS),
    cwd: "",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
  };
}

const EMPTY_CHECKOUT = {
  cwd: "",
  isGit: false,
  currentBranch: null,
  remoteUrl: null,
  isPaseoOwnedWorktree: false,
  mainRepoRoot: null,
};

export function projectAgentPlacement(project: unknown): Json | null {
  if (!project) return null;
  return {
    ...pick(project, ["projectKey", "projectName", "workspaceName"]),
    checkout: EMPTY_CHECKOUT,
  };
}

export function projectWorkspace(workspace: unknown): Json {
  return {
    ...pick(workspace, WORKSPACE_FIELDS),
    projectRootPath: "",
    scripts: [],
    gitRuntime: {},
    githubRuntime: {},
  };
}

export function projectProject(project: unknown): Json {
  return { ...pick(project, PROJECT_FIELDS), projectRootPath: "" };
}

/**
 * Applies the projections to directory messages sent to a service session that
 * reads with daemon-wide permissions. Messages about agents the session holds a
 * grant for are not directory messages and pass unchanged.
 */
export function projectServiceDirectoryMessage(
  message: SessionOutboundMessage,
): SessionOutboundMessage {
  const m = message as { type: string; payload: Json };
  switch (m.type) {
    case "fetch_agents_response": {
      // Entries carry only the projected agent and placement; other entry fields are dropped.
      const entries = (m.payload.entries as Json[]).map((entry) => ({
        agent: projectAgentSnapshot(entry.agent),
        project: projectAgentPlacement(entry.project),
      }));
      return { ...m, payload: { ...m.payload, entries } } as unknown as SessionOutboundMessage;
    }
    case "agent_update":
      if (m.payload.kind !== "upsert") return message;
      return {
        ...m,
        payload: {
          ...m.payload,
          agent: projectAgentSnapshot(m.payload.agent),
          project: projectAgentPlacement(m.payload.project),
        },
      } as unknown as SessionOutboundMessage;
    case "fetch_workspaces_response":
      return {
        ...m,
        payload: {
          ...m.payload,
          entries: (m.payload.entries as unknown[]).map(projectWorkspace),
          ...(Array.isArray(m.payload.emptyProjects)
            ? { emptyProjects: m.payload.emptyProjects.map(projectProject) }
            : {}),
        },
      } as unknown as SessionOutboundMessage;
    case "workspace_update": {
      // A removal can carry the emptied project, which includes its root path.
      if (m.payload.kind !== "upsert") {
        if (!m.payload.emptyProject) return message;
        return {
          ...m,
          payload: { ...m.payload, emptyProject: projectProject(m.payload.emptyProject) },
        } as unknown as SessionOutboundMessage;
      }
      return {
        ...m,
        payload: { ...m.payload, workspace: projectWorkspace(m.payload.workspace) },
      } as unknown as SessionOutboundMessage;
    }
    case "project.list.response":
      return {
        ...m,
        payload: { ...m.payload, projects: (m.payload.projects as unknown[]).map(projectProject) },
      } as unknown as SessionOutboundMessage;
    case "project.update":
      if (m.payload.kind !== "upsert") return message;
      return {
        ...m,
        payload: { ...m.payload, project: projectProject(m.payload.project) },
      } as unknown as SessionOutboundMessage;
    default:
      return message;
  }
}
