import {
  AGENT_PROVIDER_DEFINITIONS,
  DEV_AGENT_PROVIDER_DEFINITIONS,
} from "@getpaseo/protocol/provider-manifest";
import { describe, expect, it } from "vitest";
import {
  type AccessDecision,
  type RequestedChildAccess,
  type SupervisorAccess,
  DELIBERATELY_UNMAPPED_PROVIDERS,
  PERMISSION_MODE_TABLE,
  compareChildAccess,
  resolvePermissionLevel,
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

describe("permission table", () => {
  // Every mapped row, so a reviewer can see the level each mode resolves to.
  it.each([
    ["claude", "plan", 0],
    ["claude", "default", 1],
    ["claude", "acceptEdits", 2],
    ["claude", "auto", 3],
    ["claude", "bypassPermissions", 4],
    ["codex", "read-only", 0],
    ["codex", "auto", 2],
    ["codex", "auto-review", 3],
    ["codex", "full-access", 4],
    ["copilot", "allow-all", 4],
    ["copilot", COPILOT_AUTOPILOT, 4],
    ["opencode", "full-access", 4],
    ["omp", "ask", 1],
    ["omp", "full", 4],
  ] as const)("%s %s is level %i", (provider, modeId, level) => {
    expect(resolvePermissionLevel({ provider, modeId })).toEqual({ level });
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
        // A mode the manifest marks unattended can never sit below L4.
        if (mode.isUnattended) expect(row?.level, mode.id).toBe(4);
      }
    }
  });
});

describe("compareChildAccess", () => {
  const cases: Array<[string, SupervisorAccess, RequestedChildAccess, AccessDecision]> = [
    [
      "equal level",
      supervisor(),
      child({ provider: "codex", modeId: "auto" }),
      { kind: "allowed", supervisorLevel: 2, childLevel: 2 },
    ],
    [
      "lower level",
      supervisor({ provider: "codex", modeId: "auto-review" }),
      child({ modeId: "plan" }),
      { kind: "allowed", supervisorLevel: 3, childLevel: 0 },
    ],
    [
      "higher level",
      supervisor({ modeId: "default" }),
      child({ provider: "codex", modeId: "full-access" }),
      { kind: "refused", reasons: ["permission:exceeds-supervisor"] },
    ],
    [
      "auto_accept counts as unattended",
      supervisor({ provider: "codex", modeId: "auto-review" }),
      child({ provider: "opencode", modeId: "full-access", featureValues: { auto_accept: true } }),
      { kind: "refused", reasons: ["permission:exceeds-supervisor"] },
    ],
    [
      "unattended flag counts as unattended",
      supervisor(),
      child({ unattended: true }),
      { kind: "refused", reasons: ["permission:exceeds-supervisor"] },
    ],
    [
      "auto_accept off is neutral",
      supervisor(),
      child({ provider: "copilot", modeId: "allow-all", featureValues: { auto_accept: false } }),
      { kind: "refused", reasons: ["permission:exceeds-supervisor"] },
    ],
    [
      "provider without modes is unmapped",
      supervisor({ modeId: "auto" }),
      child({ provider: "pi", modeId: undefined }),
      { kind: "unmapped", supervisor: [], child: ["permission:provider-unmapped"] },
    ],
    [
      "unresolved row is unmapped",
      supervisor(),
      child({ provider: "copilot", modeId: COPILOT_AGENT }),
      { kind: "unmapped", supervisor: [], child: ["permission:mode-unresolved"] },
    ],
    [
      "runtime mode not in the table is unmapped",
      supervisor(),
      child({ modeId: "dontAsk" }),
      { kind: "unmapped", supervisor: [], child: ["permission:mode-unmapped"] },
    ],
    [
      "absent mode on a provider with modes is unmapped",
      supervisor({ modeId: null }),
      child({ provider: "omp", modeId: undefined }),
      {
        kind: "unmapped",
        supervisor: ["permission:mode-absent"],
        child: ["permission:mode-absent"],
      },
    ],
    [
      "unknown feature is unmapped",
      supervisor(),
      child({ featureValues: { new_feature: true } }),
      { kind: "unmapped", supervisor: [], child: ["feature:unmapped"] },
    ],
    [
      "unmapped child under an unattended supervisor is the distinct exception",
      supervisor({ provider: "omp", modeId: "full" }),
      child({ provider: "pi", modeId: undefined }),
      { kind: "unmapped-under-unattended-supervisor", child: ["permission:provider-unmapped"] },
    ],
    [
      "chrome is refused even for an unattended supervisor",
      supervisor({ modeId: "bypassPermissions" }),
      child({ featureValues: { chrome: true } }),
      { kind: "refused", reasons: ["feature:owner-only"] },
    ],
    [
      "container to host is refused",
      supervisor({ environment: CONTAINER }),
      child({ environment: HOST }),
      { kind: "refused", reasons: ["environment:container-to-host"] },
    ],
    [
      "another container is refused",
      supervisor({ environment: CONTAINER }),
      child({ environment: { kind: "container", id: "other" } }),
      { kind: "refused", reasons: ["environment:mismatch"] },
    ],
    [
      "descendant directory is allowed",
      supervisor(),
      child({ directory: "/a/b/c" }),
      { kind: "allowed", supervisorLevel: 2, childLevel: 2 },
    ],
    [
      "sibling sharing a prefix is refused",
      supervisor(),
      child({ directory: "/a/bc" }),
      { kind: "refused", reasons: ["directory:outside-scope"] },
    ],
    [
      "unresolved .. is refused rather than resolved",
      supervisor(),
      child({ directory: "/a/b/../../etc" }),
      { kind: "refused", reasons: ["directory:not-canonical"] },
    ],
    [
      "tool access change is refused",
      supervisor(),
      child({ toolAccess: "clear" }),
      { kind: "refused", reasons: ["tool-access:agent-change"] },
    ],
  ];

  it.each(cases)("%s", (_name, sup, req, expected) => {
    expect(compareChildAccess(sup, req)).toEqual(expected);
  });

  it("allows a daemon-created worktree outside the supervisor's directory", () => {
    const request = child({ directory: "/w/task-1" });
    expect(compareChildAccess(supervisor(), request).kind).toBe("refused");
    expect(
      compareChildAccess(supervisor(), request, { daemonCreatedWorktrees: ["/w/task-1"] }),
    ).toEqual({ kind: "allowed", supervisorLevel: 2, childLevel: 2 });
  });
});
