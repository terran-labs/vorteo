// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemPane } from "./system-pane";
const mocks = vi.hoisted(() => ({
  runAction: vi.fn(),
  status: "healthy",
  services: null as string | null,
  jobs: [] as { id: string; target: string; status: string; createdAt: string }[],
}));
vi.mock("../service-access-section", () => ({ ServiceAccessSection: () => null }));
vi.mock("../blocked-work-review-card", () => ({ BlockedWorkReviewCard: () => null }));
vi.mock("@/components/ui/scroll-view", () => ({
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./use-system-adapter", () => ({
  useSystemAdapter: () => ({
    hostId: "host",
    devId: "dev",
    hostStatus: { status: mocks.status, action: { kind: "reconnect", label: "Reconnect" } },
    devStatus: { status: "healthy", action: null },
    runAction: mocks.runAction,
    state: {
      unlocked: true,
      lastUpdatedAt: "2026-11-06",
      jobs: mocks.jobs,
      pendingJobs: mocks.jobs.filter((job) => job.status === "pending"),
    },
    model: {},
    services: mocks.services,
  }),
}));
vi.mock("react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native")>()),
  Platform: { ...(await importOriginal<typeof import("react-native")>()).Platform, OS: "web" },
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
  useInstallationOwnerAccess: () => {
    throw new Error("Owner access is outside the System pane fixture");
  },
  InstallationSystemAdvanced: () => <span>Automatic updates and restarts</span>,
  InstallationSystemDetails: ({
    requestId,
    target,
  }: {
    requestId?: string | null;
    target: string;
  }) => <span>Service queue and requests{requestId ? `: ${target} ${requestId}` : ""}</span>,
  RestartRequest: ({ job }: { job: { id: string } }) => <span>Review {job.id}</span>,
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
  mocks.jobs = [];
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

it.each(["rejected", "missing"])(
  "reveals a linked %s request in Host Details without opening Restart",
  (status) => {
    mocks.jobs =
      status === "missing"
        ? []
        : [{ id: "linked", target: "host", status, createdAt: "2026-11-06" }];
    const { rerender } = render(<SystemPane restartRequestId="linked" />);
    expect(screen.getByText("Service queue and requests: host linked")).toBeTruthy();
    expect(screen.queryByText("Review linked")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Host Details" }));
    mocks.status = "attention";
    rerender(<SystemPane restartRequestId="linked" />);
    expect(screen.queryByText("Service queue and requests: host linked")).toBeNull();
  },
);
it("opens the linked Dev restart review and moves its completed receipt to Dev Details", () => {
  mocks.jobs = [
    { id: "linked-dev", target: "container-daemon", status: "pending", createdAt: "2026-11-06" },
  ];
  const { rerender } = render(<SystemPane restartRequestId="linked-dev" />);
  expect(screen.getByText("Review linked-dev")).toBeTruthy();
  expect(screen.queryByText("Service queue and requests: container-daemon linked-dev")).toBeNull();
  mocks.jobs = [{ ...mocks.jobs[0]!, status: "rejected" }];
  rerender(<SystemPane restartRequestId="linked-dev" />);
  expect(screen.queryByText("Review linked-dev")).toBeNull();
  expect(screen.getByText("Service queue and requests: container-daemon linked-dev")).toBeTruthy();
});

it.each([
  "system.overview.customDomain",
  "system.overview.domain",
  "maintenance.installation.deliveryMode",
])("reveals Advanced for %s search without reopening it on a poll", (focusedSettingId) => {
  const { rerender } = render(
    <SystemPane focusedSettingId={focusedSettingId} focusRequestNonce={1} />,
  );
  expect(screen.getByText("Automatic updates and restarts")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  expect(screen.queryByText("Automatic updates and restarts")).toBeNull();
  mocks.status = "updating";
  rerender(<SystemPane focusedSettingId={focusedSettingId} focusRequestNonce={1} />);
  expect(screen.queryByText("Automatic updates and restarts")).toBeNull();
  rerender(<SystemPane focusedSettingId={focusedSettingId} focusRequestNonce={2} />);
  expect(screen.getByText("Automatic updates and restarts")).toBeTruthy();
});
