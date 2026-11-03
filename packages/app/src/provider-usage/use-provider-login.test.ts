import { QueryClient } from "@tanstack/react-query";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import { expect, it, vi } from "vitest";
import { signInUsageRefreshKey } from "./use-provider-login";
import { forceRefreshProviderUsage, providerUsageQueryKey } from "./use-provider-usage";
import type { ProviderUsageListPayload } from "./types";

function usagePayload(fetchedAt: string, providerIds: string[]): ProviderUsageListPayload {
  return {
    requestId: fetchedAt,
    fetchedAt,
    providers: providerIds.map((providerId) => ({
      providerId,
      displayName: providerId,
      status: "available",
      planLabel: null,
      windows: [{ id: "weekly", label: "Weekly", remainingPct: 80 }],
    })),
  };
}

it("refreshes usage when a sign-in completes and again when it reaches this host", () => {
  const login: ProviderLoginState = {
    status: "succeeded",
    attemptId: "attempt-1",
    accountLabel: null,
  };
  expect(
    signInUsageRefreshKey({ login: { status: "idle" }, environments: undefined, serverId: "dev" }),
  ).toBeNull();
  const completed = signInUsageRefreshKey({
    login,
    environments: [{ serverId: "dev", status: "pending" }],
    serverId: "dev",
  });
  const delivered = signInUsageRefreshKey({
    login,
    environments: [{ serverId: "dev", status: "ready" }],
    serverId: "dev",
  });
  expect(completed).toBe("attempt-1:completed");
  expect(delivered).toBe("attempt-1:delivered");
  expect(signInUsageRefreshKey({ login, environments: undefined, serverId: "dev" })).toBe(
    completed,
  );
});

it("bypasses the daemon cache and replaces the cached reading", async () => {
  const queryClient = new QueryClient();
  const queryKey = providerUsageQueryKey("host");
  queryClient.setQueryData(queryKey, usagePayload("2026-11-02T00:00:00.000Z", ["claude"]));
  const listProviderUsage = vi.fn(async () =>
    usagePayload("2026-11-02T00:00:05.000Z", ["claude", "claude-new"]),
  );

  await forceRefreshProviderUsage({ client: { listProviderUsage }, queryClient, serverId: "host" });

  expect(listProviderUsage).toHaveBeenCalledWith({ forceRefresh: true });
  const cached = queryClient.getQueryData<ProviderUsageListPayload>(queryKey);
  expect(cached?.providers.map((provider) => provider.providerId)).toEqual([
    "claude",
    "claude-new",
  ]);
});

it("records a failed forced refresh in the query state and keeps the last reading", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = providerUsageQueryKey("host");
  const previous = usagePayload("2026-11-02T00:00:00.000Z", ["claude"]);
  queryClient.setQueryData(queryKey, previous);
  const listProviderUsage = vi.fn(async () => {
    throw new Error("Timeout");
  });

  await forceRefreshProviderUsage({ client: { listProviderUsage }, queryClient, serverId: "host" });

  expect(queryClient.getQueryState(queryKey)?.status).toBe("error");
  expect(queryClient.getQueryData(queryKey)).toBe(previous);
});

it("refreshes usage once a setup-token account's upgrade to full sign-in completes", () => {
  // The upgrade flow reads no synchronization, so completion alone must produce a key.
  const pending = signInUsageRefreshKey({
    login: { status: "verifying", attemptId: "upgrade-1" },
    environments: undefined,
    serverId: "host",
  });
  const upgraded = signInUsageRefreshKey({
    login: { status: "succeeded", attemptId: "upgrade-1", accountLabel: null },
    environments: undefined,
    serverId: "host",
  });
  expect(pending).toBeNull();
  expect(upgraded).toBe("upgrade-1:completed");
  // The connection panel then reads the same attempt through the full sign-in routes, and
  // refreshes again when Host-owned access reaches this environment.
  expect(
    signInUsageRefreshKey({
      login: { status: "succeeded", attemptId: "upgrade-1", accountLabel: null },
      environments: [{ serverId: "dev", status: "ready" }],
      serverId: "dev",
    }),
  ).toBe("upgrade-1:delivered");
});
