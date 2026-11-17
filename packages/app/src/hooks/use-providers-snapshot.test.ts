/** @vitest-environment jsdom */
import React, { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { i18n } from "@/i18n/i18next";
import { EnvironmentAccounts } from "@/onboarding/vorteo-guide/environment-accounts";
import {
  createVorteoGuide,
  guideProviderSignedIn,
  refreshGuideProviderSnapshot,
} from "@/onboarding/vorteo-guide/model";
import * as providerHooks from "./use-providers-snapshot";
import * as hostRuntime from "@/runtime/host-runtime";
import * as providerUsage from "@/provider-usage/use-provider-usage";
import * as providerLogin from "@/provider-usage/use-provider-login";
import { usePrimaryConnection } from "@/execution-installation/primary-connection";
import * as hostFeatures from "@/runtime/host-features";
import * as directoryDemand from "./use-directory-demand";
import { QueryClientProvider, QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  compactProviderSnapshot,
  expandProviderSnapshot,
} from "@getpaseo/protocol/provider-snapshot-codec";
import type { CachedProviderSnapshot, ProviderSnapshotCache } from "@/data/provider-snapshot-cache";
import { draftAgentCommandsQueryKey, sessionAgentCommandsQueryKey } from "@/agent-commands/cache";
import { providerSnapshotIcons } from "@/data/provider-icons";
import { applyProvidersSnapshotUpdate, type ProvidersSnapshotUpdate } from "@/data/push-router";
import {
  fetchProvidersSnapshot,
  providersSnapshotQueryKey,
  refreshAndApplyProvidersSnapshot,
  selectorOpenRefetchDecision,
  type ProvidersSnapshotClient,
} from "./use-providers-snapshot";

type GetProvidersSnapshotResult = Awaited<ReturnType<DaemonClient["getProvidersSnapshot"]>>;
type RefreshProvidersSnapshotResult = Awaited<ReturnType<DaemonClient["refreshProvidersSnapshot"]>>;
type GetProvidersSnapshotOptions = Parameters<DaemonClient["getProvidersSnapshot"]>[0];
type RefreshProvidersSnapshotOptions = Parameters<DaemonClient["refreshProvidersSnapshot"]>[0];

interface FakeProvidersSnapshotClient extends ProvidersSnapshotClient {
  getCalls: GetProvidersSnapshotOptions[];
  refreshCalls: RefreshProvidersSnapshotOptions[];
}

function createClient(
  input: {
    snapshots?: GetProvidersSnapshotResult[];
    refreshResult?: RefreshProvidersSnapshotResult;
  } = {},
): FakeProvidersSnapshotClient {
  const snapshots = [...(input.snapshots ?? [])];
  const refreshResult: RefreshProvidersSnapshotResult = input.refreshResult ?? {
    acknowledged: true,
    requestId: "refresh-1",
  };

  const getCalls: GetProvidersSnapshotOptions[] = [];
  const refreshCalls: RefreshProvidersSnapshotOptions[] = [];

  return {
    getCalls,
    refreshCalls,
    async getProvidersSnapshot(options) {
      getCalls.push(options ?? {});
      const next = snapshots.shift();
      if (!next) {
        throw new Error("No snapshot configured for getProvidersSnapshot call");
      }
      return next;
    },
    async refreshProvidersSnapshot(options) {
      refreshCalls.push(options ?? {});
      return refreshResult;
    },
  };
}

function providersSnapshot(entries: ProviderSnapshotEntry[]): GetProvidersSnapshotResult {
  return {
    entries,
    generatedAt: "2026-01-01T00:00:00.000Z",
    requestId: "snapshot",
  };
}

function codexEntry(
  status: ProviderSnapshotEntry["status"],
  models?: ProviderSnapshotEntry["models"],
): ProviderSnapshotEntry {
  return {
    provider: "codex",
    status,
    enabled: true,
    ...(models ? { models } : {}),
  };
}

const readyCodexModel = { provider: "codex", id: "gpt-5.4", label: "GPT-5.4" } as const;
const serverId = "server-1";

function createCache(
  initial: CachedProviderSnapshot | null = null,
  bodyResident = true,
): ProviderSnapshotCache & {
  writes: Parameters<ProviderSnapshotCache["write"]>[0][];
} {
  const writes: Parameters<ProviderSnapshotCache["write"]>[0][] = [];
  return {
    writes,
    async readHash(_serverId, hash) {
      return bodyResident && initial?.hash === hash ? initial : null;
    },
    async materialize(_serverId, snapshot) {
      if (initial && initial.hash === snapshot.snapshotHash)
        return { ...snapshot, entries: initial.entries };
      return {
        ...snapshot,
        entries: snapshot.compactSnapshot
          ? expandProviderSnapshot(snapshot.compactSnapshot)
          : snapshot.entries,
      };
    },
    async read() {
      return initial;
    },
    async write(input) {
      writes.push(input);
    },
  };
}

describe("providersSnapshotQueryKey", () => {
  it("uses separate keys for home and workspace scopes", async () => {
    expect(providersSnapshotQueryKey(serverId)).toEqual(["providersSnapshot", serverId, "home"]);
    expect(providersSnapshotQueryKey(serverId, "/repo-a")).toEqual([
      "providersSnapshot",
      serverId,
      "cwd",
      "/repo-a",
    ]);
  });
});

describe("fetchProvidersSnapshot", () => {
  it("registers provider icons from the applied snapshot", async () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';
    const client = createClient({
      snapshots: [
        providersSnapshot([
          { provider: "snapshot-icon-provider", status: "ready", enabled: true, iconSvg: svg },
        ]),
      ],
    });

    await fetchProvidersSnapshot({ client, serverId, cwd: null, cache: createCache() });

    expect(providerSnapshotIcons.getState().get(serverId)?.get("snapshot-icon-provider")).toEqual(
      svg,
    );
  });

  it("sends no cwd for the home scope", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });

    await fetchProvidersSnapshot({ client, serverId, cwd: null, cache: createCache() });

    expect(client.getCalls).toEqual([{}]);
  });

  it("sends the workspace cwd for the workspace scope", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });

    await fetchProvidersSnapshot({
      client,
      serverId,
      cwd: "/repo-a",
      cache: createCache(),
    });

    expect(client.getCalls).toEqual([{ cwd: "/repo-a" }]);
  });

  it("reuses a not-modified response even if its body was evicted during the request", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const compactSnapshot = compactProviderSnapshot(entries);
    const cache = createCache(
      {
        version: 2,
        hash: "snapshot-hash",
        generatedAt: "2026-01-01T00:00:00.000Z",
        compactSnapshot,
        entries,
      },
      false,
    );
    const client = createClient({
      snapshots: [
        {
          entries: [],
          snapshotHash: "snapshot-hash",
          notModified: true,
          generatedAt: "2026-01-02T00:00:00.000Z",
          requestId: "snapshot-2",
        },
      ],
    });

    const snapshot = await fetchProvidersSnapshot({
      client,
      serverId,
      cwd: "/repo-a",
      cache,
    });

    expect(client.getCalls).toEqual([{ cwd: "/repo-a", ifNoneMatch: "snapshot-hash" }]);
    expect(snapshot.entries).toBe(entries);
    expect(cache.writes).toHaveLength(1);
  });

  it("persists a changed compact snapshot for the next launch", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const compactSnapshot = compactProviderSnapshot(entries);
    const cache = createCache();
    const client = createClient({
      snapshots: [
        {
          entries,
          compactSnapshot,
          snapshotHash: "next-hash",
          generatedAt: "2026-01-02T00:00:00.000Z",
          requestId: "snapshot-2",
        },
      ],
    });

    await fetchProvidersSnapshot({ client, serverId, cwd: "/repo-a", cache });

    expect(cache.writes.map(({ signal: _signal, ...write }) => write)).toEqual([
      {
        serverId,
        cwd: "/repo-a",
        hash: "next-hash",
        generatedAt: "2026-01-02T00:00:00.000Z",
        compactSnapshot,
      },
    ]);
  });
});

describe("refreshAndApplyProvidersSnapshot", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it("refreshes then re-fetches the home snapshot and writes it into the home query cache", async () => {
    const client = createClient({
      snapshots: [providersSnapshot([codexEntry("ready", [readyCodexModel])])],
    });

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: null,
      providers: ["codex"],
      cache: createCache(),
    });

    expect(client.refreshCalls).toEqual([{ providers: ["codex"] }]);
    expect(client.getCalls).toEqual([{}]);
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual(
      providersSnapshot([codexEntry("ready", [readyCodexModel])]),
    );
  });

  it("refreshes then re-fetches the workspace snapshot with the cwd preserved", async () => {
    const client = createClient({
      snapshots: [providersSnapshot([codexEntry("ready", [readyCodexModel])])],
    });

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: "/repo-a",
      providers: ["codex"],
      cache: createCache(),
    });

    expect(client.refreshCalls).toEqual([{ cwd: "/repo-a", providers: ["codex"] }]);
    expect(client.getCalls).toEqual([{ cwd: "/repo-a" }]);
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId, "/repo-a"))).toEqual(
      providersSnapshot([codexEntry("ready", [readyCodexModel])]),
    );
  });

  it("invalidates every scope under the server when refreshing the home snapshot", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });
    queryClient.setQueryData(providersSnapshotQueryKey(serverId, "/repo-a"), providersSnapshot([]));
    queryClient.setQueryData(providersSnapshotQueryKey(serverId, "/repo-b"), providersSnapshot([]));

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: null,
      cache: createCache(),
    });

    expect(
      queryClient.getQueryState(providersSnapshotQueryKey(serverId, "/repo-a"))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(providersSnapshotQueryKey(serverId, "/repo-b"))?.isInvalidated,
    ).toBe(true);
  });

  it("does not invalidate sibling scopes when refreshing a workspace snapshot", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });
    queryClient.setQueryData(providersSnapshotQueryKey(serverId), providersSnapshot([]));
    queryClient.setQueryData(providersSnapshotQueryKey(serverId, "/repo-b"), providersSnapshot([]));

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: "/repo-a",
      cache: createCache(),
    });

    expect(queryClient.getQueryState(providersSnapshotQueryKey(serverId))?.isInvalidated).toBe(
      false,
    );
    expect(
      queryClient.getQueryState(providersSnapshotQueryKey(serverId, "/repo-b"))?.isInvalidated,
    ).toBe(false);
  });

  it("invalidates cached agent commands when refreshing providers", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });
    const commandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd: "/repo-a" },
    });
    queryClient.setQueryData(commandsKey, [{ name: "compact", description: "", argumentHint: "" }]);

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cwd: "/repo-a",
      cache: createCache(),
    });

    expect(queryClient.getQueryState(commandsKey)?.isInvalidated).toBe(true);
  });
});

describe("applyProvidersSnapshotUpdate", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  function updateMessage(entries: ProviderSnapshotEntry[], cwd?: string): ProvidersSnapshotUpdate {
    return {
      type: "providers_snapshot_update",
      payload: {
        ...(cwd ? { cwd } : {}),
        entries,
        generatedAt: "2026-01-01T00:00:01.000Z",
      },
    };
  }

  it("refreshes active commands only when their provider changes after discovery", async () => {
    const key = sessionAgentCommandsQueryKey({ serverId, agentId: "agent-1" });
    let requests = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => {
        requests++;
        return [{ name: "review" }];
      },
      staleTime: Infinity,
      meta: { agentCommandProvider: "codex", agentCommandCwd: "/repo-a" },
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch({ cancelRefetch: false });
    expect(requests).toBe(1);
    const codex = codexEntry("ready", [readyCodexModel]);
    const other = { provider: "claude", status: "loading", enabled: true } as ProviderSnapshotEntry;
    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("loading"), other], "/repo-a"),
    });
    expect(requests).toBe(1);
    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codex, other], "/repo-a"),
    });
    expect(requests).toBe(1);
    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codex, { ...other, status: "ready" }], "/repo-a"),
    });
    expect(requests).toBe(1);
    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage(
        [
          { ...codex, fetchedAt: "2026-01-01T00:00:02.000Z" },
          { ...other, status: "ready" },
        ],
        "/repo-a",
      ),
    });
    expect(requests).toBe(1);
    queryClient.setQueryData(
      providersSnapshotQueryKey(serverId, "/repo-b"),
      providersSnapshot([codex]),
    );
    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage(
        [codexEntry("ready", [{ ...readyCodexModel, label: "Other checkout" }])],
        "/repo-b",
      ),
    });
    expect(requests).toBe(1);
    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage(
        [
          codexEntry("ready", [{ ...readyCodexModel, label: "Updated" }]),
          { ...other, status: "ready" },
        ],
        "/repo-a",
      ),
    });
    await observer.refetch({ cancelRefetch: false });
    expect(requests).toBe(2);
    unsubscribe();
    queryClient.clear();
  });

  it("retries a failed command discovery when its provider first becomes ready", async () => {
    const key = sessionAgentCommandsQueryKey({ serverId, agentId: "agent-1" });
    let ready = false;
    let requests = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => {
        requests++;
        if (!ready) throw new Error("provider unavailable");
        return [{ name: "review" }];
      },
      retry: false,
      meta: { agentCommandProvider: "codex", agentCommandCwd: "/repo-a" },
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch({ cancelRefetch: false });
    expect(observer.getCurrentResult().isError).toBe(true);
    ready = true;
    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], "/repo-a"),
    });
    await observer.refetch({ cancelRefetch: false });
    expect(requests).toBe(2);
    expect(observer.getCurrentResult().data).toEqual([{ name: "review" }]);
    unsubscribe();
    queryClient.clear();
  });

  it("refreshes again when its provider changes during an active refresh", async () => {
    const key = sessionAgentCommandsQueryKey({ serverId, agentId: "agent-1" });
    queryClient.setQueryData(key, [{ name: "old" }]);
    let requests = 0;
    const waiting = new Promise<{ name: string }[]>(() => {});
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => (++requests === 1 ? waiting : [{ name: "new" }]),
      staleTime: Infinity,
      meta: { agentCommandProvider: "codex", agentCommandCwd: "/repo-a" },
    });
    const unsubscribe = observer.subscribe(() => {});
    queryClient.setQueryData(
      providersSnapshotQueryKey(serverId, "/repo-a"),
      providersSnapshot([codexEntry("ready", [readyCodexModel])]),
    );
    const send = (label: string) =>
      applyProvidersSnapshotUpdate({
        client: createClient(),
        serverId,
        queryClient,
        message: updateMessage([codexEntry("ready", [{ ...readyCodexModel, label }])], "/repo-a"),
      });
    await send("First change");
    expect(requests).toBe(1);
    await send("Second change");
    expect(requests).toBe(2);
    await observer.refetch({ cancelRefetch: false });
    expect(observer.getCurrentResult().data).toEqual([{ name: "new" }]);
    unsubscribe();
    queryClient.clear();
  });

  it("routes updates to the home query cache when the message carries no cwd", async () => {
    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])]),
    });

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
  });

  it("routes workspace updates to the matching scope without touching siblings", async () => {
    queryClient.setQueryData(providersSnapshotQueryKey(serverId, "/repo-b"), providersSnapshot([]));

    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], "/repo-a"),
    });

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId, "/repo-a"))).toMatchObject({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId, "/repo-b"))).toEqual(
      providersSnapshot([]),
    );
  });

  it("persists compact push updates", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const compactSnapshot = compactProviderSnapshot(entries);
    const cache = createCache();
    const message = updateMessage(entries, "/repo-a");
    message.payload.compactSnapshot = compactSnapshot;
    message.payload.snapshotHash = "push-hash";

    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message,
      cache,
    });

    expect(cache.writes.map(({ signal: _signal, ...write }) => write)).toEqual([
      {
        serverId,
        cwd: "/repo-a",
        hash: "push-hash",
        generatedAt: "2026-01-01T00:00:01.000Z",
        compactSnapshot,
      },
    ]);
  });

  it("applies Windows daemon updates to app-normalized workspace paths", async () => {
    const workspaceCwd = "C:/Users/Ezekiel Bulver/project";
    const daemonCwd = "C:\\Users\\Ezekiel Bulver\\project";
    queryClient.setQueryData(
      providersSnapshotQueryKey(serverId, workspaceCwd),
      providersSnapshot([codexEntry("loading")]),
    );

    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], daemonCwd),
    });

    expect(
      queryClient.getQueryData(providersSnapshotQueryKey(serverId, workspaceCwd)),
    ).toMatchObject({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
  });

  it("invalidates cached agent commands when a provider snapshot update arrives", async () => {
    const commandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd: "/repo-a" },
    });
    queryClient.setQueryData(commandsKey, [{ name: "compact", description: "", argumentHint: "" }]);
    queryClient.setQueryData(
      providersSnapshotQueryKey(serverId, "/repo-a"),
      providersSnapshot([codexEntry("ready")]),
    );

    await applyProvidersSnapshotUpdate({
      client: createClient(),
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], "/repo-a"),
    });

    expect(queryClient.getQueryState(commandsKey)?.isInvalidated).toBe(true);
  });
});

describe("selectorOpenRefetchDecision", () => {
  it("refetches stale entries when no provider is selected", async () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [readyCodexModel])],
        selectedProvider: null,
      }),
    ).toBe("refetch-stale");
  });

  it("forces a refetch when the selected provider has no entry", async () => {
    expect(selectorOpenRefetchDecision({ entries: [], selectedProvider: "codex" })).toBe(
      "refetch-always",
    );
  });

  it("forces a refetch when the selected provider is still loading", async () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("loading")],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-always");
  });

  it("keeps a stale-only refetch when the selected provider is ready with no models", async () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [])],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-stale");
  });

  it("keeps a stale-only refetch when the selected provider is ready with models", async () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [readyCodexModel])],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-stale");
  });
});

it("keeps unsupported guide refresh unavailable and reports a supported rejection with retry", async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("React", React);
  const client = createClient();
  let shouldFail = true;
  const snapshot: ReturnType<typeof providerHooks.useProvidersSnapshot> = {
    entries: [],
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    error: null,
    supportsSnapshot: false,
    refresh: async () => {
      await client.refreshProvidersSnapshot();
    },
    refetchIfStale: () => {},
  };
  client.refreshProvidersSnapshot = async (options) => {
    client.refreshCalls.push(options ?? {});
    if (shouldFail) throw new Error("Refresh failed for this environment.");
    snapshot.error = null;
    return { acknowledged: true, requestId: "guide-refresh" };
  };
  const hook = vi.spyOn(providerHooks, "useProvidersSnapshot").mockReturnValue(snapshot);
  vi.spyOn(hostRuntime, "useHostRuntimeIsConnected").mockReturnValue(true);
  vi.spyOn(directoryDemand, "useDirectoryDemand").mockImplementation(() => {});
  vi.spyOn(providerUsage, "useProviderUsage").mockReturnValue({
    view: { kind: "loading" },
    refresh: async () => {},
    canFetch: false,
  });
  vi.spyOn(providerLogin, "useInstallationConnectOnce").mockReturnValue({
    claude: false,
    codex: false,
  });
  const onUse = vi.fn(async (_providerId: string) => {});
  const onSkip = vi.fn();
  const onSettings = vi.fn();
  const props = { serverId, onUse, onSkip, onSettings };
  vi.spyOn(hostFeatures, "useHostFeature").mockReturnValue(true);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  // The daemon supports primary, but this older coordinator omits the setting.
  queryClient.setQueryData(["installation-settings", undefined], {
    version: 1,
    revision: 1,
    sources: {},
    settings: {
      mcp: { injectIntoAgents: true },
      appendSystemPrompt: "",
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      metadataGeneration: { providers: [] },
      pluginsEnabled: false,
      terminalProfiles: [],
      resourceExclusions: {},
    },
  });
  const body = createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(EnvironmentAccounts, props),
  );
  const view = render(body);
  try {
    expect(
      screen.getByText("Readiness unavailable. Update this host to check provider accounts.")
        .textContent,
    ).toContain("Update this host");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await expect(refreshGuideProviderSnapshot(snapshot)).rejects.toThrow("not supported");
    expect(client.getCalls).toEqual([]);
    expect(client.refreshCalls).toEqual([]);
    snapshot.supportsSnapshot = true;
    snapshot.error = "Snapshot read failed for this environment.";
    hook.mockReturnValue(snapshot);
    view.rerender(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(EnvironmentAccounts, props),
      ),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain(
      "Snapshot read failed for this environment.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert").textContent).toContain(
        "Refresh failed for this environment.",
      );
    });
    expect(screen.queryByText("Snapshot read failed for this environment.")).toBeNull();
    expect(client.refreshCalls).toEqual([{}]);
    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(client.refreshCalls).toEqual([{}, {}]);
    // Background detection uses the same guarded path and notices a newly installed CLI.
    vi.useFakeTimers();
    view.unmount();
    const detected = render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(EnvironmentAccounts, props),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(client.refreshCalls).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onUse).not.toHaveBeenCalled();
    snapshot.entries = [
      {
        provider: "claude",
        label: "Claude",
        status: "error",
        enabled: true,
        error: "Claude is not connected.",
      },
    ];
    detected.rerender(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(EnvironmentAccounts, props),
      ),
    );
    expect(screen.queryByRole("button", { name: /Use Claude|Connect Claude/ })).toBeNull();
    snapshot.entries = [
      { provider: "codex", label: "Codex", status: "ready", enabled: true },
      { provider: "claude", label: "Claude", status: "ready", enabled: true },
    ];
    detected.rerender(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(EnvironmentAccounts, props),
      ),
    );
    const codex = { provider: "codex", status: "ready", enabled: true } as const;
    expect(guideProviderSignedIn(codex, [])).toBe(false);
    expect(
      guideProviderSignedIn(codex, [
        {
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: null,
          windows: [],
        },
      ]),
    ).toBe(true);
    expect(
      guideProviderSignedIn(codex, [
        {
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: null,
          windows: [],
          refreshError: "Cached reading",
        },
      ]),
    ).toBe(false);
    function HookWrapper({ children }: { children: React.ReactNode }) {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }
    const support = renderHook(() => usePrimaryConnection().supported, { wrapper: HookWrapper });
    expect(support.result.current).toBe(false);
    const savePrimaryConnection = vi.fn(async () => {});
    const guide = createVorteoGuide({
      installationId: "guide-test",
      storage: { read: async () => null, write: async () => {} },
      savePrimaryConnection,
    });
    await guide.ready;
    guide.applyGate({
      installationId: "guide-test",
      serverId,
      ownerAuthenticated: true,
      isConnected: true,
      hasHydratedWorkspaces: true,
      hasUserProjects: false,
      supportsPrimaryConnection: support.result.current,
    });
    guide.goTo("providers");
    const state = guide.getState();
    if (state.status !== "open") throw new Error("Expected provider step");
    onUse.mockImplementationOnce(async (providerId: string) => {
      await guide.recordPrimaryConnection(providerId, state.visit);
    });
    expect(
      screen.getByText(
        "This host cannot save a primary connection yet. Your choice stays in this guide and is not saved to installation settings.",
      ),
    ).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use Claude, already signed in" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(guide.primaryRuntimeProviderId).toBe("claude");
    expect(savePrimaryConnection).not.toHaveBeenCalled();
    support.unmount();
    onUse.mockClear();
    onUse.mockRejectedValueOnce(new Error("Shared settings changed again."));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use Claude, already signed in" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("alert").textContent).toContain("Shared settings changed again.");
    expect(onUse).toHaveBeenCalledExactlyOnceWith("claude");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry saving primary connection" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onUse).toHaveBeenCalledTimes(2);
    detected.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(client.refreshCalls).toHaveLength(3);
    vi.useRealTimers();
  } finally {
    vi.useRealTimers();
    cleanup();
    queryClient.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
