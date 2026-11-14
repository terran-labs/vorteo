// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
const state = vi.hoisted(() => ({
  serverId: "host" as string | undefined,
  installation: {} as object | null,
  data: undefined as object | undefined,
  error: null as Error | null,
  isLoading: false,
  primary: { loaded: false, supported: false, primary: undefined as object | null | undefined },
  standalone: { loaded: false, supported: false, primary: undefined as object | null | undefined },
  availability: "available" as string,
  hosts: [] as { serverId: string }[],
  system: null as object | null,
  owner: "none" as string,
  providerItems: [] as object[],
}));
vi.mock("@/components/settings", () => ({
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/constants/platform", () => ({ isWeb: false }));
vi.mock("@/hooks/use-daemon-primary-connection", () => ({
  useDaemonPrimaryConnection: () => state.standalone,
}));
vi.mock("@/provider-usage/use-provider-usage", () => ({
  useProviderUsage: () => ({ view: { kind: "loading" } }),
}));
vi.mock("@/execution-installation/primary-connection", () => ({
  primaryConnectionAvailability: () => state.availability,
  usePrimaryConnection: () => state.primary,
}));
vi.mock("@/execution-installation/panel", () => ({
  useInstallationSystemModel: () =>
    state.system ? { subscribe: () => () => {}, getState: () => state.system } : null,
  useInstallationOwnerClient: () => null,
}));
vi.mock("@/execution-installation/owner-access", () => ({
  useOwnerAccess: () => ({ status: state.owner }),
}));
vi.mock("@/components/settings/owner-lock", () => ({ OwnerUnlockDialog: () => null }));
vi.mock("@/execution-installation/use-installation-upgrades", () => ({
  useInstallationUpgradeStatus: () => ({ data: null }),
}));
vi.mock("@/screens/factory/overview-sources", () => ({ useFactoryServerIds: () => new Set() }));
vi.mock("@/execution-installation/policy", () => ({
  installationDefaultServerId: () => state.serverId,
  readExecutionInstallation: () => state.installation,
}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: undefined, isLoading: state.isLoading, error: null }),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHosts: () => state.hosts }));
vi.mock("@/vorton-updates/use-update", () => ({ useVortonUpdate: () => ({}) }));
vi.mock("@/execution-installation/settings", () => ({ useInstallationSettings: () => state }));
vi.mock("@/screens/settings/shared-providers-model", () => ({
  providersNeedingAttention: () => state.providerItems,
}));
vi.mock("@/screens/settings/use-provider-detection", () => ({ useProviderDetection: () => [] }));
import { SystemHealthSection } from "./attention-section";
import { act, render as mount, cleanup } from "@testing-library/react";
import { systemHealthItems } from "../system/health-model";
import { healthExtrasCount, useHealthExtrasCount } from "../system/health-extras";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
beforeEach(() => {
  state.serverId = "host";
  state.installation = {};
  state.data = undefined;
  state.error = null;
  state.isLoading = false;
  state.primary = { loaded: false, supported: false, primary: undefined };
  state.standalone = { loaded: false, supported: false, primary: undefined };
  state.availability = "available";
  state.hosts = [];
  state.system = null;
  state.owner = "none";
  state.providerItems = [];
});
const onFix = vi.fn();
const queryClient = new QueryClient();
const withClient = (node: ReactNode) => (
  <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
);
const render = () => renderToStaticMarkup(withClient(<SystemHealthSection onFix={onFix} />));
/** Which Health rows show, by test ID, so the tests do not depend on wording. */
const rows = (html: string) =>
  [...html.matchAll(/data-testid="settings-attention-([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id) => !id.endsWith("-fix"));
it("waits for the first enabled settings answer", () => {
  expect(rows(render())).toEqual(["checking"]);
});
it.each([
  ["the installation query is disabled", () => (state.installation = null)],
  ["the first settings fetch fails", () => (state.error = new Error("offline"))],
  ["there is no host, even before settings load", () => (state.serverId = undefined)],
])("answers when %s", (_case, arrange) => {
  arrange();
  expect(rows(render())).toEqual(["clear"]);
});
it("asks for a primary connection once shared settings load without one", () => {
  state.installation = null;
  state.primary = { loaded: true, supported: true, primary: null };
  expect(rows(render())).toEqual(["primary-connection"]);
  state.primary = { loaded: true, supported: true, primary: { providerId: "claude" } };
  expect(rows(render())).toEqual(["clear"]);
  // Not loaded yet, or unsupported: never asks.
  state.primary = { loaded: false, supported: false, primary: undefined };
  expect(rows(render())).toEqual(["clear"]);
});
it("asks for another primary connection when the chosen one cannot run anywhere", () => {
  state.installation = null;
  state.primary = { loaded: true, supported: true, primary: { providerId: "claude" } };
  state.availability = "unavailable";
  expect(rows(render())).toEqual(["primary-connection"]);
  // Still checking: say nothing rather than flicker.
  state.availability = "unknown";
  expect(rows(render())).toEqual(["clear"]);
});
it("asks a standalone daemon's owner the same way", () => {
  state.installation = null;
  state.hosts = [{ serverId: "local" }];
  state.standalone = { loaded: true, supported: true, primary: null };
  expect(rows(render())).toEqual(["primary-connection"]);
});
it("itemizes installation problems, one row per kind", () => {
  state.installation = null;
  state.system = {
    unlocked: true,
    pendingJobs: [{ id: "r1" }],
    jobs: [{ id: "r1", status: "pending", target: "host", createdAt: "2026-11-10T00:00:00Z" }],
    helperJobs: [{ status: "failed" }],
    brokerJobs: [],
    monitorJobs: [],
    enrollmentStatus: { activation: "verified", services: [] },
  };
  expect(rows(render())).toEqual(["restarts", "helper"]);
});
it("gives the System button the Health list's row count, and drops stale rows", () => {
  state.installation = null;
  state.data = {};
  state.providerItems = [
    { provider: "claude", label: "Claude" },
    { provider: "codex", label: "Codex" },
  ];
  state.system = {
    unlocked: true,
    pendingJobs: [{ id: "r1" }, { id: "r2" }],
    jobs: [
      { id: "r1", status: "pending", target: "host", createdAt: "2026-11-10T00:00:00Z" },
      { id: "r2", status: "pending", target: "container-daemon", createdAt: "2026-11-10" },
    ],
    helperJobs: [],
    brokerJobs: [],
    monitorJobs: [],
  };
  queryClient.setQueryData(["providersSnapshot", "host"], { entries: ["claude", "codex"] });
  let buttonExtras = -1;
  function ButtonProbe() {
    buttonExtras = useHealthExtrasCount();
    return null;
  }
  // Mounted, so the list publishes the rows the button cannot compute itself.
  const list = mount(
    withClient(
      <>
        <SystemHealthSection onFix={onFix} />
        <ButtonProbe />
      </>,
    ),
  );
  const shown = list.container.querySelectorAll('[data-testid^="settings-attention-"]');
  const rowCount = [...shown].filter((row) => !row.getAttribute("data-testid")!.endsWith("-fix"));
  // The button's count, computed as the sidebar button computes it.
  const buttonCount = systemHealthItems(state.system as never).length + healthExtrasCount();
  expect(buttonCount).toBe(rowCount.length);
  list.unmount();
  // An account fixed elsewhere changes its source data; the button stops counting old rows.
  const probe = mount(withClient(<ButtonProbe />));
  act(() => queryClient.setQueryData(["providersSnapshot", "host"], { entries: [] }));
  expect(buttonExtras).toBe(0);
  probe.unmount();
  cleanup();
});
it("never stays on Checking while settings are locked", () => {
  state.owner = "locked";
  // Shared settings never load while locked.
  state.data = undefined;
  expect(rows(render())).toEqual(["locked"]);
});
