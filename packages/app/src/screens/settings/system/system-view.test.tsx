// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemView } from "./system-view";
import { deriveSystemEnvironment } from "./system-status-model";
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({
    children,
    numberOfLines,
    accessibilityLabel,
  }: {
    children: ReactNode;
    numberOfLines?: number;
    accessibilityLabel?: string;
  }) => (
    <span aria-label={accessibilityLabel} data-lines={numberOfLines}>
      {children}
    </span>
  ),
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
afterEach(cleanup);
it("keeps the full reason accessible on a single secondary line outside the approval button", () => {
  const reason =
    "Apply a source update with a lengthy explanation that should never be a button label";
  const state = deriveSystemEnvironment({
    target: "host",
    connection: { connectionStatus: "online", lastError: null },
    restartJobs: [{ id: "job", target: "host", status: "pending", reason }],
  });
  const rows = [{ name: "Host" as const, ...state, onAction: vi.fn() }];
  render(<SystemView environments={rows} />);
  expect(screen.getByRole("button", { name: "Approve restart" }).textContent).toBe(
    "Approve restart",
  );
  expect(screen.getByLabelText(reason).getAttribute("data-lines")).toBe("1");
  expect(screen.getByLabelText(reason).textContent).toBe(reason);
});
