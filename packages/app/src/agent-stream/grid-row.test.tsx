/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LayoutChangeEvent } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gridLineSignature, groupGridLines } from "./columns/geometry";
import type { GridRowTracker } from "./grid-row-tracker";
import { measureGridRows, useGridRows, useGridOrder } from "./grid-row.web";
import { CardGridContext, CardGridLayoutContext } from "./card-grid";
import { TaskCard } from "./task-card";
import { CardColumnAccessory } from "./columns/card-column";
import { RetainedPanelActivity } from "@/components/retained-panel";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const tops = new Map<Element, number>();
function placed(top: number, parent?: Element): HTMLElement {
  const node = document.createElement("div");
  tops.set(node, top);
  node.getBoundingClientRect = () => {
    const y = tops.get(node)!;
    return {
      top: y,
      bottom: y + 50,
      left: 0,
      right: 100,
      width: 100,
      height: 50,
      x: 0,
      y,
    } as DOMRect;
  };
  parent?.append(node);
  return node;
}
const layoutOf = (target: Element) =>
  ({
    nativeEvent: { layout: { x: 0, y: 0, width: 100, height: 50 }, target },
  }) as unknown as LayoutChangeEvent;

let frames: FrameRequestCallback[] = [];
let root: Root;
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // React owns this node's children, so the fake grids live beside it.
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});
const flush = () =>
  act(() => {
    const pending = frames;
    frames = [];
    pending.forEach((callback) => callback(0));
  });

it("measures nested tiles against the grid, not their layout-transparent wrapper", () => {
  const grid = placed(61, document.body);
  grid.setAttribute("data-card-grid", "");
  const wrapper = document.createElement("div");
  wrapper.style.display = "contents";
  const journal = placed(305, grid);
  grid.append(wrapper);
  const subagents = placed(305, wrapper);
  const nodes = new Map<string, Element>([
    ["journal", journal],
    ["subagents", subagents],
  ]);
  const heights = new Map([
    ["journal", 50],
    ["subagents", 50],
  ]);
  expect([...measureGridRows(nodes, heights)]).toEqual([
    ["journal", 244],
    ["subagents", 244],
  ]);
});

it("re-reads collapsed tiles that a resized sibling moved without resizing them", () => {
  const grid = placed(0, document.body);
  grid.setAttribute("data-card-grid", "");
  const tasks = placed(0, grid);
  const journal = placed(244, grid);
  const subagents = placed(344, grid);
  let tracker!: GridRowTracker;
  function Harness({ compact }: { compact: ReadonlyMap<string, number> }) {
    tracker = useGridRows(compact);
    return null;
  }
  const lines = () =>
    gridLineSignature(
      groupGridLines([...tracker.rows].map(([id, top]) => ({ id, top, height: 50 }))),
    );

  act(() => root.render(<Harness compact={new Map([["journal", 50]])} />));
  act(() => tracker.onTileLayout("journal", layoutOf(journal)));
  flush();
  expect(tracker.rows.get("journal")).toBe(244);

  // Tasks grows by 100px. Only Tasks resized, so only Tasks reports a layout.
  tops.set(journal, 344);
  act(() => tracker.onTileLayout("tasks", layoutOf(tasks)));
  // The subagents tile then appears beside Journal on the moved line.
  const both = new Map([
    ["journal", 50],
    ["subagents", 50],
  ]);
  act(() => root.render(<Harness compact={both} />));
  act(() => tracker.onTileLayout("subagents", layoutOf(subagents)));
  flush();
  expect(tracker.rows.get("journal")).toBe(344);
  expect(lines()).toBe("journal,subagents:50");
});

it("keeps the same rows while the line grouping is unchanged", () => {
  const grid = placed(0, document.body);
  grid.setAttribute("data-card-grid", "");
  const journal = placed(244, grid);
  let tracker!: GridRowTracker;
  const compact = new Map([["journal", 50]]);
  function Harness() {
    tracker = useGridRows(compact);
    return null;
  }
  act(() => root.render(<Harness />));
  act(() => tracker.onTileLayout("journal", layoutOf(journal)));
  flush();
  const measured = tracker.rows;
  tops.set(journal, 260);
  act(() => tracker.onTileLayout("journal", layoutOf(journal)));
  flush();
  expect(tracker.rows).toBe(measured);
});

it("tracks late insertion, removal and keyed moves in rendered card order", async () => {
  const grid = placed(0, document.body);
  grid.setAttribute("data-card-grid", "");
  const a = placed(0, grid);
  const expanded = placed(50, grid);
  const c = placed(100, grid);
  let tracker!: ReturnType<typeof useGridOrder>;
  function Harness() {
    tracker = useGridOrder();
    return null;
  }
  act(() => root.render(<Harness />));
  act(() => {
    tracker.onTileLayout("a", layoutOf(a));
    tracker.onTileLayout("expanded", layoutOf(expanded));
    tracker.onTileLayout("c", layoutOf(c));
  });
  flush();
  const d = placed(0);
  grid.insertBefore(d, expanded);
  act(() => tracker.onTileLayout("d", layoutOf(d)));
  flush();
  expect(tracker.order).toEqual(["a", "d", "expanded", "c"]);
  await act(async () => {
    grid.insertBefore(c, a);
  });
  flush();
  expect(tracker.order).toEqual(["c", "a", "d", "expanded"]);
  await act(async () => {
    d.remove();
  });
  flush();
  expect(tracker.order).toEqual(["c", "a", "expanded"]);
});

it("removes retained cards from grid membership while hidden and restores their current state", () => {
  const register = vi.fn();
  const forget = vi.fn();
  function Harness({ active, expanded }: { active: boolean; expanded: boolean }) {
    const layout = React.useMemo(
      () => ({ widths: new Map<string, number>(), register, forget, onTileLayout: () => {} }),
      [],
    );
    return (
      <CardGridContext value={true}>
        <CardGridLayoutContext value={layout}>
          <RetainedPanelActivity active={active}>
            <TaskCard bodyVisible={expanded}>
              <span>Retained card</span>
            </TaskCard>
          </RetainedPanelActivity>
        </CardGridLayoutContext>
      </CardGridContext>
    );
  }
  act(() => root.render(<Harness active={true} expanded={true} />));
  const id = register.mock.calls.at(-1)![0];
  expect(register).toHaveBeenLastCalledWith(id, false);
  act(() => root.render(<Harness active={false} expanded={true} />));
  expect(register).toHaveBeenLastCalledWith(id, null);
  act(() => root.render(<Harness active={false} expanded={false} />));
  expect(register).toHaveBeenLastCalledWith(id, null);
  act(() => root.render(<Harness active={true} expanded={false} />));
  expect(register).toHaveBeenLastCalledWith(id, true);
  act(() => root.render(null));
  expect(register).toHaveBeenLastCalledWith(id, null);
  expect(forget).toHaveBeenLastCalledWith(id);
});

it("treats full-width accessories as visible grid boundaries but excludes nested card bodies", () => {
  const register = vi.fn();
  const forget = vi.fn();
  function Harness({ active, inGrid }: { active: boolean; inGrid: boolean }) {
    const layout = React.useMemo(
      () => ({ widths: new Map<string, number>(), register, forget, onTileLayout: () => {} }),
      [],
    );
    return (
      <CardGridLayoutContext value={layout}>
        <CardGridContext value={inGrid}>
          <RetainedPanelActivity active={active}>
            <CardColumnAccessory>
              <span>Plugin pill</span>
            </CardColumnAccessory>
          </RetainedPanelActivity>
        </CardGridContext>
      </CardGridLayoutContext>
    );
  }
  act(() => root.render(<Harness active={true} inGrid={true} />));
  const id = register.mock.calls.at(-1)![0];
  expect(register).toHaveBeenLastCalledWith(id, false);
  act(() => root.render(<Harness active={false} inGrid={true} />));
  expect(register).toHaveBeenLastCalledWith(id, null);
  act(() => root.render(<Harness active={true} inGrid={true} />));
  expect(register).toHaveBeenLastCalledWith(id, false);
  act(() => root.render(<Harness active={true} inGrid={false} />));
  expect(register).toHaveBeenLastCalledWith(id, null);
  expect(forget).toHaveBeenLastCalledWith(id);
  register.mockClear();
  act(() => root.render(<Harness active={false} inGrid={false} />));
  act(() => root.render(null));
  expect(register).not.toHaveBeenCalled();
});
