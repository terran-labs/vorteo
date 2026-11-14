// Decides which project owns a local workspace that an agent creates through
// `create_workspace` without naming a project. The caller's project owns only folders that
// belong to it: its root, its workspaces' folders and checkouts of its repository. Any other
// folder goes to the deepest existing project that contains it, or becomes a new project,
// so a workspace is never filed under a project whose root it lies outside.
import { projectsFolderLocation } from "../../projects-folder.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../../workspace-registry.js";
import { getRealpathAwareRelativePath } from "../../../utils/path.js";

export type LocalWorkspaceOwner =
  /** The folder belongs to the caller's project; keep its project and sidebar membership. */
  | { kind: "caller" }
  /** The folder lies inside another registered project. */
  | { kind: "existing"; project: PersistedProjectRecord }
  /** No registered project contains the folder; it becomes its own project. */
  | { kind: "new" };

export interface ResolveLocalWorkspaceOwnerInput {
  cwd: string;
  callerProject: PersistedProjectRecord;
  projects: readonly PersistedProjectRecord[];
  workspaces: readonly PersistedWorkspaceRecord[];
  /** Main repository root of the folder's git checkout, when it has one. */
  checkoutRepoRoot: string | null;
}

export function resolveLocalWorkspaceOwner(
  input: ResolveLocalWorkspaceOwnerInput,
): LocalWorkspaceOwner {
  const { cwd, callerProject } = input;
  if (contains(callerProject.rootPath, cwd)) return { kind: "caller" };
  // Managed worktrees live outside the project root but are workspaces of the project.
  const callerWorkspaceFolder = input.workspaces.some(
    (workspace) =>
      !workspace.archivedAt &&
      workspace.projectId === callerProject.projectId &&
      contains(workspace.cwd, cwd),
  );
  if (callerWorkspaceFolder) return { kind: "caller" };
  if (input.checkoutRepoRoot && contains(callerProject.rootPath, input.checkoutRepoRoot)) {
    return { kind: "caller" };
  }

  const containing = input.projects
    .filter((project) => !project.archivedAt && contains(project.rootPath, cwd))
    .sort((left, right) => depth(right.rootPath) - depth(left.rootPath));
  const deepest = containing[0];
  return deepest ? { kind: "existing", project: deepest } : { kind: "new" };
}

function contains(root: string, candidate: string): boolean {
  return (
    getRealpathAwareRelativePath(
      projectsFolderLocation(root),
      projectsFolderLocation(candidate),
    ) !== null
  );
}

function depth(path: string): number {
  return projectsFolderLocation(path)
    .split(/[\\/]+/)
    .filter(Boolean).length;
}
