import type {
  PROJECT_FACTORY_ROLE_IDS as SHARED_ROLE_IDS,
  ProjectFactoryRoleId,
} from "../../../../../plugins/factory/shared/project";

// A runtime copy keeps the app bundle free of plugin source; the check below fails the
// typecheck if it drifts from the shared schema in content or order.
export const PROJECT_FACTORY_ROLE_IDS = [
  "factory-triage",
  "factory-intake",
  "factory-builds",
  "factory-releases",
  "factory-mechanic",
] as const;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const matchesSharedRoleIds: Same<typeof PROJECT_FACTORY_ROLE_IDS, typeof SHARED_ROLE_IDS> = true;
void matchesSharedRoleIds;
export type RoleId = ProjectFactoryRoleId;
/** Display-only fallback for workspaces whose daemon state has not arrived. Never establishes membership. */
export function fallbackFactoryRoleTitle(role: RoleId) {
  if (role === "factory-intake") return "Foreman";
  const name = role.slice("factory-".length);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
