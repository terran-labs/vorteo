// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemPane } from "./system-pane";
const mocks = vi.hoisted(() => ({
  runAction: vi.fn(),
  status: "healthy",
  services: null as string | null,
}));
vi.mock("./use-system-adapter", () => ({
  useSystemAdapter: () => ({
    hostId: "host",
    devId: "dev",
    hostStatus: { status: mocks.status, action: { kind: "reconnect", label: "Reconnect" } },
    devStatus: { status: "healthy", action: null },
    runAction: mocks.runAction,
    state: null,
    services: mocks.services,
  }),
}));
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: 390 }),
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, testID }: { children: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    testID,
  }: {
    children: ReactNode;
    onPress: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/settings/headings/settings-section", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("@/components/settings/settings-status-line", () => ({ SettingsStatusLine: () => null }));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [],
  useHostRuntimeSnapshot: () => null,
}));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => ({ version: "1" }) }));
vi.mock("@/data/query", () => ({ useFetchQuery: () => ({ data: { pid: 42 } }) }));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useIsLocalDaemon: () => false }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children, visible }: { children: ReactNode; visible: boolean }) =>
    visible ? <div>{children}</div> : null,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
}));
vi.mock("@/components/ui/dropdown-trigger", () => ({ DropdownTrigger: () => <span>More</span> }));
vi.mock("@/desktop/components/desktop-updates-section", () => ({
  LocalDaemonSection: () => <span>Local controls</span>,
}));
vi.mock("@/execution-installation/panel", () => ({
  InstallationSystemAdvanced: () => <span>Automatic updates and restarts</span>,
  InstallationSystemDetails: () => <span>Service queue and requests</span>,
  RestartActions: () => null,
}));
vi.mock("@/execution-installation/connection-check-wrapper", () => ({
  InstallationConnectionCheck: () => <span>Connection check</span>,
}));
vi.mock("@/vorton-updates/upstream-section", () => ({
  UpstreamUpdatesSection: () => <span>Upstream updates</span>,
}));
vi.mock("@/vorton-updates/use-update", () => ({ VORTON_BUILD_COMMIT: "commit" }));
vi.mock("./host-restart-controls", () => ({ HostRestartControls: () => null }));
vi.mock("./restart-behavior-section", () => ({
  RestartBehaviorSection: ({ serverId }: { serverId: string }) => (
    <span>When the Host restarts for {serverId}</span>
  ),
}));
vi.mock("./system-updates-row", () => ({ SystemUpdatesRow: () => <span>Combined updates</span> }));
afterEach(() => {
  cleanup();
  mocks.status = "healthy";
  mocks.services = null;
  vi.clearAllMocks();
});
it("renders both environments, one primary action and closed disclosures", () => {
  render(<SystemPane />);
  expect(screen.getByText("Host")).toBeTruthy();
  expect(screen.getByText("Dev")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Reconnect" })).toHaveLength(1);
  expect(screen.queryByText("Service queue and requests")).toBeNull();
  expect(screen.queryByText("Upstream updates")).toBeNull();
  expect(screen.getByText("Combined updates")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(mocks.runAction).toHaveBeenCalledWith("host", { kind: "reconnect", label: "Reconnect" });
});
const recovery = <span>Recovery slot</span>;
it("only mounts details on disclosure and keeps them open through status polls", () => {
  const { rerender } = render(<SystemPane restartRecovery={recovery} />);
  fireEvent.click(screen.getByRole("button", { name: "Host Details" }));
  expect(screen.getByText("Connection check")).toBeTruthy();
  expect(screen.getByText("PID: 42")).toBeTruthy();
  mocks.status = "updating";
  mocks.services = "attention";
  rerender(<SystemPane restartRecovery={recovery} />);
  expect(screen.getByText("Connection check")).toBeTruthy();
  expect(screen.getByText("System services")).toBeTruthy();
  expect(screen.getByText("Recovery slot")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  expect(screen.getByText("Automatic updates and restarts")).toBeTruthy();
  expect(screen.getByText("Upstream updates")).toBeTruthy();
});
