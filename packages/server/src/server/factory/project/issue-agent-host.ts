import type { HostDirectory } from "@getpaseo/protocol/hosts";
import type { ProjectFactoryIssueAgentHost } from "@getpaseo/server/factory-project";

import { DEV_HOST_SOURCE_KEY } from "../../execution-installation/dev-host-link.js";

/**
 * Where the Foreman's per-issue agents run in dev mode: the Dev container the installation
 * coordinator saves as a connected host on this daemon. Factory reads that saved host to tell
 * the Foreman Dev's server id, or why Dev cannot take new issue agents, and to count Dev's
 * issue agents in the queue. It never falls back to this host.
 */

/** An agent on Dev, as the queue needs it. */
export interface DevAgent {
  id: string;
  status: string;
  labels: Record<string, string>;
  archivedAt?: string | null;
}

/** The part of a connected host's client that listing Dev's issue agents needs. */
export interface DevAgentsClient {
  fetchAgents(options: {
    filter: { labels: Record<string, string> };
    page: { limit: number; cursor?: string };
  }): Promise<{
    entries: { agent: DevAgent }[];
    pageInfo: { nextCursor: string | null; hasMore: boolean };
  }>;
}

/** This daemon's connected hosts, narrowed to what Factory reads. */
export interface IssueAgentHosts {
  directory(): Promise<HostDirectory>;
  use<T>(serverId: string, action: (client: DevAgentsClient) => Promise<T>): Promise<T>;
}

/** Dev's availability from this daemon's saved hosts. */
export function devHostState(directory: HostDirectory): ProjectFactoryIssueAgentHost {
  const saved = directory.hosts.filter((host) => host.source.key === DEV_HOST_SOURCE_KEY);
  const host = saved.find((item) => item.enabled && item.status === "online") ?? saved[0];
  if (!host) return { serverId: null, unavailable: "no Dev host is saved on this daemon" };
  const { serverId } = host;
  if (!host.enabled || host.status === "disabled")
    return { serverId, unavailable: "the Dev host is turned off" };
  if (host.status === "error")
    return { serverId, unavailable: `Dev reported ${host.error?.message ?? "an error"}` };
  if (!serverId) return { serverId, unavailable: "Dev has not connected yet" };
  if (host.status === "online") return { serverId, unavailable: null };
  return {
    serverId,
    unavailable: host.status === "connecting" ? "Dev is connecting" : "Dev is offline",
  };
}

/** Every unarchived agent on Dev labeled with this installation, across pages. */
export async function readDevAgents(input: {
  hosts: IssueAgentHosts;
  serverId: string;
  installation: string;
}): Promise<DevAgent[]> {
  return input.hosts.use(input.serverId, async (client) => {
    const agents: DevAgent[] = [];
    let cursor: string | undefined;
    do {
      const { entries, pageInfo } = await client.fetchAgents({
        filter: { labels: { "factory.installation": input.installation } },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      agents.push(...entries.map((entry) => entry.agent));
      cursor = pageInfo.hasMore && pageInfo.nextCursor ? pageInfo.nextCursor : undefined;
    } while (cursor);
    return agents;
  });
}
