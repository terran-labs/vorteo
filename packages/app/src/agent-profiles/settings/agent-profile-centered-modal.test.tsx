// @vitest-environment jsdom
import { useCallback, type ReactNode, type ChangeEvent } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentProfileFormModel, AgentProfileFormState } from "../internal/profile-form-model";
import { NavigationContext } from "expo-router/react-navigation";
import { AgentProfileCenteredModal } from "./agent-profile-page";
const mocks = vi.hoisted(() => ({
  show: vi.fn(),
  dispatch: vi.fn(),
  listener: undefined as
    | undefined
    | ((event: { preventDefault: () => void; data: { action: string } }) => void),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("expo-router/react-navigation", async () => {
  const { createContext } = await import("react");
  return {
    NavigationContext: createContext<unknown>({
      addListener: (_name: string, listener: typeof mocks.listener) => {
        mocks.listener = listener;
        return () => {};
      },
      dispatch: mocks.dispatch,
    }),
  };
});
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: mocks.show }) }));
vi.mock("@/execution-installation/policy", () => ({ readExecutionInstallation: () => null }));
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
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    footer,
    onClose,
  }: {
    children: ReactNode;
    footer: ReactNode;
    onClose: () => void;
  }) => (
    <section>
      <button type="button" onClick={onClose}>
        Dismiss editor
      </button>
      {children}
      {footer}
    </section>
  ),
}));
vi.mock("./agent-profile-form", () => ({
  AgentProfileForm: ({
    model,
    state,
  }: {
    model: AgentProfileFormModel;
    state: AgentProfileFormState;
  }) => {
    const change = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => model.setName(event.target.value),
      [model],
    );
    return <input aria-label="Name" value={state.name} onChange={change} />;
  },
}));
const profile = { id: "profile", name: "Test", provider: "mock" };
const save = vi.fn();
const close = vi.fn();
const remove = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listener = undefined;
  vi.spyOn(window, "confirm").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function openEditor() {
  render(
    <AgentProfileCenteredModal
      serverId="host"
      profile={profile}
      onSave={save}
      onBack={close}
      onDelete={remove}
    />,
  );
}
it("requires deletion confirmation and closes only after deletion succeeds", async () => {
  openEditor();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Unsaved name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
  expect(remove).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  vi.mocked(window.confirm).mockReturnValue(true);
  remove.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(remove).toHaveBeenCalledOnce();
  expect(window.confirm).toHaveBeenLastCalledWith("Delete profile Test?");
  expect(window.confirm).toHaveBeenCalledTimes(2);
});
it("protects dirty drafts on Cancel, dismissal, and route navigation", () => {
  openEditor();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss editor" }));
  const preventDefault = vi.fn();
  mocks.listener!({ preventDefault, data: { action: "leave" } });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Draft");
  expect(window.confirm).toHaveBeenCalledTimes(3);
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
});
it("keeps a dirty draft open and reports a failed deletion", async () => {
  openEditor();
  vi.mocked(window.confirm).mockReturnValue(true);
  remove.mockRejectedValueOnce(new Error("Delete failed"));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
  await waitFor(() => expect(mocks.show).toHaveBeenCalledWith("Delete failed"));
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Draft");
});

it("opens outside any navigator, as the composer's centered window does, without crashing", () => {
  render(
    <NavigationContext.Provider value={undefined}>
      <AgentProfileCenteredModal
        serverId="host"
        profile={profile}
        onSave={save}
        onBack={close}
        onDelete={remove}
      />
    </NavigationContext.Provider>,
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
});
