import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { usePanelStore } from "@/stores/panel-store";
import { QuotaAccountList } from "./quota-account-list";
import { QuotaFooter } from "./quota-footer";
import { quotaAccounts } from "./global-quota";
import type { ProviderUsage, ProviderUsageView } from "./types";

// Browser-only navigation boundary; the actual usage components and stores run unchanged.
vi.mock("expo-router", () => ({
  router: { push: vi.fn(), replace: vi.fn() },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useLocalSearchParams: () => ({}),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let cache: QueryClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  cache?.clear();
  usePanelStore.setState({ quotaAccountExpanded: {} });
  vi.unstubAllGlobals();
});

const now = Date.now();
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const fetchedAt = at(-2);

// The daemon fills remainingPct from usedPct for every window, so fixtures carry both.
const providers: ProviderUsage[] = [
  {
    providerId: "codex-2",
    displayName: "Codex 2",
    status: "available",
    planLabel: "Pro",
    sourceLabel: "ChatGPT sign-in",
    fetchedAt,
    windows: [
      {
        id: "session",
        label: "5-hour",
        usedPct: 94,
        remainingPct: 6,
        resetsAt: at(107),
        runsOutAt: at(38),
        shortfallPct: 40,
      },
      { id: "weekly", label: "Weekly", usedPct: 71, remainingPct: 29, resetsAt: at(57 * 60) },
      {
        id: "code_review",
        label: "Code review",
        usedPct: 12,
        remainingPct: 88,
        resetsAt: at(57 * 60),
      },
    ],
    balances: [{ id: "credits", label: "Credits", remaining: 0, unit: "credits" }],
  },
  {
    providerId: "codex-3",
    displayName: "Codex 3 (Christian)",
    status: "unavailable",
    authRecovery: { instructions: "Sign in again." },
    planLabel: "Plus",
    fetchedAt: at(-200),
    windows: [
      { id: "session", label: "5-hour", usedPct: 40, remainingPct: 60, resetsAt: at(-20) },
      { id: "weekly", label: "Weekly", usedPct: 22, remainingPct: 78, resetsAt: at(122 * 60) },
    ],
  },
  {
    providerId: "claude-1",
    displayName: "Claude 1",
    status: "available",
    planLabel: "Max 20x",
    fetchedAt,
    windows: [
      { id: "five_hour", label: "Session", usedPct: 23, remainingPct: 77, resetsAt: at(243) },
      { id: "weekly", label: "Weekly", usedPct: 48, remainingPct: 52, resetsAt: at(43 * 60) },
      {
        id: "weekly_model_opus",
        label: "Weekly · Opus",
        usedPct: 64,
        remainingPct: 36,
        resetsAt: at(43 * 60),
      },
    ],
    details: [{ id: "extra_usage", label: "Extra usage", value: "Enabled" }],
  },
  {
    providerId: "claude-4",
    displayName: "Claude 4",
    status: "available",
    planLabel: null,
    fetchedAt,
    windows: [{ id: "weekly", label: "Weekly", remainingPct: 0, resetsAt: at(9 * 60) }],
    details: [
      { id: "claude-setup-token", label: "Sign-in", value: "Setup token" },
      { id: "claude-limit-observation", label: "Source", value: "From last limit message" },
    ],
  },
];

const view: ProviderUsageView = {
  kind: "ready",
  isRefreshing: false,
  payload: {
    requestId: "fixture",
    fetchedAt,
    providers,
    workerActivity: { checkedAt: fetchedAt, runningByProvider: { "codex-2": 3, "claude-1": 4 } },
  },
};

const surface: React.CSSProperties = {
  background: "#18181b",
  color: "white",
  width: 288,
  padding: 8,
  boxSizing: "border-box",
};

async function render(width: number) {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(width, 1000);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={cache!}>
        <div style={surface}>
          <QuotaAccountList
            accounts={quotaAccounts(view, now)}
            serverId={null}
            view={view}
            now={now}
          />
          <QuotaFooter view={view} onOpenUsage={vi.fn()} />
        </div>
      </QueryClientProvider>,
    );
  });
}

for (const width of [390]) {
  test(`quota accounts show runway lanes that expand into every window at ${width}px`, async () => {
    await render(width);
    // The healthiest account leads, with the runner-up beneath it.
    await expect.element(page.getByTestId("global-quota-best")).toBeVisible();
    expect(page.getByTestId("global-quota-best").element().textContent).toContain("Claude 1");
    expect(page.getByTestId("global-quota-best-then").element().textContent).toContain("Codex 2");

    // Every account is one lane and one summary line until opened.
    for (const id of ["codex-2", "codex-3", "claude-1"]) {
      await expect.element(page.getByTestId(`global-quota-lane-${id}`)).toBeVisible();
      await expect.element(page.getByTestId(`global-quota-summary-${id}`)).toBeVisible();
    }
    await expect.element(page.getByTestId("global-quota-lane-codex-2-low")).toBeVisible();
    expect(
      container!.querySelectorAll('[data-testid="global-quota-lane-codex-2-reset"]').length,
    ).toBe(2);
    expect(page.getByTestId("global-quota-summary-codex-2").element().textContent).toMatch(
      /^6% left · resets /,
    );
    expect(page.getByTestId("global-quota-window-codex-2-weekly").query()).toBeNull();
    expect(container!.querySelectorAll('[role="progressbar"]').length).toBe(0);

    // A disconnected account keeps its Reconnect control visible while collapsed.
    const signIn = page.getByTestId("global-quota-account-codex-3");
    expect(signIn.element().textContent).toContain("Reconnect");
    expect(page.getByTestId("global-quota-summary-codex-3").element().textContent).toBe(
      "Account disconnected",
    );

    // Opening an account shows one bar per window with absolute resets and the pace warning.
    await page.getByTestId("global-quota-toggle-codex-2").click();
    for (const id of ["session", "weekly", "code_review"]) {
      await expect.element(page.getByTestId(`global-quota-window-codex-2-${id}`)).toBeVisible();
    }
    await expect.element(page.getByTestId("global-quota-pace-codex-2-session")).toBeVisible();
    expect(
      page.getByTestId("global-quota-window-codex-2-code_review").element().textContent,
    ).toContain("separate");
    expect(page.getByTestId("global-quota-detail-codex-2").element().textContent).toContain("Pro");
    expect(usePanelStore.getState().quotaAccountExpanded["codex-2"]).toBe(true);
    // Every reset names its zone: "Resets Thu Oct 22, 5:29 AM PDT · 1h 47m".
    const resets = [...container!.querySelectorAll("div, span")]
      .map((node) => node.textContent ?? "")
      .filter((text) => /^Resets \w{3} \w{3} \d{1,2}, \d{1,2}:\d{2}/.test(text));
    expect(resets.length).toBeGreaterThan(0);

    await page.getByTestId("global-quota-toggle-codex-3").click();
    await expect.element(page.getByText("Account disconnected.", { exact: false })).toBeVisible();
    expect(container!.textContent).not.toContain("Usage unavailable");

    // An observed limit is out until its reset, then unknown, and says where it came from.
    await expect.element(page.getByTestId("global-quota-lane-claude-4-out")).toBeVisible();
    await expect
      .element(page.getByTestId("global-quota-lane-claude-4-unknown"))
      .toBeInTheDocument();
    expect(page.getByTestId("global-quota-label-claude-4").element().textContent).toBe("Out");
    await page.getByTestId("global-quota-toggle-claude-4").click();
    await expect
      .element(page.getByTestId("global-quota-observed-claude-4"))
      .toHaveTextContent("From last limit message");
    expect(
      page
        .getByTestId("global-quota-detail-claude-4")
        .element()
        .textContent?.match(/From last limit message/g),
    ).toHaveLength(1);

    // The key explains the lanes and names the time zone.
    expect(page.getByTestId("global-quota-key").query()).toBeNull();
    await page.getByTestId("global-quota-key-toggle").click();
    await expect.element(page.getByTestId("global-quota-key")).toBeVisible();
    expect(page.getByTestId("global-quota-key").element().textContent).toContain("Times in ");
    expect(page.getByTestId("global-quota-freshness").element().textContent).toBe("Live · 2m ago");

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `.vitest-screenshots/global-quota-card-${width}.png` });
  });
}
