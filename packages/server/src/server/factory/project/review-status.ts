/**
 * Preparation for #252: the Factory's independent review as a `factory-review` commit status
 * that GitHub can require. Inactive. Nothing in the service calls this module, the live client
 * refuses every call, and no key is read anywhere. Tests drive it with synthetic credentials
 * and a dry-run client that records intended writes without making them.
 *
 * Today's verdict path, which this mirrors and does not replace: the Foreman starts a reviewer
 * agent labeled factory.issue=<n> and factory.role=reviewer, independent of the issue's lead
 * and worker; the reviewer replies "APPROVE <sha>" or "Review <sha>" with numbered findings;
 * the Foreman records that reply in a PR comment that the queue reads as display evidence
 * (`recordedReview` in queue.ts); merge authority is the Foreman charter's rule that only the
 * reviewer's own reply for the exact head approves. The decision below takes the reviewer's
 * reply as the daemon would read it from that agent, never from a PR comment.
 */

export const FACTORY_REVIEW_CONTEXT = "factory-review";

export type ReviewRole = "lead" | "worker" | "reviewer";

/** An issue agent as the daemon records it, from its factory.* labels. */
export interface ReviewAgent {
  agentId: string;
  issue: number;
  role: ReviewRole;
  /**
   * The account the agent runs on, or null when unknown, as for an agent on the configured
   * default. The live step must take it from the agent's launch config, not its labels.
   */
  account: string | null;
}

/** A reviewer's reply, read by the daemon from that reviewer agent's own last message. */
export interface ReviewReply {
  agentId: string;
  text: string;
}

export interface ReviewStatusInput {
  issue: number;
  /** The pull request's current head commit. */
  headSha: string;
  /** Every agent the daemon has recorded for the issue. */
  agents: readonly ReviewAgent[];
  reply: ReviewReply | null;
}

export type ReviewStatusState = "success" | "failure" | "pending";

export interface ReviewStatusDecision {
  context: typeof FACTORY_REVIEW_CONTEXT;
  sha: string;
  state: ReviewStatusState;
  /** GitHub shows at most 140 characters. */
  description: string;
}

const SHA = /^[0-9a-f]{40}$/;

/** The verdict a reply gives, with the same line rules the queue applies to recorded replies. */
export function parseReviewReply(text: string): { approved: boolean; sha: string } | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const first = lines.find((line) => line.length > 0);
  if (!first) return null;
  const approve = /^APPROVE ([0-9a-f]{40})$/.exec(first);
  if (approve) return { approved: true, sha: approve[1]! };
  const review = /^Review ([0-9a-f]{40})$/.exec(first);
  if (review && lines.some((line) => /^\d+[.)]\s/.test(line)))
    return { approved: false, sha: review[1]! };
  return null;
}

/**
 * Success only for an approval of this exact head from this issue's reviewer, who is neither
 * its lead nor its worker and runs on a known account none of them uses. A new push needs a
 * new review. Provider independence is not checked.
 */
export function decideReviewStatus(input: ReviewStatusInput): ReviewStatusDecision {
  if (!SHA.test(input.headSha)) throw new Error(`Not a full commit SHA: ${input.headSha}`);
  const head = input.headSha.slice(0, 9);
  const decision = (state: ReviewStatusState, description: string): ReviewStatusDecision => ({
    context: FACTORY_REVIEW_CONTEXT,
    sha: input.headSha,
    state,
    description,
  });
  if (!input.reply) return decision("pending", `Waiting for the independent review of ${head}.`);
  const reviewer = input.agents.find((agent) => agent.agentId === input.reply!.agentId);
  if (!reviewer || reviewer.role !== "reviewer" || reviewer.issue !== input.issue)
    return decision("failure", `The verdict did not come from issue #${input.issue}'s reviewer.`);
  const authors = input.agents.filter(
    (agent) => agent.issue === input.issue && agent.role !== "reviewer",
  );
  // Agent ids are unique, so a reviewer is never the lead or worker thread itself; a shared
  // account would still make it the same identity. An unknown account on either side, such as
  // two agents on the configured default, cannot be shown to differ, so it is not independent.
  // With no lead or worker recorded there is nothing to be independent of, so it is unproven.
  if (
    authors.length === 0 ||
    reviewer.account === null ||
    authors.some((agent) => agent.account === null)
  )
    return decision(
      "failure",
      `No lead or worker is recorded, or an account is unknown, so independence is unproven.`,
    );
  if (authors.some((agent) => agent.account === reviewer.account))
    return decision("failure", `The reviewer shares an account with the issue's lead or worker.`);
  const verdict = parseReviewReply(input.reply.text);
  if (!verdict) return decision("pending", `The reviewer's reply has no verdict for ${head}.`);
  if (verdict.sha !== input.headSha)
    return decision(
      "pending",
      `Reviewed ${verdict.sha.slice(0, 9)}; ${head} needs its own review.`,
    );
  return verdict.approved
    ? decision("success", `Independent review approved ${head}.`)
    : decision("failure", `Independent review requested changes on ${head}.`);
}

/** The App identity the daemon would post with. Only synthetic values exist in this release. */
export interface ReviewStatusCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
}

export interface CommitStatus {
  context: string;
  state: string;
  description: string | null;
  /** The GitHub App that created the status, when one did. */
  appId: string | null;
}

/** The two GitHub calls posting needs; the live client is not enabled. */
export interface ReviewStatusClient {
  listStatuses(repository: string, sha: string): Promise<CommitStatus[]>;
  createStatus(repository: string, decision: ReviewStatusDecision): Promise<void>;
}

export interface ReviewStatusReceipt {
  context: typeof FACTORY_REVIEW_CONTEXT;
  sha: string;
  state: ReviewStatusState;
  description: string;
  /** posted: written now. unchanged: this App's latest status already says the same. */
  outcome: "posted" | "unchanged" | "refused";
  reason: string | null;
}

/** A shape check only; a real key's validity is GitHub's to decide. */
function credentialProblem(credentials: ReviewStatusCredentials | null): string | null {
  if (!credentials) return "No factory-review credential is configured.";
  if (!/^\d+$/.test(credentials.appId) || !/^\d+$/.test(credentials.installationId))
    return "The factory-review App and installation ids must be numbers.";
  const key = credentials.privateKey.trim();
  if (
    !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) ||
    !/-----END [A-Z ]*PRIVATE KEY-----$/.test(key)
  )
    return "The factory-review private key is not a PEM private key.";
  return null;
}

/**
 * Posts the decision once. A missing or malformed credential refuses without writing, so the
 * required check stays absent and the merge stays blocked: it fails closed. Posting is
 * idempotent: when this App's latest status for the context already matches, nothing is written.
 */
export async function postReviewStatus(input: {
  repository: string;
  decision: ReviewStatusDecision;
  credentials: ReviewStatusCredentials | null;
  client: ReviewStatusClient;
}): Promise<ReviewStatusReceipt> {
  const { decision } = input;
  const receipt = (
    outcome: ReviewStatusReceipt["outcome"],
    reason: string | null = null,
  ): ReviewStatusReceipt => ({
    context: decision.context,
    sha: decision.sha,
    state: decision.state,
    description: decision.description,
    outcome,
    reason,
  });
  const problem = credentialProblem(input.credentials);
  if (problem) return receipt("refused", problem);
  const appId = input.credentials!.appId;
  // GitHub lists a commit's statuses newest first.
  const latest = (await input.client.listStatuses(input.repository, decision.sha)).find(
    (status) => status.context === decision.context && status.appId === appId,
  );
  if (latest?.state === decision.state && latest.description === decision.description)
    return receipt("unchanged");
  await input.client.createStatus(input.repository, decision);
  return receipt("posted");
}

/** Refuses every call: live statuses wait for the owner's App and the steps in docs/factory.md. */
export const liveReviewStatusClient: ReviewStatusClient = {
  async listStatuses() {
    throw new Error("Live factory-review statuses are not enabled in this release.");
  },
  async createStatus() {
    throw new Error("Live factory-review statuses are not enabled in this release.");
  },
};

/**
 * A client that answers from a fixed status list and records what it would write. Its writes
 * never leave the process, so a dry run's receipt proves zero live writes.
 */
export function dryRunReviewStatusClient(existing: CommitStatus[] = []) {
  const intended: ReviewStatusDecision[] = [];
  const client: ReviewStatusClient = {
    async listStatuses(_repository, sha) {
      return [
        ...intended
          .filter((decision) => decision.sha === sha)
          .toReversed()
          .map(({ context, state, description }) => ({
            context,
            state,
            description,
            appId: DRY_RUN_APP,
          })),
        ...existing,
      ];
    },
    async createStatus(_repository, decision) {
      intended.push(decision);
    },
  };
  return { client, intended };
}

/** The synthetic App id dry runs and tests use. */
export const DRY_RUN_APP = "1000001";
