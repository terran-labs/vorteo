/**
 * Which host a project's menu and settings act on.
 *
 * A project merged across environments lists one entry per host, in host registry order. The
 * first entry is not necessarily usable: when Dev is paused, a project that Dev lists first
 * would otherwise target an offline daemon while the Host, which has the project, is ignored.
 */

export interface ProjectHostCandidate {
  serverId: string;
  projectId: string;
  online: boolean;
  /** The project's folder on this host; empty when the host has none. */
  rootPath: string;
}

export type ProjectHostTargetResult<T extends ProjectHostCandidate> =
  | { kind: "usable"; host: T }
  /** No candidate qualifies; `offline` lists the hosts that would once they reconnect. */
  | { kind: "offline"; offline: T[] }
  | { kind: "no_folder" }
  | { kind: "none" };

export function isUsableProjectHost(host: ProjectHostCandidate): boolean {
  return host.online && host.serverId.trim().length > 0 && host.rootPath.trim().length > 0;
}

/**
 * Picks an online host that has the project's folder. Earlier `preferredServerIds` win, such as
 * the routed host or this installation's Host; otherwise the first usable host in list order.
 */
export function resolveProjectHostTarget<T extends ProjectHostCandidate>(
  hosts: readonly T[],
  preferredServerIds: readonly (string | null | undefined)[] = [],
): ProjectHostTargetResult<T> {
  if (hosts.length === 0) return { kind: "none" };
  const usable = hosts.filter(isUsableProjectHost);
  for (const serverId of preferredServerIds) {
    if (!serverId) continue;
    const preferred = usable.find((host) => host.serverId === serverId);
    if (preferred) return { kind: "usable", host: preferred };
  }
  if (usable[0]) return { kind: "usable", host: usable[0] };
  const offline = hosts.filter((host) => !host.online);
  return offline.length > 0 ? { kind: "offline", offline } : { kind: "no_folder" };
}

/**
 * Once a screen has settled on a host, it stays there: an edit drafted against one host's
 * revision must never be saved to another. A pinned host that drops reads as offline.
 */
export function resolvePinnedProjectHostTarget<T extends ProjectHostCandidate>(
  hosts: readonly T[],
  pinned: { serverId: string; projectId: string } | null,
  preferredServerIds: readonly (string | null | undefined)[] = [],
): ProjectHostTargetResult<T> {
  if (!pinned) return resolveProjectHostTarget(hosts, preferredServerIds);
  return resolveProjectHostTarget(
    hosts.filter(
      (host) => host.serverId === pinned.serverId && host.projectId === pinned.projectId,
    ),
  );
}

export interface ProjectMenuHostPlacement {
  serverId: string;
  projectId: string;
  /** The project's folder on this host, as the sidebar placement records it. */
  iconWorkingDir: string;
}

/** Why the project menu offers no Factory actions, when it should say so. */
export type ProjectFactoryNotice =
  | { kind: "none" }
  /** This installation's Host has the project but its plugin catalog has not loaded yet. */
  | { kind: "loading" }
  | { kind: "offline"; serverIds: string[] }
  | { kind: "missing_plugin"; serverId: string };

export interface ProjectMenuTarget {
  settingsTarget: { serverId: string; projectId: string } | null;
  factoryNotice: ProjectFactoryNotice;
}

/**
 * The project menu's target: an online host with the project's folder. It prefers this
 * installation's Host when that runs the Factory plugin, then any host that does, then the Host,
 * so settings and Factory actions share one target whenever possible. Until the Host's plugin
 * catalog is ready (still loading or failed), the menu stays on the Host instead of falling through to another
 * Factory host, which could otherwise turn on a second Factory for the same project. With none
 * usable, settings still open against the first host so its screen can explain why nothing is
 * editable.
 */
export function resolveProjectMenuTarget(input: {
  hosts: readonly ProjectMenuHostPlacement[];
  onlineServerIds: ReadonlySet<string>;
  factoryServerIds: ReadonlySet<string>;
  installationHostServerId: string | null;
  /**
   * The Host's plugin catalog status. Until it is "ready", the Host's Factory plugin is unknown,
   * so the menu stays on the Host instead of offering another environment's Factory.
   */
  installationHostPluginStatus?: "loading" | "ready" | "error";
}): ProjectMenuTarget {
  const candidates = input.hosts.map((host) => ({
    serverId: host.serverId,
    projectId: host.projectId,
    online: input.onlineServerIds.has(host.serverId),
    rootPath: host.iconWorkingDir,
  }));
  const hostServerId = input.installationHostServerId;
  const hostStatus = input.installationHostPluginStatus ?? "ready";
  const pendingHost =
    hostStatus === "ready"
      ? undefined
      : candidates.find((host) => host.serverId === hostServerId && isUsableProjectHost(host));
  if (pendingHost) {
    return {
      settingsTarget: { serverId: pendingHost.serverId, projectId: pendingHost.projectId },
      factoryNotice:
        hostStatus === "loading"
          ? { kind: "loading" }
          : { kind: "missing_plugin", serverId: pendingHost.serverId },
    };
  }
  const result = resolveProjectHostTarget(candidates, [
    hostServerId && input.factoryServerIds.has(hostServerId) ? hostServerId : null,
    ...input.factoryServerIds,
    hostServerId,
  ]);
  const first = candidates[0];
  const chosen = result.kind === "usable" ? result.host : first;
  const settingsTarget = chosen ? { serverId: chosen.serverId, projectId: chosen.projectId } : null;
  // An install without the Factory plugin anywhere gets no Factory lines at all.
  if (input.factoryServerIds.size === 0) return { settingsTarget, factoryNotice: { kind: "none" } };
  if (result.kind === "usable") {
    return {
      settingsTarget,
      factoryNotice: input.factoryServerIds.has(result.host.serverId)
        ? { kind: "none" }
        : { kind: "missing_plugin", serverId: result.host.serverId },
    };
  }
  if (result.kind === "offline") {
    return {
      settingsTarget,
      factoryNotice: { kind: "offline", serverIds: result.offline.map((host) => host.serverId) },
    };
  }
  return { settingsTarget, factoryNotice: { kind: "none" } };
}

type Translate = (key: string, options?: Record<string, string>) => string;

/** "Dev", "Dev and Host" or "Dev, Lab, and Host" for owner-facing offline explanations. */
export function formatEnvironmentList(labels: readonly string[], t: Translate): string {
  if (labels.length <= 1) return labels[0] ?? "";
  const last = labels[labels.length - 1]!;
  if (labels.length === 2) return t("projectHostTarget.listPair", { first: labels[0]!, last });
  return t("projectHostTarget.listMany", { rest: labels.slice(0, -1).join(", "), last });
}
