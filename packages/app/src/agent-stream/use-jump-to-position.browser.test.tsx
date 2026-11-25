import React, { act, useImperativeHandle, forwardRef, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "./strategy";
import { useJumpToPosition, type JumpOutcome, type JumpTarget } from "./use-jump-to-position";

const fetchAgentTimeline = vi.fn();
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ fetchAgentTimeline }),
}));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => fetchAgentTimeline.mockReset());

const item = (id: string, seq: number, epoch = "e1") =>
  ({ id, timelineCursor: { epoch, seq } }) as unknown as StreamItem;

// What the jump did, recorded by the harness below.
const scrolled: string[] = [];
const outcomes: JumpOutcome[] = [];
// Only scrollToMessage is used by the jump.
const viewportRef = {
  current: {
    scrollToMessage: (id: string) => scrolled.push(id),
  } as unknown as StreamViewportHandle,
};
const jumpRef: { current: ((target: JumpTarget) => void) | null } = { current: null };
function recordOutcome(outcome: JumpOutcome) {
  outcomes.push(outcome);
}
const TAIL = [item("live", 100), item("live-2", 110)];

interface HarnessProps {
  head: StreamItem[];
}

const Harness = forwardRef(function Harness(
  props: HarnessProps,
  ref: Ref<(target: JumpTarget) => void>,
) {
  const { jump } = useJumpToPosition({
    agentId: "lead",
    serverId: "host",
    timelineEpoch: "e1",
    tail: TAIL,
    head: props.head,
    viewportRef,
    onOutcome: recordOutcome,
    onError: () => undefined,
  });
  useImperativeHandle(ref, () => jump, [jump]);
  return null;
});

// #660 review: older history ends at 30 and the live tail starts at 100, so a question asked at
// 42 sits in an unloaded gap. The jump must fetch, wait for the fetched items however slowly they
// render, never match another epoch, and stop when the reader scrolls first.
test("a jump into unloaded history fetches, waits for the render and lands once", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const olderHead = [item("old", 20), item("older-end", 30)];
  const render = (head: StreamItem[]) =>
    act(() => root.render(<Harness ref={jumpRef} head={head} />));

  try {
    let resolveFetch: (page: unknown) => void = () => undefined;
    fetchAgentTimeline.mockReturnValueOnce(new Promise((resolve) => (resolveFetch = resolve)));
    render(olderHead);
    act(() => jumpRef.current!({ epoch: "e1", seq: 42 }));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);
    expect(scrolled).toEqual([]);

    // The fetched window covers 42, but its items render well after the old 2 s grace.
    await act(async () => resolveFetch({ epoch: "e1", entries: [{ seqStart: 35 }] }));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(outcomes).toEqual([]);
    render([...olderHead, item("asked", 41), item("next", 45)]);
    expect(scrolled).toEqual(["asked"]);
    expect(outcomes).toEqual(["scrolled"]);

    // A position from an earlier epoch never matches an item of this one.
    act(() => jumpRef.current!({ epoch: "e0", seq: 41 }));
    expect(outcomes).toEqual(["scrolled", "missing"]);
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);

    // The reader scrolls while older history loads: the jump is cancelled and does not land.
    let resolveSecond: (page: unknown) => void = () => undefined;
    fetchAgentTimeline.mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));
    act(() => jumpRef.current!({ epoch: "e1", seq: 15 }));
    act(() => {
      window.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    await act(async () => resolveSecond({ epoch: "e1", entries: [{ seqStart: 5 }] }));
    render([item("early", 14), item("early-next", 16), ...olderHead]);
    expect(scrolled).toEqual(["asked"]);
    expect(outcomes).toEqual(["scrolled", "missing", "cancelled"]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
