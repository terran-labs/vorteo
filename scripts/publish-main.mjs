#!/usr/bin/env node
// Delivers the current branch to main through a pull request: pushes the branch, opens or
// reuses its pull request, waits for the required checks named in .github/rulesets/main.json,
// merges with a merge commit pinned to the tested head (through the merge queue when the
// ruleset has one), waits until GitHub reports it merged, then proves main contains that head.
// A merge commit keeps the exact commit an installation already runs in main's history. A
// branch behind main is not refused; only one GitHub reports as conflicting is.
// Usage: node scripts/publish-main.mjs [--no-merge] [--pr <number>] [--title <text>]
//   [--body-file <path>] [--remote origin] [--branch main] [--repo owner/name] [--dry-run]
// Exit status 0 means merged (or opened, or ready for a dry run); 1 means refused.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  currentBranch,
  findGitleaks,
  git,
  isAncestor,
  parseArgs,
  repositoryRoot,
  workingTreeChanges,
} from "./lib/delivery-git.mjs";
import {
  checkRunsFor,
  ghJson,
  readMainRuleset,
  requiredCheckApp,
  requiredChecks,
  resolveRepository,
  runGh,
  summarizeChecks,
} from "./lib/github.mjs";
import { isMainModule } from "./is-main-module.mjs";
import { assertBuildsCoordinator } from "./lib/builds-guard.mjs";

export class PublishRefusal extends Error {}

// GitHub reports maintain as write in the legacy permission field.
const WRITE_PERMISSIONS = new Set(["admin", "write"]);

function fetchBase(root, remote, branch) {
  git(root, ["fetch", "--quiet", remote, branch]);
  return git(root, ["rev-parse", "FETCH_HEAD"]);
}

/**
 * Checks a branch delivery locally before anything reaches GitHub. With `pr`, plans the
 * merge of an existing pull request (for example a contributor's) instead.
 */
export function preparePublication({
  cwd,
  remote = "origin",
  branch = "main",
  env = process.env,
  repository,
  pr,
  gh = runGh,
  required = undefined,
  checkApp = undefined,
}) {
  const root = repositoryRoot(cwd);
  const remoteHead = fetchBase(root, remote, branch);
  const repo = resolveRepository({ root, remote, explicit: repository, gh });
  if (!required) {
    const ruleset = readMainRuleset(root);
    required = requiredChecks(ruleset);
    checkApp = requiredCheckApp(ruleset);
  }
  if (pr) {
    const view = ghJson(gh, [
      "pr",
      "view",
      String(pr),
      "-R",
      repo,
      "--json",
      "number,state,baseRefName,headRefOid,isCrossRepository,url,author",
    ]);
    if (view.state !== "OPEN") throw new PublishRefusal(`Pull request #${pr} is ${view.state}.`);
    if (view.baseRefName !== branch) {
      throw new PublishRefusal(`Pull request #${pr} targets ${view.baseRefName}, not ${branch}.`);
    }
    git(root, ["fetch", "--quiet", remote, `refs/pull/${view.number}/head`]);
    const head = git(root, ["rev-parse", "FETCH_HEAD"]);
    if (head !== view.headRefOid) {
      throw new PublishRefusal(`Pull request #${pr} moved while it was being read; run again.`);
    }
    return {
      root,
      remote,
      branch,
      head,
      remoteHead,
      repository: repo,
      required,
      checkApp,
      pr: view,
    };
  }
  const changes = workingTreeChanges(root);
  if (changes.tracked.length || changes.untracked.length) {
    throw new PublishRefusal(
      `Commit or remove local changes first: ${[...changes.tracked, ...changes.untracked].join(", ")}`,
    );
  }
  const headBranch = currentBranch(root);
  if (headBranch === "HEAD" || headBranch === branch) {
    throw new PublishRefusal(
      `Publish from a named task or integration branch, not ${headBranch === "HEAD" ? "a detached HEAD" : branch}.`,
    );
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head === remoteHead) {
    throw new PublishRefusal(`${remote}/${branch} already points at ${head.slice(0, 9)}`);
  }
  // A branch behind the base is fine: GitHub merges (or the merge queue tests) the combined
  // result, and only a pull request GitHub reports as conflicting is refused.
  // The pre-push hook runs the secret scan and fails when Gitleaks is missing.
  const gitleaks = findGitleaks(env);
  if (!gitleaks) {
    throw new PublishRefusal(
      "Gitleaks is not installed or not found. Install Gitleaks 8.30.1 for the pre-push secret scan.",
    );
  }
  const outgoing = git(root, ["log", "--format=%h %s", `${remoteHead}..${head}`]).split("\n");
  return {
    root,
    remote,
    branch,
    head,
    headBranch,
    remoteHead,
    gitleaks,
    outgoing,
    repository: repo,
    required,
    checkApp,
  };
}

export const DELEGATES_FILE = ".github/delivery-approvers.json";

/** Delegated approvers as recorded on the base branch, not on the pull request. */
export function readDelegates(plan) {
  if (!plan.root || !plan.remoteHead) return [];
  const text = git(plan.root, ["show", `${plan.remoteHead}:${DELEGATES_FILE}`], {
    allowFailure: true,
  });
  if (text === null) return [];
  const approvers = JSON.parse(text).approvers;
  if (!Array.isArray(approvers) || approvers.some((login) => typeof login !== "string")) {
    throw new PublishRefusal(`${DELEGATES_FILE} must list approver logins.`);
  }
  return approvers;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const PR_FIELDS = "number,state,baseRefName,headRefOid,isCrossRepository,url,author";

function viewPullRequest(gh, repository, number) {
  return ghJson(gh, ["pr", "view", String(number), "-R", repository, "--json", PR_FIELDS]);
}

/**
 * GitHub moves an existing pull request's head a few seconds after a push. Waits until
 * it reports the pushed commit rather than refusing a correct push.
 */
async function waitForHead(gh, plan, pr, { pollMs = 2_000, attempts = 15 } = {}) {
  let current = pr;
  for (let attempt = 0; current.headRefOid !== plan.head && attempt < attempts; attempt += 1) {
    await sleep(pollMs);
    current = viewPullRequest(gh, plan.repository, pr.number);
  }
  if (current.headRefOid !== plan.head) {
    throw new PublishRefusal(`Pull request #${pr.number} head is not ${plan.head.slice(0, 9)}.`);
  }
  return current;
}

/** Pushes the branch without force and returns its open pull request, creating one if needed. */
export async function openPullRequest(
  plan,
  { env = process.env, gh = runGh, title, body, pollMs } = {},
) {
  if (plan.pr) return plan.pr;
  const pathWithGitleaks = [path.dirname(plan.gitleaks), env.PATH ?? ""].join(path.delimiter);
  execFileSync("git", ["push", plan.remote, `HEAD:refs/heads/${plan.headBranch}`], {
    cwd: plan.root,
    env: { ...env, PATH: pathWithGitleaks },
    stdio: "inherit",
  });
  const pushed = git(plan.root, ["ls-remote", plan.remote, `refs/heads/${plan.headBranch}`]).split(
    /\s+/,
  )[0];
  if (pushed !== plan.head) {
    throw new PublishRefusal(
      `${plan.remote}/${plan.headBranch} reports ${pushed?.slice(0, 9) || "nothing"} after the push, not ${plan.head.slice(0, 9)}`,
    );
  }
  // --head matches branch names in forks too; only this repository's branch counts.
  const open = (
    ghJson(gh, [
      "pr",
      "list",
      "-R",
      plan.repository,
      "--head",
      plan.headBranch,
      "--base",
      plan.branch,
      "--state",
      "open",
      "--json",
      PR_FIELDS,
    ]) ?? []
  ).filter((pr) => !pr.isCrossRepository);
  if (open.length) return waitForHead(gh, plan, open[0], { pollMs });
  const subject = git(plan.root, ["log", "-1", "--format=%s", plan.head]);
  const description =
    body ??
    [
      "(AI Generated).",
      "",
      `Delivers ${plan.outgoing.length} commit(s) to ${plan.branch}:`,
      "",
      ...plan.outgoing.map((line) => `- ${line}`),
    ].join("\n");
  const url = gh(
    [
      "pr",
      "create",
      "-R",
      plan.repository,
      "--base",
      plan.branch,
      "--head",
      plan.headBranch,
      "--title",
      title ?? subject,
      "--body-file",
      "-",
    ],
    { input: description },
  );
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  if (!number) throw new PublishRefusal(`gh pr create did not report a pull request: ${url}`);
  return waitForHead(gh, plan, viewPullRequest(gh, plan.repository, number), { pollMs });
}

function isInstallationAuthor({ plan, pr, viewer, owner, approvers, canWrite, gh }) {
  if (pr.isCrossRepository || pr.author?.login !== viewer || !canWrite(viewer)) return false;
  if (approvers.has(viewer)) return true;
  const ownerType = gh(["api", `repos/${plan.repository}`, "--jq", ".owner.type"]);
  if (ownerType !== "Organization") return false;
  // Repository administration alone does not establish organization ownership.
  const membership = JSON.parse(gh(["api", `user/memberships/orgs/${owner}`]));
  return membership.state === "active" && membership.role === "admin";
}

/**
 * Decides whether a pull request may merge. Reviewers count only with write access,
 * checked through GitHub's permission API, and each reviewer's latest decision counts.
 * An outstanding change request from any writer blocks every merge. Approval authority is
 * explicit: the repository owner plus the delegates listed in DELEGATES_FILE on the base
 * branch, so a pull request cannot add its own approver. Write access alone never
 * delegates it. A same-repository pull request authored by an approver's own account
 * (an owner installation's Builds) needs no further approval; every other one needs an
 * approver's approval on its exact head from an account other than the one running
 * Builds, because agents share that account's token and its approval proves no human
 * decision.
 * GitHub enforces no review gate itself, so a review submitted in the seconds between
 * this check and the merge is not seen.
 */
export function assertReviewed(plan, pr, { gh = runGh, delegates = readDelegates(plan) } = {}) {
  const viewer = gh(["api", "user", "--jq", ".login"]);
  const owner = gh(["api", `repos/${plan.repository}`, "--jq", ".owner.login"]);
  const approvers = new Set([owner, ...delegates]);
  const output = gh([
    "api",
    "--paginate",
    `repos/${plan.repository}/pulls/${pr.number}/reviews`,
    "--jq",
    ".[] | {id, state, commit_id, user: .user.login}",
  ]);
  const latest = new Map();
  for (const review of output ? output.split("\n").map((line) => JSON.parse(line)) : []) {
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
    // Deleted users and apps have no collaborator permission to check.
    if (!review.user || review.user.endsWith("[bot]")) continue;
    const previous = latest.get(review.user);
    if (!previous || review.id > previous.id) latest.set(review.user, review);
  }
  const canWrite = (login) =>
    WRITE_PERMISSIONS.has(
      gh([
        "api",
        `repos/${plan.repository}/collaborators/${login}/permission`,
        "--jq",
        ".permission",
      ]),
    );
  const decisions = [...latest.values()].filter((review) => review.state !== "DISMISSED");
  const trusted = decisions.filter((review) => canWrite(review.user));
  const blocking = trusted.filter((review) => review.state === "CHANGES_REQUESTED");
  if (blocking.length) {
    throw new PublishRefusal(
      `Pull request #${pr.number} has changes requested by ${blocking.map((r) => r.user).join(", ")}.`,
    );
  }
  if (isInstallationAuthor({ plan, pr, viewer, owner, approvers, canWrite, gh })) {
    return "authored by this installation's account";
  }
  // Agents act through the account running Builds, so its approval proves no human decision.
  const approved = trusted.some(
    (review) =>
      review.state === "APPROVED" &&
      review.commit_id === plan.head &&
      approvers.has(review.user) &&
      review.user !== viewer,
  );
  if (!approved) {
    throw new PublishRefusal(
      `Pull request #${pr.number} has no approval on ${plan.head.slice(0, 9)} from the owner or a delegated approver other than ${viewer}, the account agents use. It waits for review, or for the owner to merge it on GitHub.`,
    );
  }
  return "approved on its head";
}

/**
 * Waits until every required check passes on the head. A failure refuses at once. A
 * cancelled newest run gets a few polls for its replacement to appear, then refuses.
 */
export async function waitForChecks(
  plan,
  { gh = runGh, pollMs = 20_000, timeoutMs = 90 * 60_000, cancelledPolls = 3, log = () => {} } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let cancelledFor = 0;
  for (;;) {
    const runs = checkRunsFor(gh, plan.repository, plan.head).filter(
      (run) => plan.checkApp === undefined || run.app === plan.checkApp,
    );
    const summary = summarizeChecks(runs, plan.required);
    const onlyCancelled = summary.failed.every((entry) => entry.endsWith("(cancelled)"));
    cancelledFor = summary.failed.length && onlyCancelled ? cancelledFor + 1 : 0;
    if (summary.failed.length && (!onlyCancelled || cancelledFor > cancelledPolls)) {
      throw new PublishRefusal(
        `Required checks failed on ${plan.head.slice(0, 9)}: ${summary.failed.join(", ")}. Fix forward or rerun them; a cancelled run is not evidence.`,
      );
    }
    if (!summary.pending.length && !summary.failed.length) return summary;
    if (Date.now() >= deadline) {
      throw new PublishRefusal(
        `Timed out waiting for ${[...summary.pending, ...summary.failed].join(", ")}.`,
      );
    }
    log(`Waiting for ${[...summary.pending, ...summary.failed].join(", ")}`);
    await sleep(pollMs);
  }
}

/**
 * Refuses a pull request that GitHub reports as conflicting with its base. A branch that is
 * merely behind the base merges as is. GitHub computes mergeability lazily, so UNKNOWN is
 * polled briefly; if it stays unknown, the merge itself is left to decide.
 */
export async function assertMergeable(
  plan,
  pr,
  { gh = runGh, pollMs = 3_000, attempts = 10, log = () => {} } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    const view = ghJson(gh, [
      "pr",
      "view",
      String(pr.number),
      "-R",
      plan.repository,
      "--json",
      "mergeable,mergeStateStatus",
    ]);
    if (view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY") {
      throw new PublishRefusal(
        `Pull request #${pr.number} conflicts with ${plan.branch}. Merge ${plan.remote}/${plan.branch} into the branch, resolve the conflicts, commit with a change fragment, and publish again. Never force-push.`,
      );
    }
    if (view.mergeable !== "UNKNOWN") return view;
    if (attempt + 1 >= attempts) {
      log(`GitHub has not computed whether #${pr.number} conflicts; the merge will decide.`);
      return view;
    }
    await sleep(pollMs);
  }
}

const MERGE_STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      state
      headRefOid
      mergeCommit { oid }
      isInMergeQueue
      mergeQueueEntry { state position }
    }
  }
}`;

function mergeState(gh, repository, number) {
  const [owner, name] = repository.split("/");
  return ghJson(gh, [
    "api",
    "graphql",
    "-f",
    `query=${MERGE_STATE_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
    "--jq",
    ".data.repository.pullRequest",
  ]);
}

/**
 * Waits until GitHub reports the pull request merged. Without a merge queue that is
 * immediate; with one, the entry waits for its merge group's required checks. Refuses when
 * the pull request closes, its head moves, or it leaves the queue unmerged, which GitHub
 * does when the merge group fails its checks or conflicts.
 */
export async function waitForMerged(
  plan,
  pr,
  {
    gh = runGh,
    pollMs = 30_000,
    timeoutMs = 6 * 60 * 60_000,
    absentPolls = 3,
    log = () => {},
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let absent = 0;
  let last = "";
  for (;;) {
    const current = mergeState(gh, plan.repository, pr.number);
    if (current.state === "MERGED" && current.mergeCommit?.oid) return current;
    if (current.state === "CLOSED") {
      throw new PublishRefusal(`Pull request #${pr.number} was closed without merging.`);
    }
    if (current.headRefOid !== plan.head) {
      throw new PublishRefusal(
        `Pull request #${pr.number} head moved to ${current.headRefOid?.slice(0, 9)} after ${plan.head.slice(0, 9)} was queued; publish again.`,
      );
    }
    // A fresh enqueue can take a moment to appear; then leaving the queue is final.
    absent = current.isInMergeQueue ? 0 : absent + 1;
    if (absent > absentPolls) {
      throw new PublishRefusal(
        `Pull request #${pr.number} left the merge queue without merging. GitHub removes an entry whose merge group fails its required checks or conflicts; inspect the merge group's checks, fix forward, and publish again.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new PublishRefusal(
        `Timed out waiting for #${pr.number} to merge; it is still ${current.isInMergeQueue ? "in the merge queue" : "open"}. Run publish-main.mjs --pr ${pr.number} again to keep waiting.`,
      );
    }
    const entry = current.mergeQueueEntry;
    const status = entry
      ? `In the merge queue at position ${entry.position}: ${entry.state.toLowerCase().replaceAll("_", " ")}.`
      : `Waiting for #${pr.number} to enter the merge queue.`;
    if (status !== last) log(status);
    last = status;
    await sleep(pollMs);
  }
}

const AUTO_MERGE_REFUSAL = /auto merge is not allowed|enablePullRequestAutoMerge/i;

const ENQUEUE_MUTATION = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid}) {
    mergeQueueEntry { id }
  }
}`;

/**
 * Merges with a merge commit pinned to the tested head. With a merge queue, GitHub enqueues
 * it instead, using the queue's merge method. Waits until it is merged, then proves main
 * contains both the merge commit and the head.
 */
export async function mergePullRequest(
  plan,
  pr,
  { gh = runGh, wait = {}, log = () => {}, ruleset = readMainRuleset(plan.root) } = {},
) {
  await assertMergeable(plan, pr, { gh, log, ...wait });
  // A rerun after a timeout finds the entry still queued; enqueueing it again would fail.
  const current = mergeState(gh, plan.repository, pr.number);
  const enqueue = () =>
    gh([
      "api",
      "graphql",
      "-f",
      `query=${ENQUEUE_MUTATION}`,
      "-f",
      `pullRequestId=${current.id}`,
      "-f",
      `expectedHeadOid=${plan.head}`,
    ]);
  if (!current.isInMergeQueue && ruleset.rules.some((rule) => rule.type === "merge_queue")) {
    enqueue();
  } else if (!current.isInMergeQueue) {
    try {
      gh([
        "pr",
        "merge",
        String(pr.number),
        "-R",
        plan.repository,
        "--merge",
        "--match-head-commit",
        plan.head,
      ]);
    } catch (error) {
      // When GitHub does not enqueue at once, gh falls back to auto-merge, which this
      // repository disallows. Enqueue directly, pinned to the tested head.
      if (!AUTO_MERGE_REFUSAL.test(String(error?.message ?? error))) throw error;
      enqueue();
    }
  }
  const merged = await waitForMerged(plan, pr, { gh, log, ...wait });
  const mainHead = fetchBase(plan.root, plan.remote, plan.branch);
  if (
    !isAncestor(plan.root, merged.mergeCommit.oid, mainHead) ||
    !isAncestor(plan.root, plan.head, mainHead)
  ) {
    throw new PublishRefusal(
      `${plan.remote}/${plan.branch} at ${mainHead.slice(0, 9)} does not contain merge ${merged.mergeCommit.oid.slice(0, 9)} and head ${plan.head.slice(0, 9)}.`,
    );
  }
  return { mergeCommit: merged.mergeCommit.oid, main: mainHead };
}

/**
 * With --delete-branch, deletes the merged same-repository branch. Branches are kept by
 * default so recovery branches and preservation holds survive delivery. Leaves the branch
 * when it moved after the merge.
 */
export function deleteMergedBranch(plan, env = process.env) {
  if (!plan.headBranch) return false;
  const ref = `refs/heads/${plan.headBranch}`;
  const current = git(plan.root, ["ls-remote", plan.remote, ref]).split(/\s+/)[0];
  if (current !== plan.head) return false;
  // The pre-push secret scan runs for deletions too.
  const pathWithGitleaks = [path.dirname(plan.gitleaks), env.PATH ?? ""].join(path.delimiter);
  execFileSync("git", ["push", `--force-with-lease=${ref}:${plan.head}`, plan.remote, `:${ref}`], {
    cwd: plan.root,
    env: { ...env, PATH: pathWithGitleaks },
    stdio: "inherit",
  });
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["dry-run", "no-merge", "delete-branch"],
    options: ["remote", "branch", "repo", "pr", "title", "body-file"],
  });
  const plan = preparePublication({
    cwd: process.cwd(),
    remote: args.remote ?? "origin",
    branch: args.branch ?? "main",
    repository: args.repo,
    pr: args.pr ? Number(args.pr) : undefined,
  });
  const target = plan.pr ? `pull request #${plan.pr.number}` : `${plan.headBranch}`;
  console.log(
    `Delivering ${target} (${plan.head.slice(0, 9)}) to ${plan.repository} ${plan.branch}; required checks: ${plan.required.join(", ")}`,
  );
  for (const line of plan.outgoing ?? []) console.log(`  ${line}`);
  if (args["dry-run"]) {
    console.log(
      plan.pr
        ? "Dry run: pull request is open, targets the base, its head matches, and the ruleset names its required checks. The local tree and secret scanner were not checked; nothing is pushed for an existing pull request."
        : "Dry run: clean tree and secret scanner verified. Conflicts with the base are checked on GitHub after the push.",
    );
    return;
  }
  const pr = await openPullRequest(plan, {
    title: args.title,
    body: args["body-file"] ? readFileSync(args["body-file"], "utf8") : undefined,
  });
  console.log(`Pull request: ${pr.url}`);
  if (args["no-merge"]) return;
  const log = (line) => console.log(line);
  // Refuse a conflict before waiting an hour for checks.
  await assertMergeable(plan, pr, { log });
  console.log(`Review: ${assertReviewed(plan, pr)}.`);
  const checks = await waitForChecks(plan, { log });
  console.log(`Passed: ${checks.passed.join(", ") || "none"}.`);
  if (checks.skipped.length) {
    console.log(`Skipped by CI's path filter, not validated: ${checks.skipped.join(", ")}.`);
  }
  // Revalidate right before merging: a review can change while checks run.
  assertReviewed(plan, viewPullRequest(runGh, plan.repository, pr.number));
  console.log(`Merging #${pr.number}; with a merge queue this waits for its merge group.`);
  const result = await mergePullRequest(plan, pr, { log });
  console.log(
    `Verified: merge ${result.mergeCommit} is on ${plan.remote}/${plan.branch} (${result.main}) and contains ${plan.head}.`,
  );
  if (args["delete-branch"]) {
    try {
      if (deleteMergedBranch(plan)) console.log(`Deleted the merged branch ${plan.headBranch}.`);
    } catch (error) {
      console.warn(`The merge is verified, but deleting ${plan.headBranch} failed: ${error}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  try {
    assertBuildsCoordinator("Merging pull requests into main");
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
