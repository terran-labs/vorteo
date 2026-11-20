import {
  AGENT_PROVIDER_DEFINITIONS,
  DEV_AGENT_PROVIDER_DEFINITIONS,
} from "@getpaseo/protocol/provider-manifest";
import { describe, expect, it } from "vitest";
import {
  type AccessComparisonOptions,
  type AccessTier,
  type ChildEscalation,
  type RefusalReason,
  type AccessDecision,
  type RequestedChildAccess,
  type SupervisorAccess,
  DELIBERATELY_UNMAPPED_PROVIDERS,
  PERMISSION_MODE_TABLE,
  compareChildAccess,
  resolveChildTier,
} from "./levels.js";

const HOST = { kind: "host", id: "host" } as const;
const CONTAINER = { kind: "container", id: "dev" } as const;
const COPILOT_AGENT = "https://agentclientprotocol.com/protocol/session-modes#agent";
const COPILOT_AUTOPILOT = "https://agentclientprotocol.com/protocol/session-modes#autopilot";

function supervisor(over: Partial<SupervisorAccess> = {}): SupervisorAccess {
  return {
    provider: "claude",
    modeId: "acceptEdits",
    modeAuthoritative: true,
    environment: HOST,
    directory: "/a/b",
    ...over,
  };
}

/** A child at its nominal tier: the owner answers, no writable config, authoritative mode. */
function child(over: Partial<RequestedChildAccess> = {}): RequestedChildAccess {
  return {
    provider: "claude",
    modeId: "acceptEdits",
    modeAuthoritative: true,
    promptsAnsweredBy: "owner",
    loadsSupervisorWritableConfig: false,
    environment: HOST,
    directory: "/a/b",
    ...over,
  };
}

const refused = (
  reasons: RefusalReason[],
  childEscalations: ChildEscalation[] = [],
): AccessDecision => ({ kind: "refused", reasons, childEscalations });
const allowed = (
  supervisorTier: AccessTier,
  childTier: AccessTier,
  childEscalations: ChildEscalation[] = [],
): AccessDecision => ({ kind: "allowed", supervisorTier, childTier, childEscalations });

describe("permission table", () => {
  it.each([
    ["claude", "plan", "read-only"],
    ["claude", "default", "attended"],
    ["claude", "acceptEdits", "attended"],
    ["claude", "auto", "attended"],
    ["claude", "bypassPermissions", "unattended"],
    ["codex", "read-only", "read-only"],
    ["codex", "auto", "attended"],
    ["codex", "auto-review", "attended"],
    ["codex", "full-access", "unattended"],
    ["copilot", "allow-all", "unattended"],
    ["copilot", COPILOT_AUTOPILOT, "unattended"],
    ["opencode", "full-access", "unattended"],
    ["omp", "ask", "attended"],
    ["omp", "full", "unattended"],
  ] as const)("%s %s is %s", (provider, modeId, tier) => {
    expect(resolveChildTier(child({ provider, modeId }))).toEqual({ tier, escalations: [] });
  });

  it("covers every manifest mode, or leaves its provider deliberately unmapped", () => {
    for (const definition of [...AGENT_PROVIDER_DEFINITIONS, ...DEV_AGENT_PROVIDER_DEFINITIONS]) {
      if (DELIBERATELY_UNMAPPED_PROVIDERS.includes(definition.id)) continue;
      expect(definition.modes.length, definition.id).toBeGreaterThan(0);
      for (const mode of definition.modes) {
        const row = PERMISSION_MODE_TABLE.find(
          (r) => r.provider === definition.id && r.mode === mode.id,
        );
        expect(row, `${definition.id} ${mode.id}`).toBeDefined();
        if (mode.isUnattended) expect(row?.tier, mode.id).toBe("unattended");
      }
    }
  });
});

describe("compareChildAccess", () => {
  const cases: Array<
    [string, unknown, unknown, AccessComparisonOptions | undefined, Partial<AccessDecision>]
  > = [
    // Tier ordering.
    [
      "equal attended tier",
      supervisor({ provider: "codex", modeId: "auto" }),
      child({ modeId: "default" }),
      undefined,
      allowed("attended", "attended"),
    ],
    [
      "lower tier",
      supervisor({ provider: "codex", modeId: "auto-review" }),
      child({ modeId: "plan" }),
      undefined,
      allowed("attended", "read-only"),
    ],
    [
      "higher tier",
      supervisor({ modeId: "default" }),
      child({ provider: "codex", modeId: "full-access" }),
      undefined,
      refused(["permission:exceeds-supervisor"]),
    ],
    // Reviewer scenarios.
    [
      "supervisor answers an attended child's prompts",
      supervisor({ provider: "codex", modeId: "auto" }),
      child({ modeId: "default", promptsAnsweredBy: "supervisor" }),
      undefined,
      refused(["permission:exceeds-supervisor"], ["prompts-answered-by-supervisor"]),
    ],
    [
      "absent answerer means the supervisor",
      supervisor({ modeId: "plan" }),
      child({ modeId: "plan", promptsAnsweredBy: undefined }),
      undefined,
      refused(["permission:exceeds-supervisor"], ["prompts-answered-by-supervisor"]),
    ],
    [
      "Codex auto under a Claude attended supervisor",
      supervisor(),
      child({ provider: "codex", modeId: "auto-review" }),
      undefined,
      refused(["permission:codex-read-scope"]),
    ],
    [
      "Codex auto under an unattended Claude supervisor",
      supervisor({ modeId: "bypassPermissions" }),
      child({ provider: "codex", modeId: "auto" }),
      undefined,
      allowed("unattended", "attended"),
    ],
    [
      "Claude child loading supervisor-writable config",
      supervisor(),
      child({ modeId: "plan", loadsSupervisorWritableConfig: undefined }),
      undefined,
      refused(["permission:exceeds-supervisor"], ["supervisor-writable-config"]),
    ],
    [
      "non-authoritative child mode",
      supervisor(),
      child({ modeAuthoritative: undefined }),
      undefined,
      refused(["permission:exceeds-supervisor"], ["mode-not-authoritative"]),
    ],
    [
      "unattended flag",
      supervisor(),
      child({ unattended: true }),
      undefined,
      refused(["permission:exceeds-supervisor"], ["unattended-flag"]),
    ],
    // Never over-credit the supervisor.
    [
      "non-authoritative supervisor is unmapped",
      supervisor({ modeAuthoritative: undefined }),
      child(),
      undefined,
      { kind: "unmapped", supervisor: ["permission:mode-not-authoritative"], child: [] },
    ],
    [
      "non-authoritative unattended supervisor gets no exception",
      supervisor({ provider: "omp", modeId: "full", modeAuthoritative: false }),
      child({ provider: "pi", modeId: undefined }),
      undefined,
      {
        kind: "unmapped",
        supervisor: ["permission:mode-not-authoritative"],
        child: ["permission:provider-unmapped"],
      },
    ],
    [
      "auto_accept on a provider that ignores it",
      supervisor({ featureValues: { auto_accept: true } }),
      child({ modeId: "bypassPermissions" }),
      undefined,
      refused(["permission:exceeds-supervisor"]),
    ],
    [
      'auto_accept "false" on the supervisor',
      supervisor({
        provider: "copilot",
        modeId: "allow-all",
        featureValues: { auto_accept: "false" },
      }),
      child(),
      undefined,
      { kind: "unmapped", supervisor: ["feature:invalid-value"], child: [] },
    ],
    [
      "auto_accept 0 on the supervisor",
      supervisor({
        provider: "opencode",
        modeId: "full-access",
        featureValues: { auto_accept: 0 },
      }),
      child(),
      undefined,
      { kind: "unmapped", supervisor: ["feature:invalid-value"], child: [] },
    ],
    [
      "stray unattended property on the supervisor",
      { ...supervisor({ modeId: "default" }), unattended: true },
      child({ modeId: "bypassPermissions" }),
      undefined,
      refused(["permission:exceeds-supervisor"]),
    ],
    [
      'auto_accept "true" on the child',
      supervisor({ modeId: "bypassPermissions" }),
      child({
        provider: "opencode",
        modeId: "full-access",
        featureValues: { auto_accept: "true" },
      }),
      undefined,
      { kind: "unmapped-under-unattended-supervisor", child: ["feature:invalid-value"] },
    ],
    // Unmapped and the exception.
    [
      "provider without modes",
      supervisor(),
      child({ provider: "pi", modeId: undefined }),
      undefined,
      { kind: "unmapped", supervisor: [], child: ["permission:provider-unmapped"] },
    ],
    [
      "unresolved row",
      supervisor(),
      child({ provider: "copilot", modeId: COPILOT_AGENT }),
      undefined,
      { kind: "unmapped", supervisor: [], child: ["permission:mode-unresolved"] },
    ],
    [
      "runtime mode not in the table",
      supervisor(),
      child({ modeId: "dontAsk" }),
      undefined,
      { kind: "unmapped", supervisor: [], child: ["permission:mode-unmapped"] },
    ],
    [
      "absent mode",
      supervisor({ modeId: null }),
      child({ provider: "omp", modeId: undefined }),
      undefined,
      {
        kind: "unmapped",
        supervisor: ["permission:mode-absent"],
        child: ["permission:mode-absent"],
      },
    ],
    [
      "unknown feature",
      supervisor(),
      child({ featureValues: { new_feature: true } }),
      undefined,
      { kind: "unmapped", supervisor: [], child: ["feature:unmapped"] },
    ],
    [
      "unmapped child under an authoritative unattended supervisor",
      supervisor({ provider: "omp", modeId: "full" }),
      child({ provider: "pi", modeId: undefined }),
      undefined,
      { kind: "unmapped-under-unattended-supervisor", child: ["permission:provider-unmapped"] },
    ],
    // Other dimensions.
    [
      "chrome under an unattended supervisor",
      supervisor({ modeId: "bypassPermissions" }),
      child({ featureValues: { chrome: true } }),
      undefined,
      refused(["feature:owner-only"]),
    ],
    [
      "container to host",
      supervisor({ environment: CONTAINER }),
      child(),
      undefined,
      refused(["environment:container-to-host"]),
    ],
    [
      "host to container",
      supervisor(),
      child({ environment: CONTAINER }),
      undefined,
      refused(["environment:mismatch"]),
    ],
    [
      "empty environment ids",
      supervisor({ environment: { kind: "host", id: "" } }),
      child({ environment: { kind: "host", id: "" } }),
      undefined,
      refused(["environment:missing-id"]),
    ],
    [
      "descendant directory",
      supervisor(),
      child({ directory: "/a/b/c" }),
      undefined,
      allowed("attended", "attended"),
    ],
    [
      "sibling sharing a prefix",
      supervisor(),
      child({ directory: "/a/bc" }),
      undefined,
      refused(["directory:outside-scope"]),
    ],
    [
      "unresolved ..",
      supervisor(),
      child({ directory: "/a/b/../../etc" }),
      undefined,
      refused(["directory:not-canonical"]),
    ],
    [
      "supervisor scope at /",
      supervisor({ directory: "/" }),
      child({ directory: "/etc" }),
      undefined,
      refused(["directory:root-scope"]),
    ],
    [
      "worktree at /",
      supervisor(),
      child({ directory: "/etc" }),
      { daemonCreatedWorktrees: ["/"], worktreesRoot: "/w" },
      refused(["directory:root-scope"]),
    ],
    [
      "worktree without a root",
      supervisor(),
      child({ directory: "/w/t" }),
      { daemonCreatedWorktrees: ["/w/t"] },
      refused(["directory:worktree-outside-root"]),
    ],
    [
      "worktree outside its root",
      supervisor(),
      child({ directory: "/x/t" }),
      { daemonCreatedWorktrees: ["/x/t"], worktreesRoot: "/w" },
      refused(["directory:worktree-outside-root"]),
    ],
    [
      "daemon-created worktree under its root",
      supervisor(),
      child({ directory: "/w/t/sub" }),
      { daemonCreatedWorktrees: ["/w/t"], worktreesRoot: "/w" },
      allowed("attended", "attended"),
    ],
    [
      "tool access change",
      supervisor(),
      child({ toolAccess: "clear" }),
      undefined,
      refused(["tool-access:agent-change"]),
    ],
    // Wrong input types refuse, never throw.
    ["null supervisor", null, child(), undefined, refused(["input:invalid"])],
    [
      "numeric directory",
      supervisor(),
      { ...child(), directory: 7 },
      undefined,
      refused(["input:invalid"]),
    ],
    [
      "array feature values",
      supervisor(),
      { ...child(), featureValues: [true] },
      undefined,
      refused(["input:invalid"]),
    ],
    [
      "string worktree list",
      supervisor(),
      child(),
      { daemonCreatedWorktrees: "/w/t" } as never,
      refused(["input:invalid"]),
    ],
    [
      "unknown environment kind",
      supervisor({ environment: { kind: "vm", id: "x" } as never }),
      child(),
      undefined,
      refused(["input:invalid"]),
    ],
  ];

  it.each(cases)("%s", (_name, sup, req, options, expected) => {
    expect(
      compareChildAccess(sup as SupervisorAccess, req as RequestedChildAccess, options),
    ).toEqual(expected);
  });
});
