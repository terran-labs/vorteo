// Integration: import PROJECT_FACTORY_ROLE_IDS from plugins/factory/shared/project.ts.
export const PROJECT_FACTORY_ROLE_IDS = [
  "factory-triage",
  "factory-intake",
  "factory-builds",
  "factory-releases",
  "factory-mechanic",
] as const;
export type RoleId = (typeof PROJECT_FACTORY_ROLE_IDS)[number];
/** Display-only fallback for workspaces whose daemon state has not arrived. Never establishes membership. */
export function fallbackFactoryRoleTitle(role: RoleId) {
  if (role === "factory-intake") return "Foreman";
  const name = role.slice("factory-".length);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
