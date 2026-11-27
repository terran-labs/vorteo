import { describe, expect, test } from "vitest";
import {
  DRY_RUN_APP,
  decideReviewStatus,
  dryRunReviewStatusClient,
  liveReviewStatusClient,
  postReviewStatus,
  type ReviewAgent,
  type ReviewStatusCredentials,
} from "./review-status.js";

// Synthetic identities and credentials only; nothing here reaches GitHub.
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const agents: ReviewAgent[] = [
  { agentId: "lead", issue: 7, role: "lead", account: "codex-1" },
  { agentId: "worker", issue: 7, role: "worker", account: "codex-2" },
  { agentId: "reviewer", issue: 7, role: "reviewer", account: "claude-1" },
  { agentId: "same-account", issue: 7, role: "reviewer", account: "codex-2" },
  { agentId: "other-issue", issue: 8, role: "reviewer", account: "claude-1" },
];
// Every agent on the configured default: no account is known on either side.
const defaults: ReviewAgent[] = [
  { agentId: "worker", issue: 7, role: "worker", account: null },
  { agentId: "reviewer", issue: 7, role: "reviewer", account: null },
];
const KEY = "-----BEGIN RSA PRIVATE KEY-----\nc3ludGhldGlj\n-----END RSA PRIVATE KEY-----";
const credentials: ReviewStatusCredentials = {
  appId: DRY_RUN_APP,
  installationId: "2000002",
  privateKey: KEY,
};

describe("factory-review status decision", () => {
  test.each([
    { name: "exact-head approval", from: "reviewer", text: `APPROVE ${HEAD}`, state: "success" },
    { name: "stale-head approval", from: "reviewer", text: `APPROVE ${OLD}`, state: "pending" },
    { name: "findings", from: "reviewer", text: `Review ${HEAD}\n\n1. Fix it.`, state: "failure" },
    { name: "the worker's own verdict", from: "worker", text: `APPROVE ${HEAD}`, state: "failure" },
    {
      name: "a reviewer on the worker's account",
      from: "same-account",
      text: `APPROVE ${HEAD}`,
      state: "failure",
    },
    {
      name: "another issue's reviewer",
      from: "other-issue",
      text: `APPROVE ${HEAD}`,
      state: "failure",
    },
    { name: "an unknown agent", from: "stranger", text: `APPROVE ${HEAD}`, state: "failure" },
    {
      name: "a quoted approval after text",
      from: "reviewer",
      text: `Looks fine.\nAPPROVE ${HEAD}`,
      state: "pending",
    },
    { name: "no reply yet", from: null, text: "", state: "pending" },
    {
      name: "no lead or worker recorded for the issue",
      from: "reviewer",
      text: `APPROVE ${HEAD}`,
      state: "failure",
      team: [agents[2]!],
    },
    {
      name: "worker and reviewer both on the default account",
      from: "reviewer",
      text: `APPROVE ${HEAD}`,
      state: "failure",
      team: defaults,
    },
  ])("$name: $state", ({ from, text, state, team }) => {
    const reply = from ? { agentId: from, text } : null;
    const decision = decideReviewStatus({ issue: 7, headSha: HEAD, agents: team ?? agents, reply });
    expect(decision).toMatchObject({ context: "factory-review", sha: HEAD, state });
    expect(decision.description.length).toBeLessThanOrEqual(140);
  });
});

describe("factory-review status posting", () => {
  const approved = decideReviewStatus({
    issue: 7,
    headSha: HEAD,
    agents,
    reply: { agentId: "reviewer", text: `APPROVE ${HEAD}` },
  });

  test("a dry run names the intended status, is idempotent and writes nothing live", async () => {
    const { client, intended } = dryRunReviewStatusClient();
    const first = await postReviewStatus({
      repository: "acme/app",
      decision: approved,
      credentials,
      client,
    });
    const again = await postReviewStatus({
      repository: "acme/app",
      decision: approved,
      credentials,
      client,
    });
    expect(first).toMatchObject({ outcome: "posted", sha: HEAD, state: "success" });
    expect(again.outcome).toBe("unchanged");
    expect(intended).toEqual([approved]);
    // An approval for the old head never marks the new one.
    const { client: fresh } = dryRunReviewStatusClient();
    await postReviewStatus({
      repository: "acme/app",
      decision: approved,
      credentials,
      client: fresh,
    });
    expect(await fresh.listStatuses("acme/app", OLD)).toEqual([]);
  });

  test.each([
    { name: "missing", value: null },
    { name: "non-numeric ids", value: { ...credentials, appId: "app" } },
    { name: "a key that is not PEM", value: { ...credentials, privateKey: "not a key" } },
  ])("a $name credential fails closed without writing", async ({ value }) => {
    const { client, intended } = dryRunReviewStatusClient();
    const receipt = await postReviewStatus({
      repository: "acme/app",
      decision: approved,
      credentials: value,
      client,
    });
    expect(receipt.outcome).toBe("refused");
    expect(receipt.reason).toBeTruthy();
    expect(intended).toEqual([]);
  });

  test("the live client is not enabled", async () => {
    await expect(
      postReviewStatus({
        repository: "acme/app",
        decision: approved,
        credentials,
        client: liveReviewStatusClient,
      }),
    ).rejects.toThrow("not enabled");
  });
});
