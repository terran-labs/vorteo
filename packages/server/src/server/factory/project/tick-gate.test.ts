import { describe, expect, it } from "vitest";
import { computeFingerprint, shouldWake, type GatedRole, type GhRunner } from "./tick-gate.js";

const pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
  hasNextPage: false,
  endCursor: null,
};
function fixture() {
  return {
    data: {
      repository: {
        defaultBranchRef: { target: { oid: "head" } },
        issues: {
          nodes: [
            {
              number: 1,
              updatedAt: "today",
              labels: {
                nodes: [{ name: "factory:ready" }, { name: "bug" }],
                pageInfo,
              },
            },
          ],
          pageInfo,
        },
        pullRequests: {
          nodes: [
            {
              number: 2,
              headRefName: "factory-issue-1",
              headRefOid: "pr-head",
              reviewDecision: "APPROVED",
              mergeStateStatus: "CLEAN",
              latestReviews: {
                nodes: [{ id: "R1", state: "APPROVED" }],
                pageInfo: { hasPreviousPage: false },
              },
              commits: {
                nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
              },
            },
          ],
          pageInfo,
        },
      },
    },
  };
}
class FakeGh implements GhRunner {
  calls: Record<string, unknown>[] = [];
  constructor(public response: unknown = fixture()) {}
  async graphql(_query: string, variables: Record<string, unknown>): Promise<unknown> {
    this.calls.push(variables);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}
function fingerprint(role: GatedRole, response: unknown) {
  return computeFingerprint(role, {
    repository: "owner/repo",
    gh: new FakeGh(response),
  });
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, item]) => [key, reverseKeys(item)]),
  );
}

describe("computeFingerprint", () => {
  it.each<GatedRole>(["factory-intake", "factory-triage", "factory-builds"])(
    "canonicalizes %s in a single round trip",
    async (role) => {
      const gh = new FakeGh();
      const actual = await computeFingerprint(role, {
        repository: "owner/repo",
        gh,
      });
      expect(actual).toMatch(/^[a-f0-9]{64}$/);
      expect(actual).toBe(await fingerprint(role, reverseKeys(fixture())));
      expect(gh.calls).toHaveLength(1);
    },
  );
  const mutations = [
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.defaultBranchRef.target.oid = "new";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.issues.nodes[0]!.number++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.issues.nodes[0]!.updatedAt = "later";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.issues.nodes[0]!.labels.nodes.push({ name: "new" });
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.pullRequests.nodes[0]!.number++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.pullRequests.nodes[0]!.headRefOid = "new";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.pullRequests.nodes[0]!.reviewDecision = "CHANGES_REQUESTED";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.pullRequests.nodes[0]!.latestReviews.nodes[0]!.id = "R2";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.pullRequests.nodes[0]!.latestReviews.nodes[0]!.state = "DISMISSED";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.pullRequests.nodes[0]!.commits.nodes[0]!.commit.statusCheckRollup.state =
        "FAILURE";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.repository.pullRequests.nodes[0]!.mergeStateStatus = "DIRTY";
    },
  ];
  it.each(mutations.map((mutate, index) => ({ mutate, index })))(
    "tracks intake input $index",
    async ({ mutate }) => {
      const changed = fixture();
      mutate(changed);
      expect(await fingerprint("factory-intake", changed)).not.toBe(
        await fingerprint("factory-intake", fixture()),
      );
    },
  );
  it.each([1, 2, 3])("tracks triage issue input %s", async (index) => {
    const changed = fixture();
    mutations[index]!(changed);
    expect(await fingerprint("factory-triage", changed)).not.toBe(
      await fingerprint("factory-triage", fixture()),
    );
  });
  it("tracks builds head and excludes unrelated inputs", async () => {
    const changed = fixture();
    mutations[0]!(changed);
    expect(await fingerprint("factory-builds", changed)).not.toBe(
      await fingerprint("factory-builds", fixture()),
    );
    mutations[1]!(changed);
    expect(await fingerprint("factory-builds", changed)).toBe(
      await fingerprint("factory-builds", {
        data: {
          repository: {
            defaultBranchRef: changed.data.repository.defaultBranchRef,
          },
        },
      }),
    );
  });
  it("sorts label names and ignores unrelated PRs and issues", async () => {
    const changed = fixture();
    changed.data.repository.issues.nodes[0]!.labels.nodes =
      changed.data.repository.issues.nodes[0]!.labels.nodes.toReversed();
    expect(await fingerprint("factory-intake", changed)).toBe(
      await fingerprint("factory-intake", fixture()),
    );
    changed.data.repository.issues.nodes = [];
    changed.data.repository.pullRequests.nodes = [];
    const unrelated = fixture();
    unrelated.data.repository.issues.nodes[0]!.labels.nodes = [{ name: "bug" }];
    unrelated.data.repository.pullRequests.nodes[0]!.headRefName = "feature";
    expect(await fingerprint("factory-intake", unrelated)).toBe(
      await fingerprint("factory-intake", changed),
    );
  });
  it.each([new Error("offline"), {}, { errors: [{ message: "denied" }], ...fixture() }])(
    "fails open on unavailable evidence",
    async (response) => {
      expect(await fingerprint("factory-intake", response)).toBeNull();
    },
  );
  it("fails open on truncated labels or reviews", async () => {
    const response = fixture();
    response.data.repository.issues.nodes[0]!.labels.pageInfo = {
      hasNextPage: true,
      endCursor: null,
    };
    expect(await fingerprint("factory-intake", response)).toBeNull();
  });
  it("includes later issue and PR pages in the fingerprint", async () => {
    const first = fixture();
    first.data.repository.issues.pageInfo = {
      hasNextPage: true,
      endCursor: "issues-next",
    };
    first.data.repository.pullRequests.pageInfo = {
      hasNextPage: true,
      endCursor: "prs-next",
    };
    const second = fixture();
    second.data.repository.issues.nodes[0]!.number = 3;
    second.data.repository.pullRequests.nodes[0]!.number = 4;
    const calls: Record<string, unknown>[] = [];
    const gh: GhRunner = {
      async graphql(_query, variables) {
        calls.push(variables);
        return calls.length === 1 ? first : second;
      },
    };
    const actual = await computeFingerprint("factory-intake", {
      repository: "owner/repo",
      gh,
    });
    const combined = fixture();
    combined.data.repository.issues.nodes.push(...second.data.repository.issues.nodes);
    combined.data.repository.pullRequests.nodes.push(...second.data.repository.pullRequests.nodes);
    expect(actual).toBe(await fingerprint("factory-intake", combined));
    expect(calls[1]).toMatchObject({
      issueCursor: "issues-next",
      prCursor: "prs-next",
    });
  });
  it("paginates intake but keeps triage to the newest 100 issues", async () => {
    const response = fixture();
    response.data.repository.issues.pageInfo = {
      hasNextPage: true,
      endCursor: null,
    };
    expect(await fingerprint("factory-intake", response)).toBeNull();
    expect(await fingerprint("factory-triage", response)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("shouldWake", () => {
  const base = {
    role: "factory-intake",
    current: "same",
    last: "same",
    pending: false,
    lastWakeAt: "2026-11-03T00:00:00Z",
    now: new Date("2026-11-03T01:00:00Z"),
  };
  it.each([
    { patch: { role: "factory-releases" }, reason: "ungated-role" },
    { patch: { current: null }, reason: "fingerprint-unavailable" },
    { patch: { last: null }, reason: "first" },
    { patch: { lastWakeAt: null }, reason: "first" },
    { patch: { current: "new" }, reason: "changed" },
    { patch: { pending: true }, reason: "pending" },
    { patch: { maxQuietMs: 3_600_000 }, reason: "max-quiet" },
    { patch: { lastWakeAt: "invalid" }, reason: "max-quiet" },
    { patch: { lastWakeAt: "2026-11-04T00:00:00Z" }, reason: "max-quiet" },
    { patch: {}, reason: "unchanged" },
  ])("returns $reason", ({ patch, reason }) => {
    expect(shouldWake({ ...base, ...patch })).toEqual({
      wake: reason !== "unchanged",
      reason,
    });
  });
});
