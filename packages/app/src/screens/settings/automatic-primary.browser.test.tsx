import React, { act, useCallback, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type {
  InstallationSettings,
  InstallationSettingsSnapshot,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { i18n } from "@/i18n/i18next";

type Snapshot = InstallationSettingsSnapshot & { settings: InstallationSettings };

const state = vi.hoisted(() => ({ snapshot: null as unknown }));

vi.mock("@/execution-installation/policy", () => ({
  installationHostServerId: () => "host",
  readExecutionInstallation: () => ({
    installationId: "installation",
    environments: [
      { kind: "host", serverId: "host", endpoint: "h.example.test", useTls: true },
      { kind: "container", serverId: "dev", endpoint: "d.example.test", useTls: true },
    ],
  }),
}));
vi.mock("@/execution-installation/settings", () => ({
  InstallationSettingsConflictError: class InstallationSettingsConflictError extends Error {},
  requestInstallationSettings: vi.fn(),
  useInstallationSettings: () => ({ data: state.snapshot }),
}));
// The animated switch needs theme colours the browser test stub does not provide.
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    disabled,
    accessibilityLabel,
    testID,
  }: {
    value: boolean;
    onValueChange?: (next: boolean) => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement("div", {
      role: "switch",
      "aria-checked": value ? "true" : "false",
      "aria-disabled": disabled ? "true" : undefined,
      "aria-label": accessibilityLabel,
      "data-testid": testID ?? "provider-switch",
      onClick: (event: React.MouseEvent) => {
        event.stopPropagation();
        if (disabled) return;
        onValueChange?.(!value);
      },
    }),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: vi.fn(), error: vi.fn() }),
}));
// A fake daemon per environment: Automatic picks the first bound account the owner allows, as
// the real ranking does once quota ties.
vi.mock("@/provider-usage/use-provider-usage", () => ({
  providerUsageQueryKey: (serverId: string) => ["providerUsage", serverId],
  useProviderUsage: (serverId: string) => {
    const snapshot = state.snapshot as Snapshot;
    const pick = snapshot.settings.providerDefinitions?.find(
      (definition) => definition.bindings[serverId] && definition.policy.automaticPrimary !== false,
    );
    const automaticPrimary = pick
      ? { providerId: pick.bindings[serverId]!, label: pick.policy.label! }
      : null;
    return {
      view: { kind: "ready", payload: { providers: [], automaticPrimary }, isRefreshing: false },
      canFetch: true,
      refresh: vi.fn(),
    };
  },
}));

import { AutomaticEligibilityRow, PrimaryConnectionRow } from "./automatic-primary";

const codex: InstallationProvider = {
  id: "account/codex-3",
  providerType: "codex",
  bindings: { host: "codex-3" },
  policy: { label: "Codex 3" },
};
const claude: InstallationProvider = {
  id: "account/claude-1",
  providerType: "claude",
  bindings: { host: "claude-1", dev: "claude-dev" },
  policy: { label: "Claude 1" },
};
const environments = [
  { kind: "host" as const, serverId: "host", endpoint: "h.example.test", useTls: true },
  { kind: "container" as const, serverId: "dev", endpoint: "d.example.test", useTls: true },
];

const initialSnapshot = {
  version: 1,
  revision: 4,
  sources: {},
  settings: {
    providerDefinitions: [codex, claude],
    primaryConnection: null,
  },
} as unknown as Snapshot;
const queryClient = new QueryClient();

function Harness({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  state.snapshot = snapshot;
  // The coordinator saves the owner's change and answers with the next revision.
  const save = useCallback(
    (update: InstallationSettingsUpdate) =>
      setSnapshot((current) => ({
        ...current,
        revision: current.revision + 1,
        settings: { ...current.settings, ...update.settings },
      })),
    [],
  );
  const definitions = useMemo(
    () => snapshot.settings.providerDefinitions ?? [],
    [snapshot.settings.providerDefinitions],
  );
  // As on the page, the account is read from the current settings, so it shows a saved change.
  const account = useMemo(
    () => ({
      id: "codex-3",
      name: "Codex 3",
      enabled: true,
      definitions: definitions.filter((entry) => entry.id === codex.id),
    }),
    [definitions],
  );
  return (
    <>
      <PrimaryConnectionRow definitions={definitions} environments={environments} />
      <AutomaticEligibilityRow account={account} snapshot={snapshot} busy={false} save={save} />
    </>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  await page.viewport(1280, 800);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

test("switching an account off for Automatic moves the Host's pick and leaves Dev's alone", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Harness initial={initialSnapshot} />
      </QueryClientProvider>,
    ),
  );
  const pick = (serverId: string) =>
    document.querySelector<HTMLElement>(`[data-testid="shared-providers-automatic-${serverId}"]`)
      ?.textContent;
  expect(pick("host")).toContain("Codex 3");
  expect(pick("dev")).toContain("Claude 1");
  const toggle = document.querySelector<HTMLElement>(
    '[data-testid="provider-automatic-eligible-codex-3"]',
  )!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(pick("host")).toContain("Claude 1");
  expect(pick("host")).not.toContain("Codex 3");
  expect(pick("dev")).toContain("Claude 1");
  // Switching it back on returns the Host to it.
  await act(async () => toggle.click());
  expect(pick("host")).toContain("Codex 3");
});
