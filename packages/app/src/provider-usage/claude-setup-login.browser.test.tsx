import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { ProviderLoginPanel } from "./login-panel";
import {
  useClaudeSignInUpgradeAvailable,
  useProviderLogin,
  useSharedInstallationSignIn,
} from "./use-provider-login";
vi.mock("@/execution-installation/panel", () => ({
  PasswordFileHint: () => null,
  useInstallationOwnerAccess: () => ({
    status: "none",
    busy: false,
    error: null,
    unlock: vi.fn(),
    lock: vi.fn(),
  }),
}));
vi.mock("@/utils/copy-to-clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("./use-provider-login", () => ({
  useProviderLogin: vi.fn(),
  useSharedInstallationSignIn: vi.fn(),
  useClaudeSignInUpgradeAvailable: vi.fn(),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        host: {
          serverInfo: {
            features: { providerAccountLogin: true, claudeAccountCreation: true },
            permissions: ["daemon.manage"],
          },
        },
      },
    }),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  await page.viewport(1280, 800);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.resetAllMocks();
});

test("shared success shows pending delivery and allows renewal or installation-wide disconnect", async () => {
  const start = vi.fn();
  const signOut = vi.fn();
  vi.mocked(useProviderLogin).mockReturnValue({
    state: {
      status: "succeeded",
      attemptId: "11111111-1111-4111-8111-111111111111",
      accountLabel: null,
    },
    shared: true,
    sharedClaude: true,
    synchronization: {
      connected: true,
      environments: [
        { serverId: "host", status: "ready" },
        { serverId: "dev", status: "pending" },
      ],
    },
    connected: true,
    busy: false,
    actionPending: false,
    readFailed: false,
    actionFailed: false,
    refreshing: false,
    start,
    signOut,
    cancel: vi.fn(),
    submitCode: vi.fn(),
    refresh: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ProviderLoginPanel
        serverId="host"
        providerId="claude-one"
        name="Claude"
        provider="claude"
      />,
    ),
  );
  expect(container.textContent).toContain("Connect Claude once");
  expect(container.textContent).toContain("Synchronization is pending");
  expect(container.textContent).not.toContain("Signed in as");
  await page.getByRole("button", { name: "Reconnect Claude subscription" }).click();
  expect(start).toHaveBeenCalledOnce();
  await page
    .getByRole("button", { name: "Disconnect subscription from this installation" })
    .click();
  expect(signOut).toHaveBeenCalledOnce();
  expect(vi.mocked(useProviderLogin)).toHaveBeenCalledWith("host", "claude-one", "claude");
});

test("a shared Codex account connects once and shows Dev synchronization", async () => {
  const start = vi.fn();
  // Opened from Dev, whose daemon session is not loaded here: the coordinator handles it.
  vi.mocked(useSharedInstallationSignIn).mockReturnValue(true);
  vi.mocked(useProviderLogin).mockReturnValue({
    state: { status: "idle" },
    shared: true,
    sharedClaude: false,
    synchronization: {
      connected: true,
      accountLabel: "owner@example.com",
      environments: [{ serverId: "dev", status: "ready" }],
    },
    connected: true,
    busy: false,
    actionPending: false,
    readFailed: false,
    actionFailed: false,
    refreshing: false,
    start,
    signOut: vi.fn(),
    cancel: vi.fn(),
    submitCode: vi.fn(),
    refresh: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ProviderLoginPanel serverId="dev" providerId="codex-one" name="Pro" provider="codex" />,
    ),
  );
  expect(container.textContent).toContain("Connect Codex once");
  expect(container.textContent).toContain("Connected and ready. Signed in as owner@example.com.");
  expect(container.textContent).not.toContain("for this environment");
  await page.getByRole("button", { name: "Connect Codex" }).click();
  expect(start).toHaveBeenCalledOnce();
  expect(vi.mocked(useProviderLogin)).toHaveBeenCalledWith("dev", "codex-one", "codex");
});

type Login = ReturnType<typeof useProviderLogin>;
function sharedClaudeLogin(state: Login["state"], overrides: Partial<Login> = {}): Login {
  return {
    state,
    shared: true,
    sharedClaude: true,
    synchronization: {
      connected: true,
      environments: [
        { serverId: "host", status: "ready" },
        { serverId: "dev", status: "ready" },
      ],
    },
    connected: true,
    busy: false,
    actionPending: false,
    readFailed: false,
    actionFailed: false,
    refreshing: false,
    start: vi.fn(),
    signOut: vi.fn(),
    cancel: vi.fn(),
    submitCode: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}
function renderClaudePanel(connect: Login, upgrade: Login) {
  vi.mocked(useProviderLogin).mockImplementation((_serverId, _providerId, _provider, flow) =>
    flow === "upgrade" ? upgrade : connect,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ProviderLoginPanel
        serverId="host"
        providerId="claude-one"
        name="Claude 1"
        provider="claude"
      />,
    ),
  );
}
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
function buttonLabels(): string[] {
  return [...container.querySelectorAll('button, [role="button"]')].map(
    (button) => button.textContent ?? "",
  );
}

test("a setup-token Claude account offers the upgrade to full sign-in when available", async () => {
  vi.mocked(useClaudeSignInUpgradeAvailable).mockReturnValue(true);
  const upgrade = sharedClaudeLogin({ status: "idle" });
  renderClaudePanel(sharedClaudeLogin({ status: "idle" }), upgrade);
  expect(container.textContent).toContain("Shows your usage and keeps this account's history.");
  await page.getByRole("button", { name: "Upgrade to full sign-in" }).click();
  expect(upgrade.start).toHaveBeenCalledOnce();
  expect(vi.mocked(useProviderLogin)).toHaveBeenCalledWith(
    "host",
    "claude-one",
    "claude",
    "upgrade",
  );
});

test("the upgrade is hidden when the installation cannot perform it", () => {
  vi.mocked(useClaudeSignInUpgradeAvailable).mockReturnValue(false);
  renderClaudePanel(sharedClaudeLogin({ status: "idle" }), sharedClaudeLogin({ status: "idle" }));
  expect(container.textContent).not.toContain("Upgrade to full sign-in");
  expect(vi.mocked(useProviderLogin)).not.toHaveBeenCalledWith(
    "host",
    "claude-one",
    "claude",
    "upgrade",
  );
});

test("a refused upgrade explains that the setup token still works and allows a retry", async () => {
  vi.mocked(useClaudeSignInUpgradeAvailable).mockReturnValue(true);
  const upgrade = sharedClaudeLogin({
    status: "failed",
    attemptId: ATTEMPT,
    message:
      "This account belongs to owner@example.com, but Claude signed in as other@example.com.",
  });
  renderClaudePanel(sharedClaudeLogin({ status: "idle" }), upgrade);
  expect(container.textContent).toContain("signed in as other@example.com.");
  expect(container.textContent).toContain("Your setup token still works.");
  // The setup-token controls stay available after a failed upgrade.
  await expect.poll(buttonLabels).toContain("Connect Claude");
  await page.getByRole("button", { name: "Try the upgrade again" }).click();
  expect(upgrade.start).toHaveBeenCalledOnce();
});

test("an upgrade in progress replaces the setup-token action and can be cancelled", async () => {
  vi.mocked(useClaudeSignInUpgradeAvailable).mockReturnValue(true);
  const connect = sharedClaudeLogin({ status: "idle" });
  const upgrade = sharedClaudeLogin({ status: "verifying", attemptId: ATTEMPT });
  renderClaudePanel(connect, upgrade);
  expect(container.textContent).toContain("switching it to full sign-in");
  await expect.poll(buttonLabels).not.toContain("Connect Claude");
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  expect(upgrade.cancel).toHaveBeenCalledOnce();
  expect(connect.start).not.toHaveBeenCalled();
});

test("a completed upgrade keeps reporting success after the account switches type", () => {
  vi.mocked(useClaudeSignInUpgradeAvailable).mockReturnValue(true);
  const connect = sharedClaudeLogin({ status: "idle" });
  const upgrade = sharedClaudeLogin({
    status: "succeeded",
    attemptId: ATTEMPT,
    accountLabel: null,
  });
  renderClaudePanel(connect, upgrade);
  expect(container.textContent).toContain("Upgraded to full sign-in.");
  // The definition is now full sign-in, so the coordinator no longer offers the upgrade.
  vi.mocked(useClaudeSignInUpgradeAvailable).mockReturnValue(false);
  act(() =>
    root.render(
      <ProviderLoginPanel
        serverId="host"
        providerId="claude-one"
        name="Claude 1"
        provider="claude"
      />,
    ),
  );
  expect(container.textContent).toContain("now reports usage");
  expect(container.textContent).not.toContain("Try the upgrade again");
});
