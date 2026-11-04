import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";
import type { DaemonPermission } from "@getpaseo/protocol/messages";
import { writePrivateFileAtomic } from "../private-files.js";
import type { InstallationConfig } from "./config.js";
import { connectInstallationDaemon } from "./daemon.js";
import { projectProject, projectWorkspace } from "../authorization/service-projections.js";

/** What the coordinator's per-daemon principal may do: observe, never act. */
export const OVERVIEW_DAEMON_PERMISSIONS: DaemonPermission[] = ["workspace.read"];
const CREDENTIALS_FILE = "overview-daemon-credentials.json";
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;

const CredentialsFileSchema = z.object({
  version: z.literal(1),
  environments: z.record(z.string(), z.object({ serverId: z.string(), token: z.string() })),
});

export interface EnvironmentOverview {
  kind: ExecutionEnvironmentKind;
  serverId: string;
  status: "ok" | "unavailable";
  /** Present only when status is unavailable. No data is reported for that environment. */
  error?: string;
  observedAt: string;
  /** Opaque cross-host identity: equal `projectKey` values on different environments name one project. */
  projects: unknown[];
  workspaces: unknown[];
  agents: unknown[];
  /** True when paging stopped at the safety limit, so lists may be incomplete. */
  truncated: boolean;
}

export interface InstallationOverview {
  installationId: string;
  observedAt: string;
  environments: EnvironmentOverview[];
}

type OverviewClient = Pick<
  DaemonClient,
  "listProjects" | "fetchWorkspaces" | "fetchAgents" | "close" | "getLastServerInfoMessage"
>;

type OwnerClient = Pick<
  DaemonClient,
  "createServicePrincipal" | "close" | "getLastServerInfoMessage"
>;

export interface OverviewDependencies {
  /** Connects with the environment password; used only to issue the read-only principal. */
  connectOwner: (kind: ExecutionEnvironmentKind) => Promise<OwnerClient>;
  connectService: (kind: ExecutionEnvironmentKind, token: string) => Promise<OverviewClient>;
  now?: () => Date;
}

export function productionOverviewDependencies(config: InstallationConfig): OverviewDependencies {
  return {
    connectOwner: (kind) => connectInstallationDaemon(config, kind),
    connectService: (kind, token) =>
      // A stable client ID resumes one retained session instead of leaving one per poll.
      connectInstallationDaemon(config, kind, {
        serviceCredential: token,
        clientId: `installation-overview-${kind}`,
      }),
  };
}

/**
 * Reads projects, workspaces and agents from every installation environment
 * through read-only service principals. The coordinator issues each principal
 * once with the environment password and afterwards never reads with it, so
 * this surface cannot act on a daemon. An unreachable environment is reported
 * as unavailable with its error and no data.
 */
export class InstallationOverviewReader {
  private readonly credentialsPath: string;
  private issuance: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: InstallationConfig,
    private readonly dependencies: OverviewDependencies,
  ) {
    this.credentialsPath = join(config.stateDir, CREDENTIALS_FILE);
  }

  async read(): Promise<InstallationOverview> {
    const now = this.dependencies.now ?? (() => new Date());
    const environments = await Promise.all(
      this.config.public.environments.map((environment) =>
        this.readEnvironment(environment.kind, environment.serverId, now),
      ),
    );
    return {
      installationId: this.config.public.installationId,
      observedAt: now().toISOString(),
      environments,
    };
  }

  private async readEnvironment(
    kind: ExecutionEnvironmentKind,
    serverId: string,
    now: () => Date,
  ): Promise<EnvironmentOverview> {
    const empty = { projects: [], workspaces: [], agents: [], truncated: false };
    try {
      const token = await this.credentialFor(kind, serverId);
      const client = await this.dependencies.connectService(kind, token);
      try {
        const [projects, workspaces, agents] = await Promise.all([
          client.listProjects(),
          collectPages((cursor) => client.fetchWorkspaces({ page: { limit: PAGE_LIMIT, cursor } })),
          collectPages((cursor) =>
            client.fetchAgents({
              filter: { includeArchived: false },
              page: { limit: PAGE_LIMIT, cursor },
            }),
          ),
        ]);
        return {
          kind,
          serverId,
          status: "ok",
          observedAt: now().toISOString(),
          projects: projects.projects.map((project) => redactCredentials(projectProject(project))),
          workspaces: workspaces.entries.map((workspace) =>
            redactCredentials(projectWorkspace(workspace)),
          ),
          agents: agents.entries.map(projectAgentEntry),
          truncated: workspaces.truncated || agents.truncated,
        };
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (error) {
      return {
        kind,
        serverId,
        status: "unavailable",
        error: describeError(error),
        observedAt: now().toISOString(),
        ...empty,
      };
    }
  }

  /**
   * Returns the stored read-only token for an environment, issuing one if none
   * exists. A token the daemon later rejects is not silently replaced: the owner
   * may have revoked it, so the environment reports unavailable instead.
   */
  private credentialFor(kind: ExecutionEnvironmentKind, serverId: string): Promise<string> {
    // Serialize issuance so concurrent environments never overwrite each other's saved token.
    const next = this.issuance.then(() => this.loadOrIssue(kind, serverId));
    this.issuance = next.catch(() => undefined);
    return next;
  }

  private async loadOrIssue(kind: ExecutionEnvironmentKind, serverId: string): Promise<string> {
    const stored = await this.loadCredentials();
    const existing = stored[kind];
    if (existing && existing.serverId === serverId) return existing.token;
    const owner = await this.dependencies.connectOwner(kind);
    try {
      if (owner.getLastServerInfoMessage()?.features?.servicePrincipals !== true)
        throw new Error("This environment's daemon does not support service principals yet");
      const created = await owner.createServicePrincipal({
        label: "Installation coordinator overview",
        permissions: OVERVIEW_DAEMON_PERMISSIONS,
      });
      if (!created.token) throw new Error(created.error ?? "The daemon did not issue a credential");
      await this.saveCredentials({ ...stored, [kind]: { serverId, token: created.token } });
      return created.token;
    } finally {
      await owner.close().catch(() => undefined);
    }
  }

  private async loadCredentials(): Promise<Record<string, { serverId: string; token: string }>> {
    try {
      const parsed = CredentialsFileSchema.safeParse(
        JSON.parse(await readFile(this.credentialsPath, "utf8")),
      );
      return parsed.success ? parsed.data.environments : {};
    } catch {
      return {};
    }
  }

  private async saveCredentials(
    environments: Record<string, { serverId: string; token: string }>,
  ): Promise<void> {
    await writePrivateFileAtomic(
      this.credentialsPath,
      `${JSON.stringify({ version: 1, environments }, null, 2)}\n`,
    );
  }
}

async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{
    entries: T[];
    pageInfo: { hasMore: boolean; nextCursor?: string | null };
  }>,
): Promise<{ entries: T[]; truncated: boolean }> {
  const entries: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    entries.push(...result.entries);
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor)
      return { entries, truncated: false };
    cursor = result.pageInfo.nextCursor;
  }
  return { entries, truncated: true };
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Environment could not be read";
}

/**
 * Agent fields the overview exposes. Permission requests, journals, questions,
 * errors and runtime or persistence metadata stay inside Vorteo.
 */
export const OVERVIEW_AGENT_FIELDS = [
  "id",
  "shortId",
  "title",
  "provider",
  "model",
  "status",
  "workspaceId",
  "labels",
  "createdAt",
  "updatedAt",
  "lastUserMessageAt",
  "archivedAt",
  "requiresAttention",
  "attentionReason",
  "attentionTimestamp",
] as const;

function projectAgentEntry(entry: unknown): unknown {
  const { agent, project } = (entry ?? {}) as {
    agent?: Record<string, unknown>;
    project?: unknown;
  };
  const projected: Record<string, unknown> = {};
  for (const field of OVERVIEW_AGENT_FIELDS) {
    if (agent && field in agent) projected[field] = agent[field];
  }
  const placement = (project ?? {}) as Record<string, unknown>;
  return {
    agent: projected,
    project: redactCredentials({
      projectKey: placement.projectKey,
      projectName: placement.projectName,
      workspaceName: placement.workspaceName ?? null,
    }),
  };
}

/** Deep copy with credentials removed from any URL, such as a git remote with a token. */
function redactCredentials(value: unknown): unknown {
  if (typeof value === "string") return stripUrlUserinfo(value);
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactCredentials(entry)]),
    );
  return value;
}

function stripUrlUserinfo(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1");
  }
}
