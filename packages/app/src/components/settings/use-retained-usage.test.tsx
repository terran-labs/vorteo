/** @vitest-environment jsdom */
import { renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ProviderUsage } from "@/provider-usage/types";
import { useRetainedUsage } from "./use-retained-usage";

afterEach(cleanup);
const reading = (count: number): ProviderUsage => ({
  providerId: "claude",
  displayName: "Claude",
  status: "available",
  planLabel: null,
  windows: Array.from({ length: count }, (_, i) => ({
    id: String(i),
    label: String(i),
    usedPct: 50,
  })),
});
const initial = {
  identity: "one",
  supported: true,
  valid: true,
  latest: undefined as ProviderUsage | undefined,
};
it("reserves a line before loading, grows once, and keeps its footprint through refetch", () => {
  const { result, rerender } = renderHook(useRetainedUsage, { initialProps: initial });
  expect(result.current.reservedWindows).toBe(1);
  rerender({ ...initial, latest: reading(2) });
  expect(result.current.reservedWindows).toBe(2);
  rerender(initial);
  expect(result.current.usage?.windows).toHaveLength(2);
  rerender({ ...initial, latest: reading(1) });
  expect(result.current.reservedWindows).toBe(2);
  rerender({ ...initial, latest: reading(3) });
  expect(result.current.reservedWindows).toBe(2);
  expect(result.current.usage?.windows).toHaveLength(2);
});
it.each(["signout", "error", "refreshError", "identity"])("clears stale bars on %s", (reason) => {
  const { result, rerender } = renderHook(useRetainedUsage, {
    initialProps: { ...initial, latest: reading(2) as ProviderUsage | undefined },
  });
  const next = { ...initial };
  if (reason === "signout") next.valid = false;
  if (reason === "error") next.latest = { ...reading(0), status: "error", error: "failed" };
  if (reason === "refreshError") next.latest = { ...reading(2), refreshError: "failed" };
  if (reason === "identity") next.identity = "two";
  rerender(next);
  expect(result.current.usage).toBeUndefined();
  expect(result.current.reservedWindows).toBe(reason === "identity" ? 1 : 2);
});
