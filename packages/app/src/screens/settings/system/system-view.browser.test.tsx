import React, { act, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { SystemView, type SystemEnvironmentRow } from "./system-view";
const noop = () => {};
const details = <span>Runtime details</span>;
const menu = <span>More</span>;
function Harness({ updating }: { updating: boolean }) {
  const rows = useMemo<SystemEnvironmentRow[]>(
    () => [
      {
        name: "Host",
        status: updating ? "updating" : "attention",
        action: updating ? null : { kind: "approve-restart", label: "Approve restart" },
        reason:
          "A long restart reason that should be clipped without widening the environment row or hiding its menu",
        onAction: noop,
        restartMenu: menu,
        details,
      },
    ],
    [updating],
  );
  return (
    <SystemView
      environments={rows}
      services={updating ? null : "attention"}
      servicesReason={
        updating
          ? undefined
          : "A service needs attention. Review its current status before continuing."
      }
    />
  );
}
it.each([390, 1280])(
  "keeps rows within the pane and preserves page height through polls at %spx",
  async (width) => {
    await page.viewport(width, 900);
    const container = document.createElement("div");
    container.style.cssText = "width:100%;max-width:720px;padding:16px;box-sizing:border-box";
    document.body.style.margin = "0";
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<Harness updating={false} />));
      // React Native Web delivers measured layout through ResizeObserver after paint.
      await act(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      const height = container.getBoundingClientRect().height;
      expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
      const button = page.getByRole("button", { name: "Approve restart", exact: true });
      await expect.element(button).toBeVisible();
      expect(button.element().getBoundingClientRect().right).toBeLessThanOrEqual(
        container.getBoundingClientRect().right,
      );
      act(() => root.render(<Harness updating />));
      expect(container.getBoundingClientRect().height).toBe(height);
      await page.getByRole("button", { name: "Host Details" }).click();
      await expect.element(page.getByText("Runtime details")).toBeVisible();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);

// Every label must take its color from the theme. Unstyled text falls back to React Native
// Web's default black (or inherits its surroundings), which rendered System nearly invisible
// in dark mode. Neither fallback is a theme color, so any label showing one has no theme color
// of its own; theme.test.ts separately checks the theme's text contrast in every theme.
it("gives every System label its own theme color", async () => {
  await page.viewport(1280, 900);
  const container = document.createElement("div");
  container.style.color = "rgb(1, 2, 3)";
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<Harness updating={false} />));
    await expect.element(page.getByText("Host", { exact: true })).toBeVisible();
    const texts = [...container.querySelectorAll("div[dir], span")].filter(
      (element) =>
        element.childElementCount === 0 &&
        (element.textContent ?? "").trim() !== "" &&
        !["Runtime details", "More"].includes(element.textContent ?? ""),
    );
    expect(texts.length).toBeGreaterThan(0);
    const inherited = texts
      .filter((element) =>
        ["rgb(1, 2, 3)", "rgb(0, 0, 0)"].includes(getComputedStyle(element).color),
      )
      .map((element) => element.textContent);
    expect(inherited).toEqual([]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
