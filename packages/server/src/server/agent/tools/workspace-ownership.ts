// Decides which project owns a local workspace that an agent creates through
// `create_workspace` without naming a project. A folder goes to the deepest registered project
// that contains it, so a workspace is never filed under a project whose root it lies outside.
// The caller's project also keeps checkouts of its own repository and folders inside its
// worktree workspaces, which live outside its root. A git repository root that sits inside a
// plain directory project, such as a new repo under a Projects folder registered as a project,
// becomes its own project, even when that directory project is the caller's.
import { projectsFolderLocation } from "../../projects-folder.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../../workspace-registry.js";
import { getRealpathAwareRelativePath } from "../../../utils/path.js";

export type LocalWorkspaceOwner =
  /** The folder belongs to the caller's project; keep its project and sidebar membership. */
  | { kind: "caller" }
  /** The folder lies inside another registered project. */
  | { kind: "existing"; project: PersistedProjectRecord }
  /** No registered project owns the folder; it becomes its own project. */
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
  const { cwd, callerProject, checkoutRepoRoot } = input;
  // A checkout of the caller's repository, such as a manual worktree, stays with it. Only a git
  // project has a repository; a directory project's children are judged by the rules below.
  if (
    callerProject.kind === "git" &&
    checkoutRepoRoot &&
    contains(callerProject.rootPath, checkoutRepoRoot)
  ) {
    return { kind: "caller" };
  }

  const deepest = input.projects
    .filter((project) => !project.archivedAt && contains(project.rootPath, cwd))
    .sort((left, right) => depth(right.rootPath) - depth(left.rootPath))[0];
  if (deepest) {
    const ownRepository =
      deepest.kind === "non_git" &&
      checkoutRepoRoot !== null &&
      samePath(checkoutRepoRoot, cwd) &&
      !samePath(deepest.rootPath, cwd);
    if (ownRepository) return { kind: "new" };
    if (deepest.projectId === callerProject.projectId) return { kind: "caller" };
    return { kind: "existing", project: deepest };
  }

  // Worktree workspaces live outside the project root but are the project's own folders.
  // Directory workspaces are not: one opened on a parent folder must not claim its children.
  const callerWorktreeFolder = input.workspaces.some(
    (workspace) =>
      !workspace.archivedAt &&
      workspace.kind === "worktree" &&
      workspace.projectId === callerProject.projectId &&
      contains(workspace.cwd, cwd),
  );
  return callerWorktreeFolder ? { kind: "caller" } : { kind: "new" };
}

function samePath(left: string, right: string): boolean {
  return contains(left, right) && contains(right, left);
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
