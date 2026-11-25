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

/** The Sample Factory: sample data to preview the overview, with every control off. */
export function sampleFactoryOverviewRoute(serverId: string) {
  return { pathname: "/h/[serverId]/factory/sample" as const, params: { serverId } };
}

/** One live Factory's settings: its stages, roles and where its issue agents run. */
export function projectFactorySettingsRoute(serverId: string, projectId: string) {
  return {
    pathname: "/h/[serverId]/factory/[projectId]/settings" as const,
    params: { serverId, projectId },
  };
}
