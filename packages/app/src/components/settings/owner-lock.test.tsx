/* oxlint-disable react/jsx-no-constructed-context-values, react-perf/jsx-no-new-function-as-prop -- Test sources and input mocks are intentionally recreated for each case. */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import {
  OwnerAccessSourceContext,
  useOwnerAccess,
  type OwnerAccess,
} from "@/execution-installation/owner-access";
import { OwnerLockBadge, OwnerLockedGroup, OwnerUnlockDialog } from "./owner-lock";

vi.mock("@/execution-installation/panel", () => ({
  useInstallationOwnerClient: () => null,
}));
vi.mock("@/execution-installation/policy", () => ({
  readExecutionInstallation: () => null,
}));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@/components/ui/form-field", () => ({
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FormTextInput: ({ onChangeText }: { onChangeText(value: string): void }) => (
    <input aria-label="Owner password" onChange={(event) => onChangeText(event.target.value)} />
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress(): void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock(".", () => ({
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ label, children }: { label: string; children: ReactNode }) => (
    <div>
      {label}
      {children}
    </div>
  ),
}));
vi.mock("lucide-react-native", () => ({ Lock: () => <span /> }));
afterEach(cleanup);
function access(status: OwnerAccess["status"]): OwnerAccess {
  return {
    status,
    busy: false,
    error: null,
    unlock: vi.fn(async () => {}),
    lock: vi.fn(async () => {}),
  };
}
function wrap(value: OwnerAccess, node: ReactNode) {
  return (
    <OwnerAccessSourceContext.Provider value={() => value}>
      {node}
    </OwnerAccessSourceContext.Provider>
  );
}
describe("owner access controls", () => {
  it.each(["locked", "checking"] as const)(
    "does not evaluate protected children while %s",
    (status) => {
      const children = vi.fn(() => <div>Protected</div>);
      render(
        wrap(access(status), <OwnerLockedGroup title="Providers">{children}</OwnerLockedGroup>),
      );
      expect(children).not.toHaveBeenCalled();
      if (status === "locked") {
        fireEvent.click(screen.getByRole("button", { name: "Peek at Providers" }));
        expect(children).toHaveBeenCalledWith({ disabled: true });
      }
    },
  );
  it.each(["none", "unlocked"] as const)("renders protected children when %s", (status) => {
    const children = vi.fn(() => <div>Protected</div>);
    render(wrap(access(status), <OwnerLockedGroup title="Providers">{children}</OwnerLockedGroup>));
    expect(children).toHaveBeenCalledWith({ disabled: false });
  });
  it("keeps badge dimensions across access states", () => {
    const result = render(wrap(access("locked"), <OwnerLockBadge />));
    const dimensions = () => {
      const badge = screen.getByTestId("owner-lock-badge");
      return [badge.style.width, badge.style.height];
    };
    const initial = dimensions();
    expect(initial).toEqual(["224px", "44px"]);
    for (const status of ["checking", "unlocked"] as const) {
      result.rerender(wrap(access(status), <OwnerLockBadge />));
      expect(screen.getByText(status === "checking" ? "Checking" : "Unlocked")).toBeTruthy();
      expect(dimensions()).toEqual(initial);
    }
  });
  it("shows a rejected password in the reserved dialog error line", async () => {
    const value = access("locked");
    value.unlock = vi.fn(async () => {
      throw new Error("Incorrect owner password");
    });
    render(wrap(value, <OwnerUnlockDialog visible onClose={vi.fn()} />));
    const height = screen.getByRole("alert").style.height;
    fireEvent.change(screen.getByLabelText("Owner password"), {
      target: { value: "wrong" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlock" })));
    expect(value.unlock).toHaveBeenCalledWith("wrong");
    expect(screen.getByRole("alert").textContent).toBe("Incorrect owner password");
    expect(screen.getByRole("alert").style.height).toBe(height);
  });
  it("subscribes through an injectable hook source", () => {
    let update: (value: OwnerAccess) => void = () => {};
    function useFakeSource() {
      const [value, setValue] = useState(access("checking"));
      update = setValue;
      return value;
    }
    function Probe() {
      return <span>{useOwnerAccess().status}</span>;
    }
    render(
      <OwnerAccessSourceContext.Provider value={useFakeSource}>
        <Probe />
      </OwnerAccessSourceContext.Provider>,
    );
    expect(screen.getByText("checking")).toBeTruthy();
    act(() => update(access("unlocked")));
    expect(screen.getByText("unlocked")).toBeTruthy();
  });
});
