import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { parseGitHubRemoteUrl } from "@getpaseo/protocol/git-remote";
import { projectFactoryClaimBranch } from "@getpaseo/server/factory-project";

import {
  createPersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { LocalRunnerDependencies } from "./runner-adapters.js";
import type { RunnerOpenInput, RunnerRole } from "./types.js";

const execute = promisify(execFile);
const shaPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;

export interface AuthorizedRunnerStage {
  role: RunnerRole;
  issue: number | null;
  repository: string;
  branch: string;
  headSha: string;
  issueTitle?: string;
}

export interface RunnerWorkspaceDependencies {
  paseoHome: string;
  projectId: string;
  repository: string;
  projects: Pick<ProjectRegistry, "get">;
  workspaces: Pick<WorkspaceRegistry, "get" | "upsert">;
  /** Read daemon-authenticated stage facts. The runner's brief and labels supply no authority. */
  readStage(input: RunnerOpenInput): Promise<AuthorizedRunnerStage>;
  /** Verify an exact chain of daemon publication receipts for this preserved checkout. */
  verifyBuilderPublication?(input: BuilderWorkspacePublication): Promise<boolean>;
  now(): Date;
  onWorkspaceChanged?(workspaceId: string): void;
}

export interface BuilderWorkspacePublication {
  issue: number;
  workspaceId: string;
  workspaceHead: string;
  remoteHead: string;
}

type ResolveWorkspace = LocalRunnerDependencies["resolveWorkspace"];

export function createRunnerWorkspaceResolver(deps: RunnerWorkspaceDependencies): ResolveWorkspace {
  if (!isAbsolute(deps.paseoHome) || !isRunnerRepository(deps.repository)) {
    throw new Error(
      "Factory worktrees require a daemon state directory and configured GitHub repository.",
    );
  }
  let tail = Promise.resolve();
  const projectKey = hash(deps.projectId);
  const canonical = `https://github.com/${deps.repository}.git`;

  async function resolveWorkspace(input: RunnerOpenInput) {
    const project = await deps.projects.get(deps.projectId);
    if (
      input.projectId !== deps.projectId ||
      !project ||
      project.archivedAt !== null ||
      project.kind !== "git"
    ) {
      throw new Error("Factory worktrees need an active Git project.");
    }
    const stage = await deps.readStage(input);
    validateStage(input, stage, deps.repository);
    const pool = await isolatedPool(deps.paseoHome, projectKey);
    const repository = await openRepository(pool, canonical, deps.repository);
    const ref = `refs/heads/${stage.branch}`;
    await fetchAuthorizedHead(repository, ref, stage.headSha);

    const lead = stage.role === "lead";
    const key = lead
      ? `builder-${stage.issue}`
      : `${stage.role}-${stage.issue ?? "project"}-${stage.headSha}`;
    const cwd = join(pool, key);
    const workspaceId = `wks_${hash(`${deps.projectId}/${key}`).slice(0, 16)}`;
    const existing = await deps.workspaces.get(workspaceId);
    if (
      existing &&
      (existing.cwd !== cwd ||
        existing.projectId !== deps.projectId ||
        existing.archivedAt !== null)
    ) {
      throw new Error("The saved runner workspace identity changed. Restore it before continuing.");
    }
    await verifyRequestedWorktree(input.worktree, cwd);
    const artifact = await optionalDirectory(cwd);
    if (!artifact) {
      if (existing)
        throw new Error("The saved runner worktree is missing. Restore it before continuing.");
      const checkout = lead ? ["-b", stage.branch] : ["--detach"];
      await git(repository, ["worktree", "add", ...checkout, cwd, stage.headSha]);
    }
    await verifyWorktree({
      cwd,
      repository,
      stage,
      lead,
      async verifyPublishedHead(workspaceHead) {
        const verify = deps.verifyBuilderPublication;
        if (!verify || stage.issue === null) return false;
        return verify({
          issue: stage.issue,
          workspaceId,
          workspaceHead,
          remoteHead: stage.headSha,
        });
      },
    });
    const title = runnerTitle(stage.role, stage.issue, stage.issueTitle);
    if (!existing) {
      const now = deps.now().toISOString();
      const workspace = createPersistedWorkspaceRecord({
        workspaceId,
        projectId: deps.projectId,
        cwd,
        kind: "worktree",
        worktreeRoot: cwd,
        mainRepoRoot: repository,
        branch: lead ? stage.branch : null,
        baseBranch: ref,
        displayName: title,
        title,
        createdAt: now,
        updatedAt: now,
      });
      await deps.workspaces.upsert(workspace, { expectsInitialAgent: true });
      deps.onWorkspaceChanged?.(workspaceId);
    } else {
      await refreshTitle(existing, stage.issueTitle ? title : null);
    }
    return {
      workspaceId,
      reviewHead: stage.role === "reviewer" ? stage.headSha : null,
      authorizedBuilderHead: lead ? stage.headSha : undefined,
      title,
    };
  }

  async function refreshTitle(
    workspace: NonNullable<Awaited<ReturnType<WorkspaceRegistry["get"]>>>,
    title: string | null,
  ) {
    if (title && workspace.title !== title) {
      await deps.workspaces.upsert({ ...workspace, title, displayName: title });
      deps.onWorkspaceChanged?.(workspace.workspaceId);
    }
  }

  return (input) => {
    const result = tail.then(() => resolveWorkspace(input));
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function runnerTitle(role: RunnerRole, issue: number | null, issueTitle?: string): string {
  const name = {
    "foreman-op": "Lead",
    lead: "Builder",
    reviewer: "Reviewer",
    delivery: "Delivery",
    mechanic: "Mechanic",
  }[role];
  if (issue === null) return `Factory ${name}`;
  const title = issueTitle?.replace(/\s+/g, " ").trim().slice(0, 240);
  return title ? `#${issue} ${name}: ${title}` : `Factory ${name} for #${issue}`;
}

export function isRunnerRepository(repository: string): boolean {
  return repositoryPattern.test(repository) && !/\/\.{1,2}$/.test(repository);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function verifyRequestedWorktree(
  worktree: RunnerOpenInput["worktree"],
  cwd: string,
): Promise<void> {
  if (!worktree) return;
  if (worktree.serverId !== null || (await realpath(worktree.path)) !== cwd) {
    throw new Error("Factory cannot reuse a worktree outside the isolated runner pool.");
  }
}

function validateStage(
  input: RunnerOpenInput,
  stage: AuthorizedRunnerStage,
  repository: string,
): void {
  if (stage.role !== input.role || stage.issue !== input.issue || stage.repository !== repository) {
    throw new Error("The authorized stage belongs to another runner or repository.");
  }
  if (!shaPattern.test(stage.headSha))
    throw new Error("The authorized stage needs an exact Git head.");
  if (stage.issue !== null && (!Number.isSafeInteger(stage.issue) || stage.issue < 1)) {
    throw new Error("The authorized stage needs a valid issue number.");
  }
  if (stage.role !== "lead" && stage.role !== "reviewer") return;
  if (stage.issue === null || stage.branch !== projectFactoryClaimBranch(stage.issue)) {
    throw new Error("The authorized stage needs the claim branch for this issue.");
  }
}

async function optionalDirectory(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory()) throw new Error("The Factory worktree path is not a directory.");
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isolatedPool(paseoHome: string, projectKey: string): Promise<string> {
  let location = await realpath(paseoHome);
  for (const name of ["factory", "lean", "runner-workspaces", projectKey]) {
    location = join(location, name);
    await mkdir(location, { recursive: true, mode: 0o700 });
    await optionalDirectory(location);
  }
  return location;
}

async function openRepository(pool: string, canonical: string, expected: string): Promise<string> {
  const repository = join(pool, "repository.git");
  if (!(await optionalDirectory(repository))) {
    await git(pool, ["init", "--bare", "--quiet", repository]);
    await git(repository, ["remote", "add", "origin", canonical]);
    await git(repository, [
      "config",
      "--local",
      "credential.https://github.com.helper",
      "!gh auth git-credential",
    ]);
  }
  const bare = await git(repository, ["rev-parse", "--is-bare-repository"]);
  const origin = await git(repository, ["remote", "get-url", "origin"]);
  const identity = parseGitHubRemoteUrl(origin);
  if (bare !== "true" || origin !== canonical || identity?.repo !== expected) {
    throw new Error("The isolated Factory repository origin no longer matches the project.");
  }
  return repository;
}

async function fetchAuthorizedHead(
  repository: string,
  ref: string,
  expected: string,
): Promise<void> {
  await git(repository, ["check-ref-format", ref]);
  await git(repository, [
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-auto-maintenance",
    "origin",
    ref,
  ]);
  const fetched = await git(repository, ["rev-parse", "FETCH_HEAD^{commit}"]);
  if (fetched !== expected) {
    throw new Error(
      "The authorized branch moved. Reconcile the current head before opening a runner.",
    );
  }
}

async function verifyWorktree(input: {
  cwd: string;
  repository: string;
  stage: AuthorizedRunnerStage;
  lead: boolean;
  verifyPublishedHead(workspaceHead: string): Promise<boolean>;
}): Promise<void> {
  const { cwd, repository, stage, lead } = input;
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if ((await realpath(common)) !== repository)
    throw new Error("The worktree belongs to another repository.");
  const branch = await git(cwd, ["branch", "--show-current"]);
  const head = await git(cwd, ["rev-parse", "HEAD^{commit}"]);
  if (!lead) {
    const dirty = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
    if (branch || head !== stage.headSha || dirty) {
      throw new Error("The detached Factory worktree no longer matches its clean authorized head.");
    }
    return;
  }
  if (branch !== stage.branch)
    throw new Error("The builder's saved worktree is on another branch.");
  // A retry keeps commits saved locally before a quota stop, provided the authorized head is an ancestor.
  await git(cwd, ["merge-base", "--is-ancestor", stage.headSha, head]).catch(
    async (cause: unknown) => {
      if (await input.verifyPublishedHead(head)) return;
      throw new Error(
        "The builder's saved branch diverged from the authorized head. Reconcile it before resuming.",
        { cause },
      );
    },
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(?:_|$))/.test(
          name,
        ),
    ),
  );
  const result = await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}
