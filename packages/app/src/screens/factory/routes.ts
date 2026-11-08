/** The overview of every Factory in the installation, anchored on one host's routes. */
export function allFactoriesOverviewRoute(serverId: string) {
  return { pathname: "/h/[serverId]/factory" as const, params: { serverId } };
}

/** One project's Factory overview. */
export function projectFactoryOverviewRoute(serverId: string, projectId: string) {
  return {
    pathname: "/h/[serverId]/factory/[projectId]" as const,
    params: { serverId, projectId },
  };
}
