import { describe, expect, it } from "vitest";

import { deriveAssertions, liveModeId, modeAuthority, type CeilingAgentRecord } from "./admit.js";

function record(overrides: Partial<CeilingAgentRecord> = {}): CeilingAgentRecord {
  const provider = overrides.provider ?? "codex";
  return {
    id: "agent",
    provider,
    cwd: "/work",
    currentModeId: null,
    features: [],
    ...overrides,
    config: { provider, cwd: "/work", ...overrides.config },
  };
}

describe("access ceiling input derivation", () => {
  // One row per way daemon state makes a mode authoritative or not. Assertions never come from
  // tool arguments; every row is built from an agent record alone.
  it.each([
    {
      name: "codex preset applied",
      agent: record({ currentModeId: "auto", config: { modeId: "auto" } as never }),
      live: "auto",
      authority: "authoritative",
    },
    {
      name: "live mode falls back to runtime, then config",
      agent: record({ runtimeInfo: { provider: "codex", modeId: "read-only" } as never }),
      live: "read-only",
      authority: "mode-not-applied",
    },
    {
      name: "codex sandbox override",
      agent: record({
        currentModeId: "read-only",
        config: { modeId: "read-only", providerOptions: { sandbox_mode: "danger-full-access" } },
      } as never),
      live: "read-only",
      authority: "provider-option-override",
    },
    {
      name: "codex approval override",
      agent: record({
        currentModeId: "auto",
        config: { modeId: "auto", providerOptions: { approval_policy: "never" } },
      } as never),
      live: "auto",
      authority: "provider-option-override",
    },
    {
      name: "controller-registered session",
      agent: record({
        currentModeId: "auto",
        config: { modeId: "auto", controllerExecutionId: "execution" },
      } as never),
      live: "auto",
      authority: "controller-governed",
    },
    {
      name: "claude mode with no overrides",
      agent: record({
        provider: "claude",
        currentModeId: "default",
        config: { modeId: "default" },
      } as never),
      live: "default",
      authority: "authoritative",
    },
    {
      name: "claude additional directories",
      agent: record({
        provider: "claude",
        currentModeId: "default",
        config: { modeId: "default", providerOptions: { additionalDirectories: ["/other"] } },
      } as never),
      live: "default",
      authority: "provider-option-override",
    },
    {
      name: "claude preapproved tools",
      agent: record({
        provider: "claude",
        currentModeId: "default",
        config: {
          modeId: "default",
          toolPolicy: { preapproved: [{ server: "paseo", tool: "create_agent" }] },
        },
      } as never),
      live: "default",
      authority: "tool-policy-grants",
    },
    {
      name: "provider changed the mode on its own",
      agent: record({
        provider: "claude",
        currentModeId: "plan",
        config: { modeId: "default" },
      } as never),
      live: "plan",
      authority: "mode-not-applied",
    },
    {
      name: "account id that extends codex",
      agent: record({
        provider: "codex-work",
        currentModeId: "auto",
        config: { modeId: "auto" },
      } as never),
      live: "auto",
      authority: "provider-not-established",
    },
    { name: "no mode at all", agent: record(), live: null, authority: "mode-absent" },
  ])("$name", ({ agent, live, authority }) => {
    expect(liveModeId(agent)).toBe(live);
    expect(modeAuthority(agent)).toBe(authority);
    const asserted = deriveAssertions(agent, agent);
    expect(asserted).toEqual({
      supervisorModeAuthoritative: authority === "authoritative",
      childModeAuthoritative: authority === "authoritative",
      // respond_to_permission accepts any agent and nothing disables project configuration yet.
      childPromptsAnsweredBy: "supervisor",
      childLoadsSupervisorWritableConfig: true,
    });
  });
});
