import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ProjectFactoryAssignmentDiagnosticSchema,
  type ProjectFactoryAssignmentDiagnostic,
  projectFactoryClaimBranch,
  type ProjectFactoryClaim,
  type ProjectFactoryClaimRelease,
} from "@getpaseo/server/factory-project";

import type { AssignmentState, ClaimState, ForeignClaimState } from "./state.js";
import type { TrustedAccounts } from "./trust.js";

/**
 * Several Vorteo installations can run Factory against one repository. GitHub decides which
 * one works on an issue: the first to create `factory/issue-<n>` owns it. Each installation
 * remembers the claims it made in its own state file, so a claim branch it did not create is
 * foreign and is never started, repaired, merged or adopted.
 */

export interface GitHubResponse {
  status: number;
  body: unknown;
}

/** The GitHub REST calls Factory claims need. Tests inject an in-memory repository. */
export interface FactoryGitHub {
  rest(method: "GET" | "POST" | "DELETE", route: string, body?: unknown): Promise<GitHubResponse>;
}

/** The callback port keeps real execFile metadata available to focused adapter tests. */
export interface FactorySubprocess {
  (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ): Pick<ChildProcess, "stdin">;
}

/** Runs `gh api --include`; a parsed HTTP response takes precedence over process errors. */
export function createFactoryGitHub(run: FactorySubprocess = execFile): FactoryGitHub {
  return {
    rest(method, route, body) {
      const args = ["api", "--include", "-X", method, route];
      if (body !== undefined) args.push("--input", "-");
      return new Promise((resolve, reject) => {
        const child = run(
          "gh",
          args,
          { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout) => {
            const parsed = parseIncluded(stdout);
            if (parsed) return resolve(parsed);
            reject(new FactoryAssignmentReadError(subprocessDiagnostic(error)));
          },
        );
        if (body !== undefined) child.stdin?.end(JSON.stringify(body));
      });
    },
  };
}

export const defaultFactoryGitHub = createFactoryGitHub();

function diagnostic(
  category: ProjectFactoryAssignmentDiagnostic["category"],
  reason: string,
): ProjectFactoryAssignmentDiagnostic {
  return {
    category,
    code: null,
    signal: null,
    killed: null,
    timeout: "unknown",
    httpStatus: null,
    reason: reason.slice(0, 240),
  };
}

function subprocessDiagnostic(error: unknown): ProjectFactoryAssignmentDiagnostic {
  const result = diagnostic(
    "transport",
    "GitHub subprocess returned no HTTP response; cause unknown.",
  );
  if (typeof error !== "object" || error === null) return result;
  // Read only named fields. Never retain the original error, message, cause, cmd or stderr.
  const code = ProjectFactoryAssignmentDiagnosticSchema.shape.code.safeParse(
    "code" in error ? error.code : null,
  );
  const signal = ProjectFactoryAssignmentDiagnosticSchema.shape.signal.safeParse(
    "signal" in error ? error.signal : null,
  );
  result.code = code.success ? code.data : null;
  result.signal = signal.success ? signal.data : null;
  if ("killed" in error && typeof error.killed === "boolean") result.killed = error.killed;
  if (result.code === "ETIMEDOUT") {
    result.category = "timeout";
    result.timeout = "confirmed";
    result.reason = "GitHub subprocess reported ETIMEDOUT.";
  } else if (typeof result.code === "number") {
    result.category = "exit";
    result.reason = `GitHub subprocess exited with code ${result.code}.`;
  } else if (
    result.code === "ENOENT" ||
    result.code === "EACCES" ||
    result.code === "EPERM" ||
    result.code === "EAGAIN" ||
    result.code === "ENOMEM"
  ) {
    result.category = "spawn";
    result.reason = `GitHub subprocess could not start (${result.code}).`;
  } else if (result.signal !== null) {
    result.category = "signal";
    result.reason = `GitHub subprocess ended with ${result.signal}; timeout unknown.`;
  } else if (result.code !== null) {
    result.reason = `GitHub subprocess failed (${result.code}); no HTTP response.`;
  }
  return result;
}

class FactoryAssignmentReadError extends Error {
  constructor(readonly diagnostics: ProjectFactoryAssignmentDiagnostic) {
    super(diagnostics.reason);
    this.name = "FactoryAssignmentReadError";
  }
}

function parseIncluded(stdout: string): GitHubResponse | null {
  const match = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  if (!match) return null;
  const split = stdout.search(/\r?\n\r?\n/);
  const text = split < 0 ? "" : stdout.slice(split).trim();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: Number(match[1]), body };
}

export class FactoryGitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryGitHubError";
  }
}

const refSchema = z.object({ ref: z.string(), object: z.object({ sha: z.string() }) });
const ARCHIVE_PREFIX = "factory-released";
/** A foreign claim with no activity for this long may be released, with the owner's consent. */
export const STALE_CLAIM_MS = 24 * 60 * 60 * 1000;

/** `<serverId>/<projectId>`: names this installation in markers and `.github/factory.json`. */
export function installationIdentity(serverId: string, projectId: string): string {
  return `${serverId}/${projectId}`;
}

/** The visible line and hidden marker every plan comment and Factory PR body carries. */
export function claimMarker(installation: string, branch: string): string {
  return [
    `Factory installation: ${installation} (branch ${branch})`,
    `<!-- factory-claim v1 installation=${installation} branch=${branch} -->`,
  ].join("\n");
}

const MARKER = /<!-- factory-claim v1 installation=(\S+) branch=(\S+) -->/g;

/** Installations whose markers in `text` name `branch`. */
export function markerInstallations(text: string, branch: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MARKER)) if (match[2] === branch) found.push(match[1]!);
  return found;
}

function expect(response: GitHubResponse, ok: number[], what: string): unknown {
  if (ok.includes(response.status)) return response.body;
  const message =
    typeof response.body === "object" && response.body !== null && "message" in response.body
      ? String((response.body as { message: unknown }).message)
      : `HTTP ${response.status}`;
  throw new FactoryGitHubError(`GitHub refused ${what}: ${message} (HTTP ${response.status}).`);
}

/** What claims and releases share; releasing reads no markers, so it needs no trust. */
export interface ClaimBase {
  github: FactoryGitHub;
  repository: string;
  installation: string;
  issue: number;
  now: Date;
  /** Reads this installation's claim for the issue. */
  read: () => Promise<ClaimState | undefined>;
  /** Writes (or, with undefined, removes) this installation's claim for the issue. */
  write: (claim: ClaimState | undefined) => Promise<void>;
}

export interface ClaimContext extends ClaimBase {
  /** The owner chose this installation in a conflict. */
  keep?: boolean;
  /** Only markers in comments by these accounts count; anyone can comment on a public issue. */
  trusted: TrustedAccounts;
}

/**
 * Claims an issue, or reports who owns it. The intent is recorded before the branch is
 * created, so a crash in between is recovered: a branch at the recorded commit, with no other
 * installation's marker on the issue, is this installation's own.
 */
export async function claimIssue(ctx: ClaimContext): Promise<ProjectFactoryClaim> {
  const branch = projectFactoryClaimBranch(ctx.issue);
  const result = (
    outcome: ProjectFactoryClaim["outcome"],
    headSha: string | null,
  ): ProjectFactoryClaim => ({
    issue: ctx.issue,
    branch,
    outcome,
    installation: ctx.installation,
    headSha,
    marker:
      outcome === "claimed" || outcome === "held" ? claimMarker(ctx.installation, branch) : null,
  });

  const existing = await ctx.read();
  if (existing?.status === "held" || existing?.status === "conflict") {
    const head = await readHead(ctx, branch);
    if (head === null || (await wasReleased(ctx, existing))) {
      await ctx.write(undefined);
      return result("lost", head);
    }
    const rivals = await foreignMarkers(ctx, branch, existing.overruled);
    if (existing.status === "conflict" && ctx.keep) {
      const overruled = [...new Set([...(existing.overruled ?? []), ...rivals])];
      await ctx.write({ ...existing, status: "held", overruled });
      return result("held", head);
    }
    if (existing.status === "conflict" || rivals.length > 0) {
      await ctx.write({ ...existing, status: "conflict" });
      return result("conflict", head);
    }
    return result("held", head);
  }

  let intent = existing;
  const recovering = intent !== undefined;
  if (!intent) {
    const baseSha = await defaultBranchHead(ctx);
    intent = {
      branch,
      status: "pending",
      attemptId: randomUUID(),
      baseSha,
      startedAt: ctx.now.toISOString(),
      archivesAtClaim: await archives(ctx),
    };
    await ctx.write(intent);
  }

  const created = await ctx.github.rest("POST", `repos/${ctx.repository}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: intent.baseSha,
  });
  if (created.status === 201) {
    // Read again now that the branch exists: a release of the previous claim can land between
    // the first read and the creation, and must not count as this claim's release. This claim
    // cannot have been released yet; a release needs a day of inactivity and the owner's yes.
    await ctx.write({
      ...intent,
      status: "held",
      claimedAt: ctx.now.toISOString(),
      archivesAtClaim: await archives(ctx),
    });
    return result("claimed", intent.baseSha);
  }
  if (created.status !== 422) {
    // The intent stays, so a retry after a lost response is recovered rather than duplicated.
    expect(created, [201], `creating ${branch}`);
  }
  const head = await readHead(ctx, branch);
  if (recovering && head === intent.baseSha) {
    // This installation's own claim from before a crash or lost response, unless another
    // installation's marker says it created the branch at the same commit. GitHub cannot tell
    // the two apart, so that case waits for the owner instead of resolving either way.
    // A new archive since the intent may be this claim's release or the previous claim's;
    // either way the owner decides.
    const rivals = await foreignMarkers(ctx, branch);
    const status = rivals.length === 0 && !(await wasReleased(ctx, intent)) ? "held" : "conflict";
    // The snapshot moves to now, so the archive that raised the question is not later read as
    // a release, while any release after this point still is.
    await ctx.write({
      ...intent,
      status,
      claimedAt: ctx.now.toISOString(),
      archivesAtClaim: await archives(ctx),
    });
    return result(status, head);
  }
  await ctx.write(undefined);
  return result("foreign", head);
}

export interface ReleaseContext extends ClaimBase {
  foreign: ForeignClaimState | undefined;
}

/**
 * Releases a claim after the owner agreed. A conflicting claim of this installation's own is
 * only forgotten. A stale foreign claim is renamed to `factory-released/issue-<n>/<time>`:
 * GitHub moves the branch and every commit on it in one step, so no push is lost, nothing is
 * rewritten and there is no half-released state. Any later claim sees that archive before it
 * can claim, so only the released claim reads it as its release.
 */
export async function releaseClaim(ctx: ReleaseContext): Promise<ProjectFactoryClaimRelease> {
  const branch = projectFactoryClaimBranch(ctx.issue);
  const own = await ctx.read();
  if (own?.status === "conflict") {
    await ctx.write(undefined);
    return { issue: ctx.issue, branch, outcome: "forgotten", archivedAs: null, headSha: null };
  }
  if (own)
    throw new FactoryGitHubError(
      `This installation owns ${branch}. Release only another installation's stale claim, or your own conflicting one.`,
    );
  const head = await readHead(ctx, branch);
  if (head === null)
    return { issue: ctx.issue, branch, outcome: "absent", archivedAs: null, headSha: null };
  if (!ctx.foreign?.notifiedAt || ctx.foreign.headSha !== head)
    throw new FactoryGitHubError(
      `${branch} is not a stale claim the owner was asked about at ${head.slice(0, 9)}. Ask the owner first.`,
    );
  const stamp = ctx.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const archivedAs = `${ARCHIVE_PREFIX}/issue-${ctx.issue}/${stamp}`;
  const renamed = expect(
    await ctx.github.rest(
      "POST",
      `repos/${ctx.repository}/branches/${encodeURIComponent(branch)}/rename`,
      { new_name: archivedAs },
    ),
    [201],
    `releasing ${branch}`,
  );
  const headSha =
    z.object({ commit: z.object({ sha: z.string() }) }).safeParse(renamed).data?.commit.sha ?? head;
  return { issue: ctx.issue, branch, outcome: "archived", archivedAs, headSha };
}

async function readHead(ctx: ClaimBase, branch: string): Promise<string | null> {
  const response = await ctx.github.rest("GET", `repos/${ctx.repository}/git/ref/heads/${branch}`);
  if (response.status === 404) return null;
  return refSchema.parse(expect(response, [200], `reading ${branch}`)).object.sha;
}

async function defaultBranchHead(ctx: ClaimBase): Promise<string> {
  const repo = z
    .object({ default_branch: z.string() })
    .parse(
      expect(await ctx.github.rest("GET", `repos/${ctx.repository}`), [200], "the repository"),
    );
  const head = await readHead(ctx, repo.default_branch);
  if (!head) throw new FactoryGitHubError(`${repo.default_branch} has no commit to claim from.`);
  return head;
}

async function archives(ctx: ClaimBase): Promise<string[]> {
  const response = await ctx.github.rest(
    "GET",
    `repos/${ctx.repository}/git/matching-refs/heads/${ARCHIVE_PREFIX}/issue-${ctx.issue}/`,
  );
  return z
    .array(refSchema)
    .parse(expect(response, [200], "archived claims"))
    .map((ref) => ref.ref);
}

/** A release archives the claim under a new name, so any archive newer than the claim means it was released. */
async function wasReleased(ctx: ClaimBase, claim: ClaimState): Promise<boolean> {
  const known = new Set(claim.archivesAtClaim);
  return (await archives(ctx)).some((ref) => !known.has(ref));
}

/** Other installations' markers naming this branch, on the issue's comments or its open PR. */
async function foreignMarkers(
  ctx: ClaimContext,
  branch: string,
  overruled: readonly string[] = [],
): Promise<string[]> {
  const texts = await activityTexts(ctx.github, ctx.repository, ctx.issue, branch, ctx.trusted);
  return texts
    .flatMap((item) => markerInstallations(item.body, branch))
    .filter(
      (installation) => installation !== ctx.installation && !overruled.includes(installation),
    );
}

const commentSchema = z.array(
  z.object({
    body: z.string().nullable(),
    updated_at: z.string(),
    user: z.object({ login: z.string() }).nullable().optional(),
  }),
);
const pullSchema = z.array(z.object({ body: z.string().nullable(), updated_at: z.string() }));

async function activityTexts(
  github: FactoryGitHub,
  repository: string,
  issue: number,
  branch: string,
  trusted: TrustedAccounts,
): Promise<{ body: string; updatedAt: string }[]> {
  const owner = repository.split("/")[0];
  const [comments, pulls] = await Promise.all([
    github.rest("GET", `repos/${repository}/issues/${issue}/comments?per_page=100`),
    github.rest(
      "GET",
      `repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    ),
  ]);
  // The `owner:branch` head filter already leaves out pull requests from forks.
  const trustedComments = [];
  for (const comment of commentSchema.parse(expect(comments, [200], `comments on #${issue}`)))
    if (await trusted(comment.user?.login)) trustedComments.push(comment);
  return [
    ...trustedComments,
    ...pullSchema.parse(expect(pulls, [200], `pull requests from ${branch}`)),
  ].map((item) => ({ body: item.body ?? "", updatedAt: item.updated_at }));
}

/**
 * Files that decide who Factory trusts and where its roles run. A Factory pull request that
 * changes one never merges through Factory: the owner reviews and merges it.
 */
export const OWNER_ONLY_FILES = [".github/delivery-approvers.json", ".github/factory.json"];

const pullHeadSchema = z.object({
  number: z.number(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});
const pullFilesSchema = z.array(
  z.object({ filename: z.string(), previous_filename: z.string().optional() }),
);

export interface OwnerOnlyCheck {
  /** Owner-only files the issue's open pull requests change. */
  touched: string[];
  /** The head commit of the issue's pull request that was checked; null without one. */
  checkedHeadSha: string | null;
}

/**
 * Checks every open same-repository pull request the queue treats as the issue's: the claim
 * branch and the older `<prefix>/factory-issue-<n>` form. Each pull request's head is read
 * again after its files, so the result names the exact commit checked; a push in between
 * refuses. Fails closed on any read error.
 */
export async function ownerOnlyChanges(
  github: FactoryGitHub,
  repository: string,
  issue: number,
): Promise<OwnerOnlyCheck> {
  const branch = projectFactoryClaimBranch(issue);
  const ours = (pull: z.infer<typeof pullHeadSchema>) =>
    pull.head.repo?.full_name.toLowerCase() === repository.toLowerCase() &&
    (pull.head.ref === branch || pull.head.ref.endsWith(`/factory-issue-${issue}`));
  const pulls: z.infer<typeof pullHeadSchema>[] = [];
  for (let page = 1; ; page++) {
    const listed = z
      .array(pullHeadSchema)
      .parse(
        expect(
          await github.rest(
            "GET",
            `repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
          ),
          [200],
          "open pull requests",
        ),
      );
    pulls.push(...listed.filter(ours));
    if (listed.length < 100) break;
  }
  const touched = new Set<string>();
  let checkedHeadSha: string | null = null;
  for (const pull of pulls) {
    for (const name of await pullFileNames(github, repository, pull.number))
      if (OWNER_ONLY_FILES.includes(name)) touched.add(name);
    const after = pullHeadSchema.parse(
      expect(
        await github.rest("GET", `repos/${repository}/pulls/${pull.number}`),
        [200],
        `pull request #${pull.number}`,
      ),
    );
    if (after.head.sha !== pull.head.sha)
      throw new FactoryGitHubError(
        `Pull request #${pull.number} moved while Factory checked it. Claim the issue again.`,
      );
    if (pull.head.ref === branch || checkedHeadSha === null) checkedHeadSha = pull.head.sha;
  }
  return { touched: [...touched], checkedHeadSha };
}

/** Every path a pull request adds, changes, removes or renames from. */
async function pullFileNames(
  github: FactoryGitHub,
  repository: string,
  number: number,
): Promise<string[]> {
  const names: string[] = [];
  // GitHub lists at most 3000 files, 100 per page.
  for (let page = 1; page <= 30; page++) {
    const files = pullFilesSchema.parse(
      expect(
        await github.rest(
          "GET",
          `repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
        ),
        [200],
        `files of pull request #${number}`,
      ),
    );
    for (const file of files)
      names.push(file.filename, ...(file.previous_filename ? [file.previous_filename] : []));
    if (files.length < 100) return names;
  }
  throw new FactoryGitHubError(
    `Pull request #${number} lists more files than GitHub returns, so Factory cannot check it.`,
  );
}

export interface StaleClaim {
  issue: number;
  branch: string;
  headSha: string;
  /** The owning installation from its markers, or null when it left none. */
  installation: string | null;
  lastActivityAt: string;
  /** This installation's own crash-interrupted claim that it cannot prove is its own. */
  unconfirmed: boolean;
}

export interface ForeignScan {
  /** Every foreign claim branch now, with its first-seen record carried forward. */
  foreign: Record<string, ForeignClaimState>;
  /** Foreign claims idle past the stale limit whose current head the Foreman has not heard about. */
  stale: StaleClaim[];
}

/**
 * Finds other installations' claim branches and the ones idle for more than a day. A head's
 * age is at least the time since this installation first saw it, so a fresh claim on an old
 * default-branch commit is never stale early.
 */
export async function scanForeignClaims(input: {
  github: FactoryGitHub;
  repository: string;
  installation: string;
  trusted: TrustedAccounts;
  own: Record<string, ClaimState>;
  previous: Record<string, ForeignClaimState>;
  now: Date;
}): Promise<ForeignScan> {
  const response = await input.github.rest(
    "GET",
    `repos/${input.repository}/git/matching-refs/heads/factory/issue-`,
  );
  const refs = z.array(refSchema).parse(expect(response, [200], "claim branches"));
  const foreign: Record<string, ForeignClaimState> = {};
  const stale: StaleClaim[] = [];
  for (const ref of refs) {
    const branch = ref.ref.replace(/^refs\/heads\//, "");
    const match = /^factory\/issue-(\d+)$/.exec(branch);
    if (!match) continue;
    const issue = Number(match[1]);
    const own = input.own[String(issue)];
    if (own?.status === "held" || own?.status === "pending") continue;
    const headSha = ref.object.sha;
    const before = input.previous[branch];
    const record: ForeignClaimState =
      before?.headSha === headSha ? before : { headSha, seenAt: input.now.toISOString() };
    foreign[branch] = record;
    if (record.notifiedAt) continue;
    const conflict = own?.status === "conflict";
    if (!conflict && input.now.getTime() - Date.parse(record.seenAt) <= STALE_CLAIM_MS) continue;
    const texts = await activityTexts(input.github, input.repository, issue, branch, input.trusted);
    const commit = z
      .object({ committer: z.object({ date: z.string() }) })
      .safeParse(
        (await input.github.rest("GET", `repos/${input.repository}/git/commits/${headSha}`)).body,
      );
    const times = [
      record.seenAt,
      ...(commit.success ? [commit.data.committer.date] : []),
      ...texts
        .filter((text) => markerInstallations(text.body, branch).length)
        .map((t) => t.updatedAt),
    ];
    const lastActivityAt = new Date(Math.max(...times.map((time) => Date.parse(time))));
    if (!conflict && input.now.getTime() - lastActivityAt.getTime() <= STALE_CLAIM_MS) continue;
    const installation =
      texts
        .flatMap((text) => markerInstallations(text.body, branch))
        .find((name) => name !== input.installation) ?? null;
    stale.push({
      issue,
      branch,
      headSha,
      installation,
      lastActivityAt: lastActivityAt.toISOString(),
      unconfirmed: conflict,
    });
  }
  return { foreign, stale };
}

/** Told to the Foreman once per stale head; it asks the owner and never takes over by itself. */
export function staleClaimsPrompt(projectId: string, stale: StaleClaim[]): string {
  const lines = stale.map((claim) => {
    const owner = claim.installation ?? "an installation that left no marker";
    return claim.unconfirmed
      ? `- ${claim.branch} (#${claim.issue}): this installation and ${owner} both appear to own it. Ask the owner which one keeps it. If the owner picks this installation, run \`paseo factory project claim issue ${projectId} ${claim.issue} --keep\`; otherwise run \`paseo factory project claim release ${projectId} ${claim.issue}\`.`
      : `- ${claim.branch} (#${claim.issue}) at ${claim.headSha.slice(0, 9)}, held by ${owner}, last active ${claim.lastActivityAt}. Ask the owner once whether to release it. Only if they say yes, run \`paseo factory project claim release ${projectId} ${claim.issue}\`; its commits stay under factory-released/.`;
  });
  return `Stale Factory claims. Ask the owner about each once with one update_questions question each; the recommended default is "Keep it". Never release one without their yes, and never work on another installation's branch.\n${lines.join("\n")}`;
}

const AssignmentFileSchema = z.strictObject({
  version: z.literal(1),
  triage: z.string().min(1).optional(),
  releases: z.string().min(1).optional(),
});

/** Reads `.github/factory.json` from the default branch. Failure turns the assigned roles off. */
export async function readAssignment(
  github: FactoryGitHub,
  repository: string,
  now: Date,
): Promise<AssignmentState> {
  const readAt = now.toISOString();
  const off = (
    source: "invalid" | "unreadable",
    diagnostics: ProjectFactoryAssignmentDiagnostic,
  ): AssignmentState => ({
    source,
    triage: null,
    releases: null,
    detail: diagnostics.reason,
    diagnostics,
    readAt,
  });
  let response: GitHubResponse;
  try {
    response = await github.rest("GET", `repos/${repository}/contents/.github/factory.json`);
  } catch (error) {
    return off(
      "unreadable",
      error instanceof FactoryAssignmentReadError ? error.diagnostics : subprocessDiagnostic(error),
    );
  }
  if (response.status === 404)
    return { source: "none", triage: null, releases: null, detail: null, readAt };
  const content = z
    .object({ content: z.string(), encoding: z.literal("base64") })
    .safeParse(response.body);
  if (response.status !== 200) {
    const failure = diagnostic(
      "http",
      "GitHub returned an unsuccessful HTTP status for .github/factory.json.",
    );
    const status = ProjectFactoryAssignmentDiagnosticSchema.shape.httpStatus.safeParse(
      response.status,
    );
    failure.httpStatus = status.success ? status.data : null;
    if (failure.httpStatus !== null)
      failure.reason = `GitHub returned HTTP ${failure.httpStatus} for .github/factory.json.`;
    return off("unreadable", failure);
  }
  if (!content.success)
    return off(
      "unreadable",
      diagnostic(
        "response",
        "GitHub returned an unusable contents envelope for .github/factory.json.",
      ),
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(content.data.content, "base64").toString("utf8"));
  } catch {
    return off("invalid", diagnostic("content", ".github/factory.json is not valid JSON."));
  }
  const file = AssignmentFileSchema.safeParse(parsed);
  if (!file.success)
    return off(
      "invalid",
      diagnostic(
        "schema",
        `.github/factory.json must be { "version": 1, "triage": "<installation>", "releases": "<installation>" }.`,
      ),
    );
  return {
    source: "file",
    triage: file.data.triage ?? null,
    releases: file.data.releases ?? null,
    detail: null,
    readAt,
  };
}

/** Null when the role runs here; otherwise the status line explaining why it does not. */
export function assignmentBlock(
  assignment: AssignmentState,
  key: "triage" | "releases",
  title: string,
  installation: string,
): string | null {
  if (assignment.source === "none") return null;
  if (assignment.source !== "file")
    return `Off here: ${assignment.detail ?? "factory.json unusable"}`;
  const assigned = assignment[key];
  if (assigned === installation) return null;
  return assigned
    ? `Off here: .github/factory.json assigns ${title} to ${assigned}`
    : `Off here: .github/factory.json assigns ${title} to no installation`;
}
