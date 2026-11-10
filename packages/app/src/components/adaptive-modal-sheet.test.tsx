/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Text } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import * as layout from "@/constants/layout";
import { AdaptiveModalSheet, SheetBottomInset } from "./adaptive-modal-sheet";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const GUIDE_HEADER = { title: "Set up Vorteo" };
const SCREEN_INSETS = { top: 24, right: 0, bottom: 34, left: 0 };

function BottomInsetProbe() {
  return <Text testID="content-bottom-inset">{String(useSafeAreaInsets().bottom)}</Text>;
}

describe("SheetBottomInset", () => {
  it("pads the bottom inset once and leaves none for its content", () => {
    render(
      <SafeAreaInsetsContext.Provider value={SCREEN_INSETS}>
        <SheetBottomInset testID="sheet-body">
          <BottomInsetProbe />
        </SheetBottomInset>
      </SafeAreaInsetsContext.Provider>,
    );

    expect(screen.getByTestId("sheet-body").style.paddingBottom).toBe("34px");
    // Content that pads the inset itself, like the composer dock, must not pad it again.
    expect(screen.getByTestId("content-bottom-inset").textContent).toBe("0");
  });
});

it("names the setup dialog without changing its close or reopen behavior", async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(layout, "useIsCompactFormFactor").mockReturnValue(false);
  const close = vi.fn();
  function sheet(visible: boolean) {
    return (
      <SafeAreaInsetsContext.Provider value={SCREEN_INSETS}>
        <AdaptiveModalSheet
          visible={visible}
          onClose={close}
          header={GUIDE_HEADER}
          accessibilityLabel="Set up Vorteo"
        >
          <Text>Guide content</Text>
        </AdaptiveModalSheet>
      </SafeAreaInsetsContext.Provider>
    );
  }
  const view = render(sheet(true));
  expect(screen.getByRole("dialog", { name: "Set up Vorteo" }).textContent).toContain(
    "Guide content",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledTimes(1);
  view.rerender(sheet(false));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Set up Vorteo" })).toBeNull());
  view.rerender(sheet(true));
  expect(screen.getByRole("dialog", { name: "Set up Vorteo" }).textContent).toContain(
    "Guide content",
  );
  view.unmount();
});
