import { createHash } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { parseGitHubRemoteUrl } from "@getpaseo/protocol/git-remote";

type WorkspaceClient = Pick<DaemonClient, "listProjects" | "getCheckoutStatus" | "createWorkspace">;
type Role = "lead" | "reviewer";
interface SavedWorkspace {
  remoteProjectId: string;
  workspaceId: string;
  cwd: string;
  checkoutBranch: string;
}

function digest(fields: readonly (number | string)[]): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export function devReviewBranch(issue: number, head: string, generation: string): string {
  return `factory-review/${issue}-${digest([head, generation]).slice(0, 24)}`;
}

async function findDevProject(client: WorkspaceClient, projectKey: string, repository: string) {
  const projects = (await client.listProjects()).projects.filter(
    (project) => project.projectKind === "git" && project.projectKey === projectKey,
  );
  if (projects.length !== 1) return null;
  const [project] = projects;
  const root = await client.getCheckoutStatus(project.projectRootPath);
  const slug = parseGitHubRemoteUrl(root.remoteUrl ?? "")?.repo;
  if (root.error || !root.isGit || slug?.toLowerCase() !== repository.toLowerCase()) return null;
  return project.projectId;
}

function restoredDirectory(saved: SavedWorkspace, expected: Omit<SavedWorkspace, "cwd">) {
  if (
    saved.remoteProjectId !== expected.remoteProjectId ||
    saved.workspaceId !== expected.workspaceId ||
    saved.checkoutBranch !== expected.checkoutBranch
  )
    return null;
  return saved.cwd;
}

/** Called only over the installation-bound connection. The placement verifier checks the actual Git head. */
export async function resolveDevWorkspace(
  input: {
    client: WorkspaceClient;
    installation: string;
    serverId: string;
    projectKey: string;
    issue: number;
    role: Role;
    saved?: SavedWorkspace;
  },
  authority: {
    repository: string;
    generation: string;
    pushedHeadSha: string;
    reviewerHeadSha: string | null;
  },
) {
  const { client, saved, role, issue } = input;
  const branch = `factory/issue-${issue}`;
  const head = role === "reviewer" ? authority.reviewerHeadSha : authority.pushedHeadSha;
  if (
    !head ||
    !/^[a-f0-9]{40}$/u.test(head) ||
    !authority.generation ||
    !input.projectKey ||
    !Number.isSafeInteger(issue) ||
    issue < 1
  )
    return null;
  const remoteProjectId = await findDevProject(client, input.projectKey, authority.repository);
  if (!remoteProjectId) return null;
  const checkoutBranch =
    role === "reviewer" ? devReviewBranch(issue, head, authority.generation) : branch;
  const id = digest([
    "dev-workspace-v1",
    input.installation,
    input.serverId,
    remoteProjectId,
    issue,
    role,
    authority.generation,
    checkoutBranch,
  ]);
  const workspaceId = `wks_${id.slice(0, 16)}`;
  const binding = {
    repository: authority.repository,
    remoteProjectId,
    workspaceId,
    branch,
    checkoutBranch,
  };
  if (saved) {
    const cwd = restoredDirectory(saved, binding);
    return cwd ? { ...binding, cwd } : null;
  }
  const result = await client.createWorkspace({
    projectMembership: { key: input.projectKey, name: authority.repository },
    workspaceId,
    idempotencyKey: `lean-dev-workspace:${id}`,
    title: `#${issue} ${role === "lead" ? "Builder" : "Reviewer"}`,
    source: {
      kind: "worktree",
      projectId: remoteProjectId,
      worktreeSlug: `factory-${issue}-${id.slice(0, 12)}`,
      ...(role === "lead"
        ? { action: "checkout" as const, refName: branch }
        : { action: "branch-off" as const, refName: head, branchName: checkoutBranch }),
    },
  });
  const workspace = result.workspace;
  if (
    result.error ||
    workspace?.id !== workspaceId ||
    workspace.projectId !== remoteProjectId ||
    workspace.workspaceKind !== "worktree" ||
    !workspace.workspaceDirectory
  )
    return null;
  return { ...binding, cwd: workspace.workspaceDirectory };
}
