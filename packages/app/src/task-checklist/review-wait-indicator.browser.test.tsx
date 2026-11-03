import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { TodoEntry } from "@/types/stream";
import { ReviewWaitIndicator } from "./review-wait-indicator";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await page.viewport(640, 360);
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.padding = "24px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// The icon stub draws nothing, so the slot carries its own size.
const SLOT = { width: 16, height: 16 };
const merge: TodoEntry = {
  id: "merge",
  text: "Builds merges and publishes the change",
  completed: false,
  status: "review",
  owner: "Vorteo :: Builds",
  description: "Waiting for Builds to merge into main and publish the interface.",
};

const TASKS = [merge];

test("labels the wait and shows the waited-on item's details on hover", async () => {
  act(() => root.render(<ReviewWaitIndicator tasks={TASKS} slotStyle={SLOT} />));
  const indicator = page.getByTestId("workspace-status-indicator-review");
  await expect.element(indicator).toBeVisible();
  await expect
    .element(indicator)
    .toHaveAccessibleName("Waiting on Vorteo :: Builds: Builds merges and publishes the change");
  await indicator.hover();
  await expect
    .element(page.getByText("Waiting on Vorteo :: Builds", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("Waiting for Builds to merge into main and publish the interface."))
    .toBeVisible();
});
