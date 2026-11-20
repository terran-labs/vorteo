import {
  AGENT_PROVIDER_DEFINITIONS,
  DEV_AGENT_PROVIDER_DEFINITIONS,
} from "@getpaseo/protocol/provider-manifest";
import { describe, expect, it } from "vitest";
import {
  type AccessComparisonOptions,
  type AccessTier,
  type ChildEscalation,
  type DaemonAssertions,
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
    environment: HOST,
    directory: "/a/b",
    ...over,
  };
}

function child(over: Partial<RequestedChildAccess> = {}): RequestedChildAccess {
  return {
    provider: "claude",
    modeId: "acceptEdits",
    environment: HOST,
    directory: "/a/b",
    ...over,
  };
}

/** Every daemon assertion at its most permissive truthful value: the child sits at its nominal tier. */
const TRUTHFUL: DaemonAssertions = {
  supervisorModeAuthoritative: true,
  childModeAuthoritative: true,
  childPromptsAnsweredBy: "owner",
  childLoadsSupervisorWritableConfig: false,
};

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
    expect(resolveChildTier(child({ provider, modeId }), TRUTHFUL)).toEqual({
      tier,
      escalations: [],
    });
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
  interface Case {
    name: string;
    sup: unknown;
    req: unknown;
    /** Merged over TRUTHFUL; `null` passes no assertions at all. */
    asserted?: Partial<DaemonAssertions> | null;
    options?: unknown;
    expected: AccessDecision;
  }
  const unmapped = (sup: string[], req: string[]) =>
    ({ kind: "unmapped", supervisor: sup, child: req }) as AccessDecision;
  const exception = (req: string[]) =>
    ({ kind: "unmapped-under-unattended-supervisor", child: req }) as AccessDecision;

  const cases: Case[] = [
    // Tier ordering.
    {
      name: "equal attended tier",
      sup: supervisor({ provider: "codex", modeId: "auto" }),
      req: child({ modeId: "default" }),
      expected: allowed("attended", "attended"),
    },
    {
      name: "lower tier",
      sup: supervisor({ provider: "codex", modeId: "auto" }),
      req: child({ modeId: "plan" }),
      expected: allowed("attended", "read-only"),
    },
    {
      name: "higher tier",
      sup: supervisor({ modeId: "default" }),
      req: child({ provider: "codex", modeId: "full-access" }),
      expected: refused(["permission:exceeds-supervisor"]),
    },
    // First review: who answers, configuration, authority.
    {
      name: "supervisor answers an attended child's prompts",
      sup: supervisor({ provider: "codex", modeId: "auto" }),
      req: child({ modeId: "default" }),
      asserted: { childPromptsAnsweredBy: "supervisor" },
      expected: refused(["permission:exceeds-supervisor"], ["prompts-answered-by-supervisor"]),
    },
    {
      name: "absent answerer means the supervisor",
      sup: supervisor({ modeId: "plan" }),
      req: child({ modeId: "plan" }),
      asserted: { childPromptsAnsweredBy: undefined },
      expected: refused(["permission:exceeds-supervisor"], ["prompts-answered-by-supervisor"]),
    },
    {
      name: "Claude child loading supervisor-writable config",
      sup: supervisor(),
      req: child({ modeId: "plan" }),
      asserted: { childLoadsSupervisorWritableConfig: undefined },
      expected: refused(["permission:exceeds-supervisor"], ["supervisor-writable-config"]),
    },
    {
      name: "absent config input on a Codex child",
      sup: supervisor({ provider: "codex", modeId: "auto" }),
      req: child({ provider: "codex", modeId: "auto" }),
      asserted: { childLoadsSupervisorWritableConfig: undefined },
      expected: refused(["permission:exceeds-supervisor"], ["supervisor-writable-config"]),
    },
    {
      name: "non-authoritative child mode",
      sup: supervisor(),
      req: child(),
      asserted: { childModeAuthoritative: undefined },
      expected: refused(["permission:exceeds-supervisor"], ["mode-not-authoritative"]),
    },
    {
      name: "unattended flag",
      sup: supervisor(),
      req: child({ unattended: true }),
      expected: refused(["permission:exceeds-supervisor"], ["unattended-flag"]),
    },
    {
      name: "safe defaults allow nothing",
      sup: supervisor({ modeId: "bypassPermissions" }),
      req: child({ modeId: "plan" }),
      asserted: null,
      expected: unmapped(["permission:mode-not-authoritative"], []),
    },
    {
      name: "assertions spread into the request are ignored",
      sup: supervisor({ modeId: "bypassPermissions" }),
      req: {
        ...child({ modeId: "plan" }),
        ...TRUTHFUL,
        promptsAnsweredBy: "owner",
        modeAuthoritative: true,
        loadsSupervisorWritableConfig: false,
      },
      asserted: {
        childModeAuthoritative: undefined,
        childPromptsAnsweredBy: undefined,
        childLoadsSupervisorWritableConfig: undefined,
      },
      expected: allowed("unattended", "unattended", [
        "prompts-answered-by-supervisor",
        "supervisor-writable-config",
        "mode-not-authoritative",
      ]),
    },
    // Second review: Codex read scope under any non-Codex supervisor below unattended.
    {
      name: "Claude plan with Codex read-only",
      sup: supervisor({ modeId: "plan" }),
      req: child({ provider: "codex", modeId: "read-only" }),
      expected: refused(["permission:codex-read-scope"]),
    },
    {
      name: "Claude default with Codex read-only",
      sup: supervisor({ modeId: "default" }),
      req: child({ provider: "codex", modeId: "read-only" }),
      expected: refused(["permission:codex-read-scope"]),
    },
    {
      name: "OMP ask with Codex auto",
      sup: supervisor({ provider: "omp", modeId: "ask" }),
      req: child({ provider: "codex", modeId: "auto" }),
      expected: refused(["permission:codex-read-scope"]),
    },
    {
      name: "Claude acceptEdits with Codex auto-review",
      sup: supervisor(),
      req: child({ provider: "codex", modeId: "auto-review" }),
      expected: refused(["permission:codex-read-scope", "permission:machine-reviewed"]),
    },
    {
      name: "Codex supervisor with Codex read-only",
      sup: supervisor({ provider: "codex", modeId: "auto" }),
      req: child({ provider: "codex", modeId: "read-only" }),
      expected: allowed("attended", "read-only"),
    },
    {
      name: "unattended Claude with Codex auto",
      sup: supervisor({ modeId: "bypassPermissions" }),
      req: child({ provider: "codex", modeId: "auto" }),
      expected: allowed("unattended", "attended"),
    },
    // Second review: machine-reviewed children.
    {
      name: "Claude default with Claude auto",
      sup: supervisor({ modeId: "default" }),
      req: child({ modeId: "auto" }),
      expected: refused(["permission:machine-reviewed"]),
    },
    {
      name: "Codex auto with Codex auto-review",
      sup: supervisor({ provider: "codex", modeId: "auto" }),
      req: child({ provider: "codex", modeId: "auto-review" }),
      expected: refused(["permission:machine-reviewed"]),
    },
    {
      name: "Claude auto with Claude auto",
      sup: supervisor({ modeId: "auto" }),
      req: child({ modeId: "auto" }),
      expected: allowed("attended", "attended"),
    },
    {
      name: "Codex auto-review with Claude auto",
      sup: supervisor({ provider: "codex", modeId: "auto-review" }),
      req: child({ modeId: "auto" }),
      expected: refused(["permission:machine-reviewed"]),
    },
    {
      name: "Codex auto-review with Codex auto-review",
      sup: supervisor({ provider: "codex", modeId: "auto-review" }),
      req: child({ provider: "codex", modeId: "auto-review" }),
      expected: allowed("attended", "attended"),
    },
    // Third review: unprompted writes under a supervisor whose writes prompt.
    {
      name: "Claude default with Claude acceptEdits",
      sup: supervisor({ modeId: "default" }),
      req: child({ modeId: "acceptEdits" }),
      expected: refused(["permission:unprompted-writes"]),
    },
    {
      name: "OMP ask with Claude acceptEdits",
      sup: supervisor({ provider: "omp", modeId: "ask" }),
      req: child({ modeId: "acceptEdits" }),
      expected: refused(["permission:unprompted-writes"]),
    },
    {
      name: "Claude acceptEdits with Claude acceptEdits",
      sup: supervisor({ modeId: "acceptEdits" }),
      req: child({ modeId: "acceptEdits" }),
      expected: allowed("attended", "attended"),
    },
    {
      name: "Claude default with Codex auto is left to the read-scope rule",
      sup: supervisor({ modeId: "default" }),
      req: child({ provider: "codex", modeId: "auto" }),
      expected: refused(["permission:codex-read-scope"]),
    },
    // Never over-credit the supervisor.
    {
      name: "non-authoritative supervisor is unmapped",
      sup: supervisor(),
      req: child(),
      asserted: { supervisorModeAuthoritative: undefined },
      expected: unmapped(["permission:mode-not-authoritative"], []),
    },
    {
      name: "non-authoritative unattended supervisor gets no exception",
      sup: supervisor({ provider: "omp", modeId: "full" }),
      req: child({ provider: "pi", modeId: undefined }),
      asserted: { supervisorModeAuthoritative: false },
      expected: unmapped(["permission:mode-not-authoritative"], ["permission:provider-unmapped"]),
    },
    {
      name: "auto_accept on a provider that ignores it",
      sup: supervisor({ featureValues: { auto_accept: true } }),
      req: child({ modeId: "bypassPermissions" }),
      expected: refused(["permission:exceeds-supervisor"]),
    },
    {
      name: 'auto_accept "false" on the supervisor',
      sup: supervisor({
        provider: "copilot",
        modeId: "allow-all",
        featureValues: { auto_accept: "false" },
      }),
      req: child(),
      expected: unmapped(["feature:invalid-value"], []),
    },
    {
      name: "auto_accept 0 on the supervisor",
      sup: supervisor({
        provider: "opencode",
        modeId: "full-access",
        featureValues: { auto_accept: 0 },
      }),
      req: child(),
      expected: unmapped(["feature:invalid-value"], []),
    },
    {
      name: "stray unattended property on the supervisor",
      sup: { ...supervisor({ modeId: "default" }), unattended: true },
      req: child({ modeId: "bypassPermissions" }),
      expected: refused(["permission:exceeds-supervisor"]),
    },
    {
      name: 'auto_accept "true" on the child',
      sup: supervisor({ modeId: "bypassPermissions" }),
      req: child({
        provider: "opencode",
        modeId: "full-access",
        featureValues: { auto_accept: "true" },
      }),
      expected: exception(["feature:invalid-value"]),
    },
    // Unmapped and the exception.
    {
      name: "provider without modes",
      sup: supervisor(),
      req: child({ provider: "pi", modeId: undefined }),
      expected: unmapped([], ["permission:provider-unmapped"]),
    },
    {
      name: "unresolved row",
      sup: supervisor(),
      req: child({ provider: "copilot", modeId: COPILOT_AGENT }),
      expected: unmapped([], ["permission:mode-unresolved"]),
    },
    {
      name: "runtime mode not in the table",
      sup: supervisor(),
      req: child({ modeId: "dontAsk" }),
      expected: unmapped([], ["permission:mode-unmapped"]),
    },
    {
      name: "absent mode",
      sup: supervisor({ modeId: null }),
      req: child({ provider: "omp", modeId: undefined }),
      expected: unmapped(["permission:mode-absent"], ["permission:mode-absent"]),
    },
    {
      name: "unknown feature",
      sup: supervisor(),
      req: child({ featureValues: { new_feature: true } }),
      expected: unmapped([], ["feature:unmapped"]),
    },
    {
      name: "unmapped child under an authoritative unattended supervisor",
      sup: supervisor({ provider: "omp", modeId: "full" }),
      req: child({ provider: "pi", modeId: undefined }),
      expected: exception(["permission:provider-unmapped"]),
    },
    // Other dimensions.
    {
      name: "chrome under an unattended supervisor",
      sup: supervisor({ modeId: "bypassPermissions" }),
      req: child({ featureValues: { chrome: true } }),
      expected: refused(["feature:owner-only"]),
    },
    {
      name: "container to host",
      sup: supervisor({ environment: CONTAINER }),
      req: child(),
      expected: refused(["environment:container-to-host"]),
    },
    {
      name: "host to container",
      sup: supervisor(),
      req: child({ environment: CONTAINER }),
      expected: refused(["environment:mismatch"]),
    },
    {
      name: "empty environment ids",
      sup: supervisor({ environment: { kind: "host", id: "" } }),
      req: child({ environment: { kind: "host", id: "" } }),
      expected: refused(["environment:missing-id"]),
    },
    {
      name: "descendant directory",
      sup: supervisor(),
      req: child({ directory: "/a/b/c" }),
      expected: allowed("attended", "attended"),
    },
    {
      name: "sibling sharing a prefix",
      sup: supervisor(),
      req: child({ directory: "/a/bc" }),
      expected: refused(["directory:outside-scope"]),
    },
    {
      name: "unresolved ..",
      sup: supervisor(),
      req: child({ directory: "/a/b/../../etc" }),
      expected: refused(["directory:not-canonical"]),
    },
    {
      name: "supervisor scope at /",
      sup: supervisor({ directory: "/" }),
      req: child({ directory: "/etc" }),
      expected: refused(["directory:root-scope"]),
    },
    {
      name: "worktree at /",
      sup: supervisor(),
      req: child({ directory: "/etc" }),
      options: { daemonCreatedWorktrees: ["/"], worktreesRoot: "/w" },
      expected: refused(["directory:root-scope"]),
    },
    {
      name: "worktree without a root",
      sup: supervisor(),
      req: child({ directory: "/w/t" }),
      options: { daemonCreatedWorktrees: ["/w/t"] },
      expected: refused(["directory:worktree-outside-root"]),
    },
    {
      name: "worktree outside its root",
      sup: supervisor(),
      req: child({ directory: "/x/t" }),
      options: { daemonCreatedWorktrees: ["/x/t"], worktreesRoot: "/w" },
      expected: refused(["directory:worktree-outside-root"]),
    },
    {
      name: "daemon-created worktree under its root",
      sup: supervisor(),
      req: child({ directory: "/w/t/sub" }),
      options: { daemonCreatedWorktrees: ["/w/t"], worktreesRoot: "/w" },
      expected: allowed("attended", "attended"),
    },
    {
      name: "tool access change",
      sup: supervisor(),
      req: child({ toolAccess: "clear" }),
      expected: refused(["tool-access:agent-change"]),
    },
    // Wrong input types refuse, never throw.
    { name: "null supervisor", sup: null, req: child(), expected: refused(["input:invalid"]) },
    {
      name: "numeric directory",
      sup: supervisor(),
      req: { ...child(), directory: 7 },
      expected: refused(["input:invalid"]),
    },
    {
      name: "array feature values",
      sup: supervisor(),
      req: { ...child(), featureValues: [true] },
      expected: refused(["input:invalid"]),
    },
    {
      name: "string worktree list",
      sup: supervisor(),
      req: child(),
      options: { daemonCreatedWorktrees: "/w/t" },
      expected: refused(["input:invalid"]),
    },
    {
      name: "unknown environment kind",
      sup: supervisor({ environment: { kind: "vm", id: "x" } as never }),
      req: child(),
      expected: refused(["input:invalid"]),
    },
  ];

  it.each(cases)("$name", ({ sup, req, asserted, options, expected }) => {
    const assertions = asserted === null ? undefined : { ...TRUTHFUL, ...asserted };
    expect(
      compareChildAccess(
        sup as SupervisorAccess,
        req as RequestedChildAccess,
        assertions,
        options as AccessComparisonOptions | undefined,
      ),
    ).toEqual(expected);
  });

  it("refuses non-object assertions", () => {
    expect(compareChildAccess(supervisor(), child(), null as never, {})).toEqual(
      refused(["input:invalid"]),
    );
  });
});
