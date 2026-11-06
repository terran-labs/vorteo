// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemView } from "./system-view";
import { deriveSystemEnvironment } from "./system-status-model";
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: 1280 }),
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

it("keeps a pending update unavailable and enables its retry after failure", () => {
  const onAction = vi.fn();
  const action = { kind: "update" as const, label: "Update Host" };
  const row = { name: "Host" as const, status: "attention" as const, action, onAction };
  const { rerender } = render(<SystemView environments={[row]} />);
  rerender(
    <SystemView
      environments={[
        { ...row, status: "updating", action: null, pendingAction: action, disabled: true },
      ]}
    />,
  );
  const button = screen.getByRole("button", { name: action.label }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(onAction).not.toHaveBeenCalled();
  rerender(<SystemView environments={[row]} />);
  expect((screen.getByRole("button", { name: action.label }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: action.label }));
  expect(onAction).toHaveBeenCalledWith(action);
});
