import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createObservedSubmission,
  type ObservedApprovalPlan,
  type ObservedPullEvidence,
} from "./observed-submission.js";

const repository = "owner/repo";
const issue = 8;
const branch = "factory/issue-8";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(
  change: "normal" | "rename" | "symlink" | "gitlink" | "rewrite" | "moved-base" = "normal",
) {
  const cwd = mkdtempSync(join(tmpdir(), "vorteo-observed-submission-"));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@invalid.invalid",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        cwd,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  git("init", "--quiet", "--initial-branch=main", "--template=");
  writeFileSync(join(cwd, "README.md"), "before\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "Base");
  const assignedHead = git("rev-parse", "HEAD");
  let baseSha = assignedHead;
  let files: ObservedPullEvidence["files"] = [{ path: "README.md" }];
  if (change === "rename") {
    renameSync(join(cwd, "README.md"), join(cwd, "new.md"));
    files = [{ path: "new.md", previousPath: "README.md" }];
  } else if (change === "symlink") {
    symlinkSync("README.md", join(cwd, "alias.md"));
    files = [{ path: "alias.md" }];
  } else if (change === "gitlink") {
    git("update-index", "--add", "--cacheinfo", `160000,${assignedHead},module`);
    files = [{ path: "module" }];
  } else {
    writeFileSync(join(cwd, "README.md"), "after\n");
  }
  if (change !== "gitlink") git("add", "-A");
  const contentTree = git("write-tree");
  git("commit", "--quiet", "-m", "Builder change");
  let headSha = git("rev-parse", "HEAD");
  if (change === "rewrite") headSha = git("commit-tree", contentTree, "-m", "Unrelated");
  if (change === "moved-base") {
    git("checkout", "--detach", "--quiet", assignedHead);
    writeFileSync(join(cwd, "unrelated.txt"), "upstream\n");
    git("add", "unrelated.txt");
    git("commit", "--quiet", "-m", "Upstream moved");
    baseSha = git("rev-parse", "HEAD");
  }

  const approval: ObservedApprovalPlan = {
    planRevision: "approved",
    approvedPaths: files.flatMap(({ path, previousPath }) =>
      previousPath === undefined ? [path] : [previousPath, path],
    ),
  };
  const evidence: ObservedPullEvidence = {
    issue,
    pullNumber: 3,
    state: "open",
    draft: false,
    headRepository: repository,
    baseRepository: repository,
    headBranch: branch,
    baseBranch: "main",
    defaultBranch: "main",
    headSha,
    branchHeadSha: headSha,
    baseSha,
    defaultHeadSha: baseSha,
    trusted: true,
    blocked: false,
    filesComplete: true,
    files,
    protectedPaths: [],
  };
  const readApprovedPlan = vi.fn<() => Promise<ObservedApprovalPlan | null>>(async () => approval);
  const readEvidence = vi.fn(async () => evidence);
  const sourceForHead = vi.fn(async () => ({
    repository,
    head: headSha,
    baseSha,
    gitDirectory: join(cwd, ".git"),
  }));
  const observe = createObservedSubmission({
    environment: "host",
    repository,
    readApprovedPlan,
    readEvidence,
    sourceForHead,
  });
  return {
    observe: (expected = { issue, pullNumber: 3, head: headSha }) => observe(expected),
    readApprovedPlan,
    sourceForHead,
    approval,
    evidence,
  };
}

it("verifies the exact primary-approved pull against independently fetched Git objects", async () => {
  const f = fixture("moved-base");
  const { headSha, baseSha } = f.evidence;
  expect(await f.observe()).toEqual({
    kind: "verified",
    issue,
    repository,
    head: headSha,
    baseSha,
    configCommit: baseSha,
    pullNumber: 3,
    planRevision: "approved",
  });
  expect(f.sourceForHead).toHaveBeenCalledExactlyOnceWith({ issue, headSha, baseSha });
});

it("requires a primary-approved plan and the caller's exact pull number and head", async () => {
  const f = fixture();
  f.readApprovedPlan.mockResolvedValueOnce(null);
  expect(await f.observe()).toEqual({ kind: "refused", reason: "unapproved-plan" });
  expect(await f.observe({ issue, pullNumber: 7, head: f.evidence.headSha })).toEqual({
    kind: "refused",
    reason: "untrusted-pull",
  });
  expect(await f.observe({ issue, pullNumber: 3, head: "d".repeat(40) })).toEqual({
    kind: "refused",
    reason: "untrusted-pull",
  });
  expect(f.sourceForHead).not.toHaveBeenCalled();
});

it("includes the original path of a rename in both plan and protected-path checks", async () => {
  const f = fixture("rename");
  f.approval.approvedPaths = ["new.md"];
  expect(await f.observe()).toEqual({ kind: "refused", reason: "unapproved-path" });
  f.approval.approvedPaths = ["new.md", "README.md"];
  f.evidence.protectedPaths = ["README.md"];
  expect(await f.observe()).toEqual({ kind: "refused", reason: "unapproved-path" });
  f.evidence.protectedPaths = [];
  expect(await f.observe()).toMatchObject({ kind: "verified" });
});

it.each(["symlink", "gitlink", "rewrite"] as const)(
  "refuses %s from independent Git objects",
  async (change) => {
    const f = fixture(change);
    expect(await f.observe()).toEqual({ kind: "refused", reason: "unverified-diff" });
  },
);

it("refuses incomplete or inconsistent file evidence and untrusted pull requests", async () => {
  const f = fixture();
  f.evidence.filesComplete = false;
  expect(await f.observe()).toMatchObject({ kind: "refused", reason: "untrusted-pull" });
  f.evidence.filesComplete = true;
  f.evidence.files = [{ path: "elsewhere.md" }];
  expect(await f.observe()).toMatchObject({ kind: "refused", reason: "unverified-diff" });
  f.evidence.headRepository = "fork/repo";
  expect(await f.observe()).toMatchObject({ kind: "refused", reason: "untrusted-pull" });
});

it("refuses changed plan or pull evidence during independent inspection", async () => {
  const f = fixture();
  const currentSource = await f.sourceForHead();
  f.sourceForHead.mockImplementationOnce(async () => {
    f.approval.planRevision = "changed-plan";
    return currentSource;
  });
  expect(await f.observe()).toMatchObject({ kind: "refused", reason: "evidence-changed" });
  f.sourceForHead.mockImplementationOnce(async () => {
    f.evidence.branchHeadSha = "a".repeat(40);
    return currentSource;
  });
  expect(await f.observe()).toMatchObject({ kind: "refused", reason: "evidence-changed" });
});
