import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

interface HostBuilderWorktreeCustody {
  /** Native installation identity and complete bind inventory from trusted Host facilities. */
  host: {
    paseoHome: string;
    topology: "host-only" | "paired";
    guestRoots: readonly string[] | null;
  };
  projectId: string;
  installation: string;
  issue: number;
  runner: {
    agentId: string;
    installation: string;
    issue: number | null;
    role: string;
    serverId: string | null;
    account: string | null;
  };
  session: { agentId: string; workspaceId: string | null; provider: string };
  workspace: {
    workspaceId: string;
    projectId: string;
    kind: string;
    branch: string | null;
    cwd: string;
    worktreeRoot?: string | null;
    mainRepoRoot?: string | null;
    archivedAt: string | null;
  };
}

function contains(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function ownedDirectory(path: string, uid: number, deniedMode = 0o022): Promise<boolean> {
  const info = await lstat(path);
  return info.isDirectory() && info.uid === uid && !(info.mode & deniedMode);
}

async function ownedLinkFile(path: string, uid: number): Promise<string | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    const limit = 4096;
    if (
      !info.isFile() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      info.mode & 0o022 ||
      info.size > limit
    )
      return null;
    const data = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    return bytesRead === info.size ? data.toString("utf8", 0, bytesRead) : null;
  } finally {
    await file.close();
  }
}

async function verifyLinkedWorktree(
  home: string,
  pool: string,
  worktree: string,
  repo: string,
  key: string,
  uid: number,
): Promise<boolean> {
  const links = join(repo, "worktrees");
  const gitDir = join(links, key);
  const directories = [pool, worktree, repo, links, gitDir];
  if (!(await ownedDirectory(home, uid, 0o077))) return false;
  for (const directory of [
    join(home, "factory"),
    join(home, "factory", "lean"),
    join(home, "factory", "lean", "runner-workspaces"),
    ...directories,
  ]) {
    if (!(await ownedDirectory(directory, uid)) || (await realpath(directory)) !== directory)
      return false;
  }
  return (
    (await ownedLinkFile(join(worktree, ".git"), uid)) === `gitdir: ${gitDir}\n` &&
    (await ownedLinkFile(join(gitDir, "commondir"), uid)) === "../..\n" &&
    (await ownedLinkFile(join(gitDir, "gitdir"), uid)) === `${join(worktree, ".git")}\n`
  );
}

function matchesAssignment(
  input: HostBuilderWorktreeCustody,
  expected: { workspaceId: string; cwd: string; repo: string },
): boolean {
  const { issue, installation, projectId, runner, session, workspace } = input;
  return (
    runner.installation === installation &&
    runner.issue === issue &&
    runner.role === "lead" &&
    runner.serverId === null &&
    Boolean(runner.agentId) &&
    Boolean(runner.account) &&
    session.agentId === runner.agentId &&
    session.provider === runner.account &&
    session.workspaceId === expected.workspaceId &&
    workspace.workspaceId === expected.workspaceId &&
    workspace.projectId === projectId &&
    workspace.kind === "worktree" &&
    workspace.archivedAt === null &&
    workspace.branch === `factory/issue-${issue}` &&
    workspace.cwd === expected.cwd &&
    workspace.worktreeRoot === expected.cwd &&
    workspace.mainRepoRoot === expected.repo
  );
}

/** Verifies custody only. Quiescence, dirtiness and exact saved SHA remain runtime checks. */
export async function verifyHostBuilderWorktreeCustody(
  input: HostBuilderWorktreeCustody,
): Promise<boolean> {
  const { host, issue, projectId } = input;
  const { paseoHome, topology, guestRoots } = host;
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !isAbsolute(paseoHome) ||
    paseoHome === sep ||
    resolve(paseoHome) !== paseoHome ||
    !guestRoots ||
    (guestRoots.length === 0 && topology !== "host-only") ||
    !Number.isSafeInteger(issue) ||
    issue <= 0 ||
    !projectId
  )
    return false;
  const key = `builder-${issue}`;
  const pool = join(paseoHome, "factory", "lean", "runner-workspaces", hash(projectId));
  const cwd = join(pool, key);
  const repo = join(pool, "repository.git");
  const workspaceId = `wks_${hash(`${projectId}/${key}`).slice(0, 16)}`;
  if (!matchesAssignment(input, { workspaceId, cwd, repo })) return false;
  try {
    if ((await realpath(paseoHome)) !== paseoHome) return false;
    for (const guest of guestRoots) {
      if (!isAbsolute(guest)) return false;
      const physical = await realpath(guest);
      const roots = [resolve(guest), physical];
      if (
        roots.some((root) =>
          [cwd, repo].some((path) => contains(root, path) || contains(path, root)),
        )
      )
        return false;
    }
    return await verifyLinkedWorktree(paseoHome, pool, cwd, repo, key, uid);
  } catch {
    return false;
  }
}
