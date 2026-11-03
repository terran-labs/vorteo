// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { reportSyncError } from "@/components/settings/sync-error-notification";
import { SharedProviderSection } from "./shared-provider-section";
const mocks = vi.hoisted(() => ({ error: null as Error | null, show: vi.fn() }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Pressable: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("./use-shared-provider-profiles", () => ({
  useSharedProviderProfiles: () => ({
    shared: undefined,
    group: undefined,
    installation: { installationId: "sync-test" },
    error: mocks.error,
  }),
}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [] }),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: mocks.show }) }));
vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));
vi.mock("@/components/settings/headings/settings-section", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/settings", () => ({
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsCollapsibleRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("./agent-profile-row", () => ({ AgentProfileRow: () => null }));
afterEach(() => {
  cleanup();
  reportSyncError("installation-profiles:sync-test", null, mocks.show);
  vi.useRealTimers();
});
it("reports repeated failed polls once across providers, then resets after recovery", () => {
  vi.useFakeTimers();
  mocks.show.mockClear();
  mocks.error = new Error("Offline");
  const { rerender } = render(
    <>
      <SharedProviderSection serverId="host" provider="codex" />
      <SharedProviderSection serverId="host" provider="claude" />
    </>,
  );
  vi.advanceTimersByTime(1200);
  expect(mocks.show).toHaveBeenCalledTimes(1);
  for (let poll = 0; poll < 3; poll++) {
    mocks.error = new Error(`Still offline ${poll}`);
    rerender(
      <>
        <SharedProviderSection serverId="host" provider="codex" />
        <SharedProviderSection serverId="host" provider="claude" />
      </>,
    );
    vi.advanceTimersByTime(5000);
  }
  expect(mocks.show).toHaveBeenCalledTimes(1);
  mocks.error = null;
  rerender(<SharedProviderSection serverId="host" provider="codex" />);
  mocks.error = new Error("Offline again");
  rerender(<SharedProviderSection serverId="host" provider="codex" />);
  vi.advanceTimersByTime(1200);
  expect(mocks.show).toHaveBeenCalledTimes(2);
});
