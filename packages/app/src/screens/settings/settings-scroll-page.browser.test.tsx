import React, { act, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Text, View } from "react-native";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import {
  SettingsScrollPage,
  type SettingsPageSection,
  type SettingsScrollRequest,
} from "./settings-scroll-page";

// #639: "System needs attention" must land the Health heading at the top even when rows above it
// arrive while the jump is scrolling, as they do on a real installation. Browser anchoring cannot
// fix an animated scroll whose destination was measured before those rows arrived.

const SECTIONS: SettingsPageSection[] = [
  {
    id: "general",
    label: "General",
    panes: [{ id: "general.slow", section: "general", label: "Slow" }],
  },
  {
    id: "system",
    label: "System",
    panes: [{ id: "system.health", section: "system", label: "Health" }],
  },
];
const ANCHOR = "test-health-anchor";
const HEADING_ANCHOR = { settingsJump: "top" } as const;
const NO_RESULTS: never[] = [];
const NO_PANES = new Set<string>();
const HEADING_SPACE = { height: 1400 };
const PAGE = { height: 800 };
const noop = () => {};

function request(nonce: number, jump: boolean): SettingsScrollRequest {
  return jump
    ? {
        section: "system",
        pane: "system.health",
        entry: null,
        animated: true,
        anchorId: ANCHOR,
        focus: true,
        nonce,
      }
    : { section: "general", pane: null, entry: null, animated: false, nonce };
}

/** Rows above the target grow by `growth` px this long after each jump starts. */
function SlowRows({ nonce, growth }: { nonce: number; growth: number }) {
  const [height, setHeight] = useState(600);
  useEffect(() => {
    if (!nonce) return;
    const timer = setTimeout(() => setHeight((value) => value + growth), 150);
    return () => clearTimeout(timer);
  }, [growth, nonce]);
  const style = useMemo(() => ({ height }), [height]);
  return <View style={style} testID="slow-rows" />;
}

function Harness({ nonce }: { nonce: number }) {
  const renderPane = useCallback(
    (paneId: string) =>
      paneId === "system.health" ? (
        <View nativeID={ANCHOR} dataSet={HEADING_ANCHOR}>
          <Text testID="health-heading">Health</Text>
          <View style={HEADING_SPACE} />
        </View>
      ) : (
        <SlowRows nonce={nonce} growth={420} />
      ),
    [nonce],
  );
  const jump = useMemo(() => request(nonce, nonce > 0), [nonce]);
  return (
    <View style={PAGE}>
      <SettingsScrollPage
        sections={SECTIONS}
        renderPane={renderPane}
        request={jump}
        onActiveSectionChange={noop}
        query=""
        results={NO_RESULTS}
        matchedPanes={NO_PANES}
        selectedResult={0}
        onSelectResult={noop}
      />
    </View>
  );
}

it.each([1280, 390])(
  "lands the Health heading at the top while rows above it arrive mid-jump, at %spx",
  async (width) => {
    await page.viewport(width, 800);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.style.margin = "0";
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<Harness nonce={0} />));
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Repeated clicks: each grows the rows above again while its scroll is under way.
      for (const nonce of [1, 2, 3]) {
        act(() => root.render(<Harness nonce={nonce} />));
        await new Promise((resolve) => setTimeout(resolve, 2500));
        // The heading is fully in view at the top, and the section above it has scrolled away.
        const heading = document
          .querySelector<HTMLElement>('[data-testid="health-heading"]')!
          .getBoundingClientRect();
        const previous = document
          .getElementById("settings-section-title-general")
          ?.getBoundingClientRect();
        expect(heading.top, `click ${nonce}`).toBeGreaterThanOrEqual(0);
        expect(heading.bottom, `click ${nonce}`).toBeLessThanOrEqual(window.innerHeight / 4);
        expect(previous?.bottom ?? 0, `click ${nonce}`).toBeLessThanOrEqual(0);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);
