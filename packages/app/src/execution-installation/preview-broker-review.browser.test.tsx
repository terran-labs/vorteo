import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrokerReviewJob } from "./preview-broker-review";
import { brokerDeploymentReviewFixture } from "./preview-broker-review.fixture";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { PreviewBrokerJob } from "@getpaseo/protocol/preview-broker-maintenance";
import { InstallationPanelModel } from "./panel-model";
import { brokerReviewFixture } from "./preview-broker-review.fixture";
import { InstallationControls, InstallationSystemDetails } from "./panel";

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => {
    throw new Error("Clipboard is outside broker review");
  }),
}));

const capture = vi.hoisted(() => ({
  model: undefined as InstallationPanelModel | undefined,
}));
vi.mock("./panel-model", async (original) => {
  const actual = await original<typeof import("./panel-model")>();
  return {
    ...actual,
    InstallationPanelModel: class extends actual.InstallationPanelModel {
      constructor(...args: ConstructorParameters<typeof actual.InstallationPanelModel>) {
        super(...args);
        capture.model = this;
      }
    },
  };
});
vi.mock("./client", () => ({
  InstallationClient: function InstallationClientFixture() {
    return client;
  },
  OwnerAccessExpired: class extends Error {},
  hasInstallationConnections: () => true,
  requestInstallationOwner: () => {
    throw new Error("Unexpected owner transport");
  },
}));
vi.mock("./policy", () => ({
  readExecutionInstallation: () => ({ environments: [] }),
  installationHasDev: () => false,
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getHosts: () => [] }),
  useHostRegistryLoaded: () => true,
}));
vi.mock("expo-router", () => ({
  // The panel's plugin navigation imports these; a missing mock export hangs browser mode.
  router: { push: vi.fn(), replace: vi.fn(), navigate: vi.fn() },
  usePathname: () => "/settings/general",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
}));
vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => false),
}));

// Supply the native absolute-fill constant omitted by the shared style stub,
// so the disabled-action explanation overlay has its production hit rectangle.
vi.mock("react-native-unistyles", async (original) => {
  const actual = await original<typeof import("react-native-unistyles")>();
  return {
    ...actual,
    StyleSheet: {
      ...actual.StyleSheet,
      absoluteFillObject: {
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      },
    },
  };
});

const reviewJob: PreviewBrokerJob = {
  ...brokerReviewFixture,
  reason: "Bind both preview channels to the reviewed APFS volume identity.",
};
let current: BrokerReviewJob = reviewJob;
const forbidden = () => {
  throw new Error("No owner decisions or login in this fixture");
};
const client: ConstructorParameters<typeof InstallationPanelModel>[0] = {
  passwordFile: null,
  sessionsSupported: true,
  restoreSession: vi.fn(async () => true),
  unlock: vi.fn(forbidden),
  lock: vi.fn(async () => {}),
  restartSummary: vi.fn(async () => null),
  listRestarts: vi.fn(async () => []),
  listHelpers: vi.fn(async () => []),
  listBrokers: vi.fn(async () => (current.target === "preview-broker" ? [current] : [])),
  listBrokerDeployments: vi.fn(async () =>
    current.target === "preview-broker-deployment" ? [current] : [],
  ),
  decideBrokerDeployment: vi.fn(async (job, action) => ({
    ...job,
    status: action === "cancel" ? ("rejected" as const) : ("approved" as const),
  })),
  profileSharingStatus: vi.fn(async () => null),
  resolveProfileConflict: vi.fn(forbidden),
  decide: vi.fn(forbidden),
  decideHelper: vi.fn(forbidden),
  decideBroker: vi.fn(forbidden),
};

function assertUnclipped(card: HTMLElement, width: number) {
  const bounds = card.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  // Text ranges expose clipped long digests even when the containing card fits.
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) {
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top - 1);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    }
  }
  for (const button of card.querySelectorAll<HTMLElement>('[role="button"]')) {
    expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(width === 390 ? 44 : 32);
  }
}

test("production broker review preserves exact evidence and manual gates at desktop and 390px", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  container.style.cssText = "max-width:720px;margin:0 auto;padding:16px;box-sizing:border-box";
  document.body.style.margin = "0";
  document.body.append(container);
  const root = createRoot(container);
  const render = (width: number) =>
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <InstallationControls key={width} />
          <InstallationSystemDetails target="host" />
        </QueryClientProvider>,
      ),
    );
  const button = (action: string) =>
    container.querySelector<HTMLElement>(`[data-testid="broker-${current.id}-${action}"]`);
  try {
    for (const width of [1280, 390]) {
      await page.viewport(width, 900);
      expect(window.innerWidth).toBe(width);
      render(width);
      expect(container.querySelector('[data-testid="owner-lock-badge"]')?.textContent).toContain(
        "Checking",
      );
      expect(button("approve")).toBeNull();
      expect(button("cancel")).toBeNull();
      await page.screenshot({
        path: `../../../../output/playwright/broker-${width}-checking.png`,
        fullPage: true,
      });
    }
    const model = capture.model!;
    await act(() => model.initialize());
    for (const width of [1280, 390]) {
      await page.viewport(width, 900);
      expect(window.innerWidth).toBe(width);
      render(width);
      for (const [status, stage] of [
        ["pending", "preparing"],
        ["pending", "prepared"],
        ["approved", "prepared"],
        ["running", "dispatch_pending"],
        ["failed", "recovery_required"],
      ] as const) {
        current = { ...reviewJob, status, stage };
        await act(() => model.refresh());
        const details = page.getByRole("button", {
          name: "Details",
          exact: true,
        });
        if (!container.textContent?.includes(`After: ${current.plan.brokers[0].candidateSha256}`)) {
          await act(async () => {
            await details.click();
          });
        }
        const card = container.querySelector<HTMLElement>(
          `[data-testid="broker-request-${current.id}"]`,
        )!;
        expect(card.checkVisibility()).toBe(true);
        await expect.element(page.getByText(current.reason, { exact: true })).toBeVisible();
        for (const value of [
          current.reason,
          current.detail,
          `Source: ${current.plan.sourceCommit}`,
          `After: ${current.plan.brokers[0].candidateSha256}`,
          `Before: ${current.plan.brokers[0].expectedSha256}`,
          `APFS volume: ${current.plan.brokers[0].anchor.volumeUUID}`,
          `Plan: ${current.planSha256}`,
          `Evidence and backups: ${current.plan.evidenceDirectory}`,
        ]) {
          expect(card.textContent).toContain(value);
        }
        if (status === "pending" || status === "approved") {
          expect(button("approve")).not.toBeNull();
          expect(button("cancel")).not.toBeNull();
          expect(button("cancel")?.getAttribute("aria-disabled")).not.toBe("true");
          expect(button("approve")?.getAttribute("aria-disabled") === "true").toBe(
            status !== "pending" || stage !== "prepared",
          );
        } else {
          expect(button("approve")).toBeNull();
          expect(button("cancel")).toBeNull();
        }
        if (stage === "recovery_required") {
          expect(card.textContent).toContain("Never replay or roll back automatically.");
          expect(card.textContent).toContain("Needs inspection");
        }
        await page.screenshot({
          path: `../../../../output/playwright/broker-${width}-${status}-${stage}.png`,
          fullPage: true,
        });
        assertUnclipped(card, width);
      }
    }
    const systemDetails = container.querySelector<HTMLElement>(
      '[data-testid="system-installation-details-host"]',
    )!;
    const heightBeforeError = systemDetails.getBoundingClientRect().height;
    await act(() => model.decideBroker({ ...current, revision: current.revision + 1 }, "approve"));
    const helperError = model.getState().helperError!;
    expect(helperError).toContain("request changed");
    await expect.element(page.getByText(helperError, { exact: true })).toBeVisible();
    expect(systemDetails.textContent).toContain(helperError);
    expect(systemDetails.getBoundingClientRect().height).toBe(heightBeforeError);
    await act(() => model.lock());
    for (const width of [1280, 390]) {
      await page.viewport(width, 900);
      expect(window.innerWidth).toBe(width);
      render(width);
      expect(container.querySelector('[data-testid="owner-lock-badge"]')?.textContent).toContain(
        "Locked",
      );
      expect(container.querySelector('[data-testid^="broker-request-"]')).toBeNull();
      expect(button("approve")).toBeNull();
      expect(button("cancel")).toBeNull();
      await page.screenshot({
        path: `../../../../output/playwright/broker-${width}-locked.png`,
        fullPage: true,
      });
    }
    for (const method of [client.unlock, client.decide, client.decideHelper, client.decideBroker]) {
      expect(method).not.toHaveBeenCalled();
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}, 30_000);

test("broker decision errors remain visible and confirmed results replace the card", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  current = { ...reviewJob };
  await page.viewport(390, 900);
  const container = document.createElement("div");
  container.style.cssText = "max-width:720px;margin:0 auto;padding:16px;box-sizing:border-box";
  document.body.append(container);
  const root = createRoot(container);
  let calls = 0;
  client.unlock = vi.fn(async () => {});
  client.decideBroker = async () => {
    calls++;
    throw new Error("Broker decision could not be confirmed");
  };
  try {
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <InstallationControls />
          <InstallationSystemDetails target="host" />
        </QueryClientProvider>,
      ),
    );
    await act(() => capture.model!.initialize());
    // The panel singleton deliberately survives unmount and the prior case locked it.
    await act(() => capture.model!.unlock());
    await page.getByTestId(`broker-${current.id}-approve`).click();
    await expect
      .element(page.getByText("Broker decision could not be confirmed", { exact: true }))
      .toBeVisible();
    expect(calls).toBe(1);
    expect(current.status).toBe("pending");
    client.decideBroker = async (job) => {
      calls++;
      current = { ...job, status: "succeeded", stage: "succeeded" };
      return current;
    };
    await page.getByTestId(`broker-${current.id}-approve`).click();
    await expect
      .element(
        page.getByText(
          "Both broker configs are verified. Service availability still requires acceptance.",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(calls).toBe(2);
    expect(container.querySelector(`[data-testid="broker-${current.id}-approve"]`)).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    client.decideBroker = vi.fn(forbidden);
    client.unlock = vi.fn(forbidden);
    current = reviewJob;
    vi.unstubAllGlobals();
  }
});

test("consumer deployment uses its separate exact decision and retains uncertainty", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  current = brokerDeploymentReviewFixture;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await page.viewport(390, 900);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <InstallationControls />
          <InstallationSystemDetails target="host" />
        </QueryClientProvider>,
      ),
    );
    await act(() => capture.model!.refresh());
    await expect
      .element(page.getByRole("button", { name: "Approve consumer deployment", exact: true }))
      .toBeVisible();
    const retained = current;
    await page.getByRole("button", { name: "Approve consumer deployment", exact: true }).click();
    expect(client.decideBrokerDeployment).toHaveBeenCalledWith(retained, "approve");
    expect(client.decideBroker).not.toHaveBeenCalled();
    current = { ...brokerDeploymentReviewFixture, status: "failed", stage: "recovery_required" };
    await act(() => capture.model!.refresh());
    expect(container.textContent).toContain("Needs inspection");
    expect(container.querySelector('[data-testid$="-approve"]')).toBeNull();
    expect(container.querySelector('[data-testid$="-cancel"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    current = reviewJob;
  }
});
