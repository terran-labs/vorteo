/**
 * @vitest-environment jsdom
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_FORM_PREFERENCES } from "@/create-agent-preferences/preferences";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentControlTrigger } from "./control";
import { ThreadChromeSwitch } from "./thread-chrome-switch";

vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: vi.fn() }) }));

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  cancelAnimation: vi.fn(),
  withRepeat: (value: number) => value,
  withTiming: (value: number) => value,
  Easing: { linear: (value: number) => value },
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}));
// The native menu adapter is outside this permission test. Exercise the real choice handler.
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({
    open,
    options,
    onSelect,
  }: {
    open: boolean;
    options: { id: string; label: string }[];
    onSelect: (value: string) => void;
  }) => {
    const handleSelect = React.useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => onSelect(event.currentTarget.value),
      [onSelect],
    );
    return open
      ? options.map((option) => (
          <button key={option.id} type="button" value={option.id} onClick={handleSelect}>
            {option.label}
          </button>
        ))
      : null;
  },
}));

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("React", React);
  client = new QueryClient();
  client.setQueryData(["form-preferences"], DEFAULT_FORM_PREFERENCES);
});
afterEach(() => {
  cleanup();
  client.clear();
});

function TestIcon() {
  return null;
}

describe("AgentControlTrigger", () => {
  it("forwards interaction handlers to the rendered trigger", () => {
    const onPointerEnter = vi.fn();
    const onFocus = vi.fn();
    const onPress = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <AgentControlTrigger
          icon={TestIcon}
          surface="toolbar"
          label="Mode"
          onPress={onPress}
          onPointerEnter={onPointerEnter}
          onFocus={onFocus}
          accessibilityLabel="Select mode"
        />
      </QueryClientProvider>,
    );
    const trigger = view.getByRole("button", { name: "Select mode" });

    fireEvent.pointerEnter(trigger);
    fireEvent.focus(trigger);

    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});

it.each([false, true])(
  "opens browser choices without changing thread permission (enabled=%s)",
  (enabled) => {
    const setFeature = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <ThreadChromeSwitch
          visible
          features={[{ id: "chrome", type: "toggle", label: "Browser", value: enabled }]}
          disabled={false}
          setFeature={setFeature}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(view.getByTestId("thread-chrome-switch"));
    expect(setFeature).not.toHaveBeenCalled();
    expect(view.getByText("Browser enabled")).toBeTruthy();
    expect(view.getByText("Browser disabled")).toBeTruthy();
    fireEvent.click(view.getByText(enabled ? "Browser enabled" : "Browser disabled"));
    expect(setFeature).not.toHaveBeenCalled();
    fireEvent.click(view.getByTestId("thread-chrome-switch"));
    fireEvent.click(view.getByText(enabled ? "Browser disabled" : "Browser enabled"));
    expect(setFeature).toHaveBeenCalledWith("chrome", !enabled);
  },
);
