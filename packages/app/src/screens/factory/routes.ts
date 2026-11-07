/** The All Factories overview for one host. */
export function allFactoriesOverviewRoute(serverId: string) {
  return `/h/${encodeURIComponent(serverId)}/factory` as const;
}
