// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemUpdatesRow } from "./system-updates-row";
const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  checkApp: vi.fn(),
  install: vi.fn(),
  settings: vi.fn(async () => {}),
  confirm: vi.fn(async () => false),
  error: vi.fn(),
  fetching: false,
  policy: false,
  checkInstallation: vi.fn(async () => {}),
}));
vi.mock("@/execution-installation/panel", () => ({
  useInstallationOwnerClient: () => (mocks.policy ? {} : null),
}));
vi.mock("@/execution-installation/use-installation-upgrades", () => ({
  useInstallationUpgradeStatus: () => ({
    data: mocks.policy ? { policy: { mode: "manual", channel: "beta" } } : null,
  }),
  useInstallationUpgradeActions: () => ({
    check: { isPending: false, mutateAsync: mocks.checkInstallation },
  }),
}));
vi.mock("react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native")>()),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/select-field", () => ({
  SelectField: ({ onChange }: { onChange: (value: string) => void }) => {
    const change = useCallback(() => onChange("beta"), [onChange]);
    return (
      <button type="button" onClick={change}>
        Release channel
      </button>
    );
  },
}));
vi.mock("@/components/settings/settings-status-line", () => ({
  SettingsStatusLine: ({ message }: { message: string }) => <span>{message}</span>,
}));
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ settings: { releaseChannel: "stable" }, updateSettings: mocks.settings }),
}));
vi.mock("@/desktop/updates/use-desktop-app-updater", () => ({
  useDesktopAppUpdater: () => ({
    isDesktopApp: true,
    statusText: "App ready",
    isChecking: false,
    availableUpdate: { readyToInstall: true },
    checkForUpdates: mocks.checkApp,
    installUpdate: mocks.install,
  }),
}));
vi.mock("@/vorton-updates/use-update", () => ({
  useVortonUpdate: () => ({
    data: { status: "current" },
    checkNow: mocks.check,
    isFetching: mocks.fetching,
  }),
}));
vi.mock("@/vorton-updates/section", () => ({
  VortonUpdatesSection: () => <span>Vorteo update details</span>,
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: mocks.error }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.fetching = false;
  mocks.policy = false;
});
it("checks both update sources and preserves the disclosure through polling", () => {
  const { rerender } = render(<SystemUpdatesRow />);
  expect(screen.queryByText("Vorteo update details")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(mocks.check).toHaveBeenCalledOnce();
  expect(mocks.checkApp).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  mocks.fetching = true;
  rerender(<SystemUpdatesRow />);
  expect(screen.getByText("Vorteo update details")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Check" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Release channel" }));
  expect(mocks.settings).toHaveBeenCalledWith({ releaseChannel: "beta" });
});
it("requires confirmation before installing the app", async () => {
  render(<SystemUpdatesRow />);
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Update app" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(mocks.install).not.toHaveBeenCalled();
  mocks.confirm.mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "Update app" }));
  await waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
});

it("checks the installation policy instead of the device channel when available", () => {
  mocks.policy = true;
  render(<SystemUpdatesRow />);
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(mocks.checkInstallation).toHaveBeenCalledOnce();
  expect(mocks.check).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.queryByRole("button", { name: "Release channel" })).toBeNull();
});
