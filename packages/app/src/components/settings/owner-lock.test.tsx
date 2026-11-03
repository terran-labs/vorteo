/* oxlint-disable react/jsx-no-constructed-context-values, react-perf/jsx-no-new-function-as-prop -- Test sources and input mocks are intentionally recreated for each case. */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps, type ReactNode } from "react";
import {
  OwnerAccessSourceContext,
  useOwnerAccess,
  type OwnerAccess,
} from "@/execution-installation/owner-access";
import { OwnerLockBadge, OwnerLockedGroup, OwnerUnlockDialog } from "./owner-lock";

const renderedLineCounts = vi.hoisted(() => new Map<string | undefined, number | undefined>());
const windowDimensions = vi.hoisted(() => ({ fontScale: 1 }));
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    Text: (props: ComponentProps<typeof actual.Text>) => {
      renderedLineCounts.set(props.testID, props.numberOfLines);
      return <actual.Text {...props} />;
    },
    useWindowDimensions: () => ({
      width: 1000,
      height: 800,
      scale: 1,
      fontScale: windowDimensions.fontScale,
    }),
  };
});
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
afterEach(() => {
  cleanup();
  windowDimensions.fontScale = 1;
});
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
    expect(screen.queryByRole("alert")).toBeNull();
    const height = screen.getByTestId("owner-unlock-error-slot").style.minHeight;
    fireEvent.change(screen.getByLabelText("Owner password"), {
      target: { value: "wrong" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlock" })));
    expect(value.unlock).toHaveBeenCalledWith("wrong");
    expect(screen.getByTestId("owner-unlock-error").textContent).toBe("Incorrect owner password");
    expect(screen.getByTestId("owner-unlock-error-slot").style.minHeight).toBe(height);
  });
  it("makes peeked inputs inert and hidden from web accessibility", () => {
    const children = () => <input aria-label="Protected setting" />;
    render(
      wrap(access("locked"), <OwnerLockedGroup title="Providers">{children}</OwnerLockedGroup>),
    );
    fireEvent.click(screen.getByRole("button", { name: "Peek at Providers" }));
    const peek = screen.getByTestId("owner-locked-peek");
    expect(peek.hasAttribute("inert")).toBe(true);
    expect(peek.getAttribute("aria-hidden")).toBe("true");
    expect(peek.querySelector("input")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Protected setting" })).toBeNull();
  });
  it("reserves badge error space without announcing an empty alert", async () => {
    const value = access("unlocked");
    value.lock = vi.fn(async () => {
      throw new Error(
        "Could not lock settings because the server connection was interrupted. Check your connection and try again.",
      );
    });
    render(wrap(value, <OwnerLockBadge />));
    const slot = screen.getByTestId("owner-lock-error");
    const height = screen.getByTestId("owner-lock-error-slot").style.minHeight;
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Lock" })));
    expect(slot.getAttribute("aria-live")).toBe("polite");
    // The text node carries the message; no duplicate label.
    expect(slot.getAttribute("aria-label")).toBeNull();
    expect(renderedLineCounts.get("owner-lock-error")).toBe(2);
    expect(screen.getByTestId("owner-lock-error-slot").style.minHeight).toBe(height);
  });
  it("announces a source error in the dialog", () => {
    const value = access("locked");
    value.error = "Incorrect owner password";
    render(wrap(value, <OwnerUnlockDialog visible onClose={vi.fn()} />));
    expect(screen.getByTestId("owner-unlock-error").textContent).toBe(value.error);
  });
  it.each([1, 2])("reserves two error lines at font scale %s", (fontScale) => {
    windowDimensions.fontScale = fontScale;
    const message =
      "The server could not complete this request. Check the connection and try unlocking your installation again.";
    const value = access("locked");
    value.error = message;
    render(
      wrap(
        value,
        <>
          <OwnerUnlockDialog visible onClose={vi.fn()} />
          <OwnerLockBadge />
        </>,
      ),
    );
    for (const id of ["owner-unlock-error", "owner-lock-error"]) {
      expect(screen.getByTestId(`${id}-slot`).style.minHeight).toBe(
        `${14 * 1.5 * 2 * fontScale}px`,
      );
    }
    const error = screen.getByTestId("owner-unlock-error");
    expect(error.getAttribute("aria-label")).toBeNull();
    expect(error.textContent).toBe(message);
    expect(error.getAttribute("aria-live")).toBe("polite");
    expect(renderedLineCounts.get("owner-unlock-error")).toBe(2);
    expect(screen.getByTestId("owner-lock-error").hasAttribute("aria-live")).toBe(false);
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
