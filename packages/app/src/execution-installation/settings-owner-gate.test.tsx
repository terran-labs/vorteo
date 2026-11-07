import { useInstallationProfiles } from "./profiles";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useInstallationSettings } from "./settings";
const owner = vi.hoisted(() => ({ status: "locked" }));
const query = vi.hoisted(() => vi.fn());
vi.mock("./owner-access", () => ({ useOwnerAccess: () => owner }));
vi.mock("./policy", () => ({
  readExecutionInstallation: () => ({ installationId: "installation" }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/data/query", () => ({ useFetchQuery: query }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each(["locked", "checking"])("disables background settings reads when %s", (status) => {
  owner.status = status;
  query.mockReturnValue({ data: undefined });
  renderHook(() => useInstallationSettings());
  expect(query.mock.lastCall?.[0].enabled).toBe(false);
});
it("enables queries immediately after owner unlock", () => {
  owner.status = "locked";
  query.mockReturnValue({ data: undefined });
  const hook = renderHook(() => useInstallationSettings());
  owner.status = "unlocked";
  hook.rerender();
  expect(query.mock.lastCall?.[0].enabled).toBe(true);
});

it.each(["locked", "checking"])("disables shared profile reads when %s", (status) => {
  owner.status = status;
  query.mockReturnValue({ data: undefined });
  renderHook(() => useInstallationProfiles());
  expect(query.mock.lastCall?.[0].enabled).toBe(false);
});
