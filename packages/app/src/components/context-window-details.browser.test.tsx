import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsageView } from "@/usage/model";

const state = vi.hoisted(() => ({
  accountUsage: { kind: "none" } as AgentUsageView,
  planLoading: true,
}));

vi.mock("@/usage", () => ({
  useAgentUsage: () => state.accountUsage,
  AgentUsageSection: () => <div data-testid="agent-account-usage" />,
}));
vi.mock("@/provider-usage/use-provider-usage", () => ({
  useProviderUsage: () => ({
    view: state.planLoading
      ? { kind: "loading" }
      : { kind: "ready", payload: { providers: [] }, isRefreshing: false },
  }),
}));
vi.mock("@/provider-usage/tooltip-section", () => ({
  ProviderUsageTooltipSection: () => <div data-testid="provider-plan-usage" />,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (value: unknown) => unknown) => select({ sessions: {} }),
}));
vi.mock("./context-breakdown/use-context-breakdown", () => ({
  useContextBreakdown: () => ({ kind: "totals" }),
}));
vi.mock("./context-breakdown/view", () => ({
  ContextBreakdown: ({ loading }: { loading: boolean }) => (
    <div data-testid="context-breakdown" data-loading={String(loading)} />
  ),
}));

const { ContextWindowDetails } = await import("./context-window-details");

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let mounted: { root: Root; container: HTMLElement } | null = null;
afterEach(() => {
  if (mounted) {
    const { root, container } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  vi.unstubAllGlobals();
});

function render(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ContextWindowDetails
        serverId="server"
        agentId="agent"
        percentage={4}
        usedTokens={40_000}
        maxTokens={1_000_000}
        sessionCost={null}
        showTitle={false}
        refreshable
      />,
    ),
  );
  mounted = { root, container };
  return container;
}

describe("ContextWindowDetails", () => {
  it("shows only the agent's own account when the host reports it", () => {
    state.accountUsage = { kind: "ready", reports: [] };
    state.planLoading = true;
    const container = render();
    expect(container.querySelector('[data-testid="agent-account-usage"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="provider-plan-usage"]')).toBeNull();
    // Plan usage is not shown, so its loading must not hold the details back.
    expect(
      container.querySelector('[data-testid="context-breakdown"]')?.getAttribute("data-loading"),
    ).toBe("false");
  });

  it("falls back to plan usage when the host reports no account for the agent", () => {
    state.accountUsage = { kind: "none" };
    state.planLoading = false;
    const container = render();
    expect(container.querySelector('[data-testid="provider-plan-usage"]')).not.toBeNull();
  });
});
