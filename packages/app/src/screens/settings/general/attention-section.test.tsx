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
}));
vi.mock("@/components/settings", () => ({
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ label, children }: { label: string; children?: ReactNode }) => (
    <div>
      {label}
      {children}
    </div>
  ),
}));
vi.mock("@/components/settings/collapsible-row", () => ({ SettingsCollapsibleRow: () => null }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));
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
vi.mock("@/execution-installation/panel", () => ({ useRestartsAwaitingApproval: () => 0 }));
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
vi.mock("../shared-providers-model", () => ({ providersNeedingAttention: () => [] }));
vi.mock("../use-provider-detection", () => ({ useProviderDetection: () => [] }));
import { AttentionSection } from "./attention-section";
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
});
const openPane = vi.fn();
const render = () => renderToStaticMarkup(<AttentionSection onOpenPane={openPane} />);
it("waits for the first enabled settings answer", () => {
  expect(render()).toContain("Checking...");
});
it("answers when the installation query is disabled", () => {
  state.installation = null;
  expect(render()).toContain("All clear");
});
it("answers after the first settings fetch fails", () => {
  state.error = new Error("offline");
  expect(render()).toContain("All clear");
});
it("answers without a host even if settings has not loaded", () => {
  state.serverId = undefined;
  expect(render()).toContain("All clear");
});
it("asks for a primary connection once shared settings load without one", () => {
  state.installation = null;
  state.primary = { loaded: true, supported: true, primary: null };
  const html = render();
  expect(html).toContain("Choose a primary connection for system threads");
  expect(html).toContain("Open Providers");
  state.primary = { loaded: true, supported: true, primary: { providerId: "claude" } };
  expect(render()).toContain("All clear");
  // Not loaded yet, or unsupported: never asks.
  state.primary = { loaded: false, supported: false, primary: undefined };
  expect(render()).toContain("All clear");
});
it("asks for another primary connection when the chosen one cannot run anywhere", () => {
  state.installation = null;
  state.primary = { loaded: true, supported: true, primary: { providerId: "claude" } };
  state.availability = "unavailable";
  const html = render();
  expect(html).toContain(
    "Your primary connection is unavailable. Choose another for system threads.",
  );
  expect(html).toContain("Open Providers");
  // Still checking: say nothing rather than flicker.
  state.availability = "unknown";
  expect(render()).toContain("All clear");
});
it("asks a standalone daemon's owner the same way", () => {
  state.installation = null;
  state.hosts = [{ serverId: "local" }];
  state.standalone = { loaded: true, supported: true, primary: null };
  expect(render()).toContain("Choose a primary connection for system threads");
});
