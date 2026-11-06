/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { ToastApiProvider } from "@/contexts/toast-api-context";

const {
  snapshotState,
  configState,
  patchConfigMock,
  openProviderSettingsMock,
  catalogState,
  sharedSave,
  localPatch,
  refreshMock,
} = vi.hoisted(() => {
  const initialCatalogState: {
    capability: boolean | undefined;
    managed: boolean;
    connected: boolean;
    settings: ReturnType<typeof useInstallationSettings>["data"];
  } = {
    capability: undefined,
    managed: false,
    connected: true,
    settings: undefined,
  };
  return {
    catalogState: initialCatalogState,
    sharedSave: vi.fn(async (): Promise<void> => undefined),
    localPatch: vi.fn(async () => undefined),
    refreshMock: vi.fn(async () => undefined),
    snapshotState: {
      entries: undefined as ProviderSnapshotEntry[] | undefined,
      isLoading: false,
      isRefreshing: false,
    },
    configState: {
      config: null as MutableDaemonConfig | null,
    },
    patchConfigMock: vi.fn(async () => undefined),
    openProviderSettingsMock: vi.fn(),
  };
});

vi.mock("react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native")>()),
  Platform: { ...(await importOriginal<typeof import("react-native")>()).Platform, OS: "web" },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Pressable: ({
    children,
    onPress,
    onHoverIn,
    onHoverOut,
    accessibilityRole,
    accessibilityLabel,
    disabled,
    testID,
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
    onPress?: (event: React.MouseEvent) => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      {
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "aria-disabled": disabled ? "true" : undefined,
        "data-testid": testID,
        onClick: disabled ? undefined : onPress,
        onMouseEnter: onHoverIn,
        onMouseLeave: onHoverOut,
      },
      typeof children === "function" ? children({ pressed: false, hovered: false }) : children,
    ),
  ActivityIndicator: () => React.createElement("span", { "data-testid": "activity-indicator" }),
}));

vi.mock("lucide-react-native", async (importOriginal) => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    ...(await importOriginal<typeof import("lucide-react-native")>()),
    ChevronRight: icon("ChevronRight"),
    MoreHorizontal: icon("MoreHorizontal"),
    Trash2: icon("Trash2"),
  };
});

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      (
        ({
          "settings.providers.providerDetails": "{{name}} provider details",
          "settings.providers.enableProvider": "Enable {{name}}",
          "settings.providers.statuses.disabled": "Disabled",
          "settings.providers.statuses.available": "Available",
          "settings.providers.statuses.loading": "Loading",
          "settings.providers.statuses.error": "Error",
          "settings.providers.statuses.notInstalled": "Not installed",
          "settings.providers.models.one": "1 model",
          "settings.providers.models.many": "{{count}} models",
          "settings.providers.addErrorTitle": "Unable to add provider",
          "settings.providers.updateErrorTitle": "Unable to update provider",
          "settings.providers.actions.menu": "{{name}} actions",
          "settings.providers.actions.remove": "Remove provider",
          "settings.providers.actions.removing": "Removing...",
          "settings.providers.remove.confirmTitle": "Remove {{name}}?",
          "settings.providers.remove.confirmMessage":
            "This deletes the provider entry from config.json. It cannot be undone.",
          "settings.providers.remove.confirm": "Remove",
          "settings.providers.remove.errorTitle": "Unable to remove provider",
        })[key] ?? key
      )
        .replaceAll("{{name}}", String(values?.name ?? ""))
        .replaceAll("{{count}}", String(values?.count ?? "")),
  }),
}));

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

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { "data-testid": "loading-spinner" }),
}));

vi.mock("@/components/settings/headings/settings-info-tip", () => ({
  SettingsInfoTip: () => null,
}));

vi.mock("@/components/ui/external-link", () => ({
  ExternalLink: () => null,
  ExternalLinkLabel: () => null,
  EXTERNAL_LINK_HOVER_GROUP: "external-link",
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuTrigger: ({
    children,
    onPressIn,
    accessibilityRole,
    accessibilityLabel,
    testID,
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean; open: boolean }) => React.ReactNode);
    onPressIn?: (event: { stopPropagation: () => void }) => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        onMouseDown: (event: React.MouseEvent) => onPressIn?.(event),
        onClick: (event: React.MouseEvent) => event.stopPropagation(),
      },
      typeof children === "function"
        ? children({ pressed: false, hovered: false, open: false })
        : children,
    ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    status,
    pendingLabel,
    testID,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    status?: "idle" | "pending" | "success";
    pendingLabel?: string;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        disabled: status === "pending" || status === "success",
        onClick: (event: React.MouseEvent) => {
          event.stopPropagation();
          onSelect?.();
        },
      },
      status === "pending" ? pendingLabel : children,
    ),
}));

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/components/provider-icons", () => ({
  useProviderIcon: (provider: string) => () =>
    React.createElement("span", { "data-icon": `provider-${provider}` }),
}));

vi.mock("@/stores/provider-settings-store", () => ({
  useProviderSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ open: openProviderSettingsMock }),
}));

vi.mock("@/components/provider-catalog-list", () => ({
  ProviderCatalogList: ({
    onInstall,
    installError,
  }: React.ComponentProps<
    typeof import("@/components/provider-catalog-list").ProviderCatalogList
  >) =>
    React.createElement(
      "div",
      null,
      ...ACP_PROVIDER_CATALOG.map((entry) =>
        React.createElement(
          "div",
          { key: entry.id },
          React.createElement(
            "button",
            {
              type: "button",
              "data-testid": `install-${entry.id}`,
              onClick: () => onInstall(entry),
            },
            entry.title,
          ),
          installError?.providerId === entry.id
            ? React.createElement(
                "div",
                { "data-testid": `catalog-error-${entry.id}` },
                installError.message,
              )
            : null,
        ),
      ),
    ),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: snapshotState.entries,
    isLoading: snapshotState.isLoading,
    isFetching: false,
    isRefreshing: snapshotState.isRefreshing,
    error: null,
    supportsSnapshot: true,
    refresh: refreshMock,
    refetchIfStale: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: configState.config,
    isLoading: false,
    patchConfig: patchConfigMock,
  }),
}));

vi.mock("@/runtime/host-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/host-runtime")>()),
  useHostRuntimeClient: () => (catalogState.connected ? { patchDaemonConfig: localPatch } : null),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    feature === "hopliteProvider" ? catalogState.capability : false,
}));

vi.mock("@/execution-installation/settings", () => ({
  useInstallationSettings: () => ({
    installation: catalogState.managed ? { environments: [{ serverId: "server-1" }] } : null,
    data: catalogState.settings,
    save: sharedSave,
  }),
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => true),
}));

import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";
import { InstallationSettingsSchema } from "@getpaseo/protocol/installation-settings";
import type { useInstallationSettings } from "@/execution-installation/settings";
import { ProvidersSection } from "./providers-section";

function unexpectedToast(): never {
  throw new Error("Provider row interactions should not display a toast");
}

const reportedErrors: string[] = [];
const toastApi = {
  show: unexpectedToast,
  copied: unexpectedToast,
  error: (message: string) => reportedErrors.push(message),
};

const claudeEntry: ProviderSnapshotEntry = {
  provider: "claude",
  status: "ready",
  enabled: true,
  label: "Claude",
  description: "Claude Code",
  defaultModeId: null,
  modes: [],
  models: [
    { provider: "claude", id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { provider: "claude", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { provider: "claude", id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

const disabledCodexEntry: ProviderSnapshotEntry = {
  provider: "codex",
  status: "unavailable",
  enabled: false,
  label: "Codex",
  description: "OpenAI Codex",
  defaultModeId: null,
  modes: [],
};

function makeConfig(providers: MutableDaemonConfig["providers"] = {}): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers,
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
}

function descendants(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("*"));
}

function indexOfMatches(nodes: HTMLElement[], selector: string): number {
  return nodes.findIndex((node) => node.matches(selector));
}

function indexOfText(nodes: HTMLElement[], text: string): number {
  return nodes.findIndex((node) => node.textContent?.trim() === text);
}

describe("ProvidersSection", () => {
  let queryClient: QueryClient;
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    reportedErrors.length = 0;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    catalogState.capability = undefined;
    catalogState.managed = false;
    catalogState.connected = true;
    catalogState.settings = undefined;
    sharedSave.mockReset();
    localPatch.mockReset();
    refreshMock.mockReset();
    snapshotState.entries = undefined;
    snapshotState.isLoading = false;
    snapshotState.isRefreshing = false;
    configState.config = null;
    patchConfigMock.mockReset();
    patchConfigMock.mockResolvedValue(undefined);
    openProviderSettingsMock.mockReset();
  });

  afterEach(() => {
    queryClient.clear();
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  function render(): void {
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <ToastApiProvider api={toastApi}>
            <ProvidersSection serverId="server-1" />
          </ToastApiProvider>
        </QueryClientProvider>,
      );
    });
  }

  function findRow(accessibilityLabel: string): HTMLElement {
    const row = container?.querySelector<HTMLElement>(
      `[role="button"][aria-label="${accessibilityLabel}"]`,
    );
    if (!row) throw new Error(`Expected row with aria-label "${accessibilityLabel}"`);
    return row;
  }

  async function installCatalog(id: string): Promise<void> {
    snapshotState.entries = [];
    configState.config = makeConfig();
    render();
    const button = container?.querySelector<HTMLButtonElement>(`[data-testid="install-${id}"]`);
    if (!button) throw new Error("Missing catalog button");
    await act(async () => {
      button.click();
    });
  }

  it("installs bundled Hoplite when the target advertises support", async () => {
    catalogState.capability = true;
    await installCatalog("hoplite");
    await vi.waitFor(() =>
      expect(patchConfigMock).toHaveBeenCalledExactlyOnceWith({
        providers: { hoplite: { enabled: true, removed: false } },
      }),
    );
    expect(sharedSave).not.toHaveBeenCalled();
    expect(localPatch).not.toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalledExactlyOnceWith(["hoplite"]);
  });

  it.each([false, undefined])(
    "refuses bundled Hoplite without writes when capability is %s",
    async (capability) => {
      catalogState.capability = capability;
      await installCatalog("hoplite");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(reportedErrors).toEqual(["Update the host to add Hoplite."]);
      expect(patchConfigMock).not.toHaveBeenCalled();
      expect(sharedSave).not.toHaveBeenCalled();
      expect(localPatch).not.toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
    },
  );

  it("reports refusals as toasts without inserting catalog rows", async () => {
    catalogState.capability = false;
    await installCatalog("hoplite");
    await vi.waitFor(() => expect(reportedErrors).toEqual(["Update the host to add Hoplite."]));
    expect(container?.querySelector('[data-testid="catalog-error-hoplite"]')).toBeNull();
    await installCatalog("minimax-code");
    expect(reportedErrors).toHaveLength(1);
    await installCatalog("hoplite");
    await vi.waitFor(() => expect(reportedErrors).toHaveLength(2));
    catalogState.capability = true;
    await installCatalog("hoplite");
    expect(reportedErrors).toHaveLength(2);
  });

  function managedSettings() {
    catalogState.managed = true;
    const settings = InstallationSettingsSchema.parse({
      mcp: { injectIntoAgents: false },
      appendSystemPrompt: "",
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      pluginsEnabled: false,
      terminalProfiles: [],
      metadataGeneration: { providers: [] },
      resourceExclusions: {},
      providerDefinitions: [],
    });
    catalogState.settings = { version: 1, revision: 7, sources: {}, settings };
    return settings;
  }

  it("saves managed ACP enrollment at the observed revision before patching the Host", async () => {
    managedSettings();
    let finishSave: (() => void) | undefined;
    sharedSave.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    await installCatalog("minimax-code");
    expect(sharedSave).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 7,
      settings: {
        providerDefinitions: [
          {
            id: "catalog/acp/minimax-code",
            providerType: "minimax-code",
            bindings: { "server-1": "minimax-code" },
            policy: {
              label: "MiniMax Code",
              description: "MiniMax's coding agent for the terminal",
            },
          },
        ],
      },
    });
    expect(localPatch).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    if (!finishSave) throw new Error("Shared save did not start");
    const resolveSave = finishSave;
    await act(async () => {
      resolveSave();
    });
    expect(localPatch).toHaveBeenCalledExactlyOnceWith({
      providers: {
        "minimax-code": {
          extends: "acp",
          label: "MiniMax Code",
          description: "MiniMax's coding agent for the terminal",
          command: ["npx", "-y", "-p", "@minimax-ai/code@0.6.13", "mcode", "acp"],
          env: {},
        },
      },
    });
    expect(patchConfigMock).not.toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalledExactlyOnceWith(["minimax-code"]);
  });

  it.each(["missing settings", "disconnected", "conflicts", "save rejected", "bundled"])(
    "refuses managed enrollment without local writes: %s",
    async (reason) => {
      const settings = managedSettings();
      catalogState.capability = true;
      if (reason === "missing settings") catalogState.settings = undefined;
      if (reason === "disconnected") catalogState.connected = false;
      if (reason === "conflicts")
        catalogState.settings = {
          version: 1,
          revision: 7,
          sources: {},
          settings: null,
          conflicts: { candidates: { "server-1": settings }, fields: ["providerDefinitions"] },
        };
      if (reason === "save rejected")
        sharedSave.mockRejectedValue(new Error("Shared revision refused"));
      await installCatalog(reason === "bundled" ? "hoplite" : "minimax-code");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      let expected =
        "Connect this environment and resolve shared settings migration before installing a runtime.";
      if (reason === "bundled")
        expected = "Catalog enrollment requires an ACP runtime without an account identity.";
      if (reason === "save rejected") expected = "Shared revision refused";
      expect(reportedErrors).toEqual([expected]);
      expect(container?.textContent).not.toContain(expected);
      expect(localPatch).not.toHaveBeenCalled();
      expect(patchConfigMock).not.toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
      expect(sharedSave).toHaveBeenCalledTimes(reason === "save rejected" ? 1 : 0);
    },
  );

  it("renders the disabled provider with its server-provided label in snapshot order", () => {
    snapshotState.entries = [claudeEntry, disabledCodexEntry];
    configState.config = makeConfig({ codex: { enabled: false } });

    render();

    const rows = Array.from(
      container?.querySelectorAll<HTMLElement>('[role="button"][aria-label$="provider details"]') ??
        [],
    );
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Claude provider details",
      "Codex provider details",
    ]);

    const codexRow = findRow("Codex provider details");
    const codexNodes = descendants(codexRow);
    expect(indexOfText(codexNodes, "Codex")).toBeGreaterThanOrEqual(0);
    expect(indexOfText(codexNodes, "codex")).toBe(-1);
    expect(indexOfText(codexNodes, "Disabled")).toBeGreaterThanOrEqual(0);
  });

  it("composes the row as chevron, icon, label, status, model count, then switch", () => {
    snapshotState.entries = [claudeEntry];
    configState.config = makeConfig();

    render();

    const row = findRow("Claude provider details").parentElement;
    if (!row) throw new Error("Expected provider row containing details and sibling controls");
    const nodes = descendants(row);
    const chevron = indexOfMatches(nodes, '[data-icon="ChevronRight"]');
    const icon = indexOfMatches(nodes, '[data-icon="provider-claude"]');
    const label = indexOfText(nodes, "Claude");
    const status = indexOfText(nodes, "Available");
    const modelCount = indexOfText(nodes, "3 models");
    const switchEl = indexOfMatches(nodes, '[role="switch"]');

    expect(chevron).toBeGreaterThanOrEqual(0);
    expect(icon).toBeGreaterThan(chevron);
    expect(label).toBeGreaterThan(icon);
    expect(status).toBeGreaterThan(label);
    expect(modelCount).toBeGreaterThan(status);
    expect(switchEl).toBeGreaterThan(modelCount);
  });

  it("opens the diagnostic sheet when the outer row is pressed for a disabled provider", () => {
    snapshotState.entries = [disabledCodexEntry];
    configState.config = makeConfig({ codex: { enabled: false } });

    render();

    expect(openProviderSettingsMock).not.toHaveBeenCalled();

    const row = findRow("Codex provider details");
    act(() => {
      row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(openProviderSettingsMock).toHaveBeenCalledTimes(1);
    expect(openProviderSettingsMock).toHaveBeenCalledWith({
      serverId: "server-1",
      provider: "codex",
    });
  });

  it("toggles the provider enabled flag through patchConfig when the switch is pressed", async () => {
    snapshotState.entries = [claudeEntry];
    configState.config = makeConfig();

    render();

    const row = findRow("Claude provider details").parentElement;
    if (!row) throw new Error("Expected provider row containing details and sibling controls");
    const switchEl = row.querySelector<HTMLElement>('[role="switch"]');
    expect(switchEl).not.toBeNull();
    expect(switchEl?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      switchEl?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(patchConfigMock).toHaveBeenCalledTimes(1);
    expect(patchConfigMock).toHaveBeenCalledWith({
      providers: { claude: { enabled: false } },
    });
  });
});
