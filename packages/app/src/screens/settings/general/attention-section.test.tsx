import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
const state = vi.hoisted(() => ({
  serverId: "host" as string | undefined,
  installation: {} as object | null,
  data: undefined as object | undefined,
  error: null as Error | null,
  isLoading: false,
}));
vi.mock("@/components/settings", () => ({
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("@/components/settings/collapsible-row", () => ({ SettingsCollapsibleRow: () => null }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/execution-installation/panel", () => ({ useRestartsAwaitingApproval: () => 0 }));
vi.mock("@/execution-installation/policy", () => ({
  installationDefaultServerId: () => state.serverId,
  readExecutionInstallation: () => state.installation,
}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: undefined, isLoading: state.isLoading, error: null }),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHosts: () => [] }));
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
