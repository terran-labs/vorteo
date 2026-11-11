import { useOwnerAccess } from "@/execution-installation/owner-access";
import {
  readExecutionInstallation,
  findInstallationEnvironment,
} from "@/execution-installation/policy";
import {
  claudeFullSignInAvailable,
  claudeProviderConnectsToInstallation,
  claudeSetupRequest,
  claudeUpgradeAvailable,
  claudeUpgradeRequest,
} from "./claude-setup-login";
import {
  codexInstallationRequest,
  codexInstallationSignInAvailable,
} from "./codex-installation-login";
import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useForceProviderUsageRefresh } from "./use-provider-usage";

function useOwnerAllowed(serverId?: string | null) {
  const { status } = useOwnerAccess();
  const localConnection =
    serverId !== undefined &&
    findInstallationEnvironment(readExecutionInstallation(), serverId ?? "") === null;
  return localConnection || status === "unlocked" || status === "none";
}

/**
 * Whether this account signs in once for the installation through the coordinator. Claude always
 * does inside an installation. Codex does when the coordinator runs Host-owned Codex sign-in;
 * otherwise each environment keeps its own sign-in.
 */
export function useSharedInstallationSignIn(
  serverId: string | null,
  provider: "claude" | "codex",
): boolean {
  const ownerAllowed = useOwnerAllowed(serverId);
  const installation = readExecutionInstallation();
  const inInstallation = Boolean(
    installation?.environments.some((environment) => environment.serverId === serverId),
  );
  const codex = useFetchQuery({
    queryKey: ["codex-installation-sign-in", installation?.installationId],
    queryFn: codexInstallationSignInAvailable,
    enabled: ownerAllowed && inInstallation && provider === "codex",
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
  });
  return inInstallation && (provider === "claude" || codex.data === true);
}

/**
 * Whether connect-once is on for each provider: the coordinator runs Host-owned Claude refresh
 * (`claudeHostRefresh`) or Host-owned Codex sign-in (`codexHostRefresh`). Undefined while the
 * coordinator has not answered. Shares its cache with the sign-in flows that probe the same
 * routes.
 */
export function useInstallationConnectOnce(enabled: boolean): {
  claude: boolean | undefined;
  codex: boolean | undefined;
} {
  const ownerAllowed = useOwnerAllowed();
  const installation = readExecutionInstallation();
  const active = ownerAllowed && enabled && installation !== null;
  const claude = useFetchQuery({
    queryKey: ["claude-full-sign-in", installation?.installationId],
    queryFn: claudeFullSignInAvailable,
    enabled: active,
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
  });
  const codex = useFetchQuery({
    queryKey: ["codex-installation-sign-in", installation?.installationId],
    queryFn: codexInstallationSignInAvailable,
    enabled: active,
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
  });
  return {
    claude: claude.isError ? false : claude.data,
    codex: codex.isError ? false : codex.data,
  };
}

/**
 * Whether a shared setup-token Claude account can be upgraded to full sign-in in place. False
 * until the coordinator confirms that it and every environment's daemon support the upgrade.
 */
export function useClaudeSignInUpgradeAvailable(serverId: string | null, providerId: string) {
  const ownerAllowed = useOwnerAllowed(serverId);
  const installation = readExecutionInstallation();
  const shared = useSharedInstallationSignIn(serverId, "claude");
  const query = useFetchQuery({
    queryKey: claudeUpgradeAvailabilityKey(installation?.installationId, serverId, providerId),
    queryFn: () => claudeUpgradeAvailable(serverId!, providerId),
    enabled: ownerAllowed && shared,
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
  });
  return query.data === true;
}

function claudeUpgradeAvailabilityKey(
  installationId: string | undefined,
  serverId: string | null,
  providerId: string,
) {
  return ["claude-sign-in-upgrade", installationId, serverId, providerId];
}

/** "upgrade" runs a setup-token Claude account's in-place upgrade to full sign-in. */
export type ProviderLoginFlow = "connect" | "upgrade";

async function installationLogin(
  provider: "claude" | "codex",
  flow: ProviderLoginFlow,
  serverId: string,
  providerId: string,
  operation: "read" | "start" | "cancel" | "sign-out",
  attempt?: { attemptId: string },
): Promise<ProviderLoginState> {
  if (flow === "upgrade") {
    if (operation === "sign-out") throw new Error("An upgrade has no sign-out.");
    return claudeUpgradeRequest(serverId, providerId, operation, attempt);
  }
  return (await installationRequest(provider, serverId, providerId, operation, attempt)).login;
}

function installationRequest(
  provider: "claude" | "codex",
  serverId: string,
  providerId: string,
  operation: "read" | "start" | "cancel" | "sign-out",
  attempt?: { attemptId: string },
) {
  return provider === "claude"
    ? claudeSetupRequest(serverId, providerId, operation, attempt)
    : codexInstallationRequest(serverId, providerId, operation, attempt);
}

/**
 * Whether the coordinator reports that this named Claude account needs a new sign-in, for
 * example because a failed CLI refresh erased its stored grant. Reads the owner-only connection
 * status under the same query key the sign-in panel uses, at a slower cadence, so a row can offer
 * Reconnect even while its last usage reading still looks fine.
 */
export function useClaudeAccountNeedsSignIn(serverId: string | null, providerId: string): boolean {
  const ownerAllowed = useOwnerAllowed(serverId);
  const installation = readExecutionInstallation();
  const shared = useSharedInstallationSignIn(serverId, "claude");
  const enabled = Boolean(
    serverId && ownerAllowed && shared && claudeProviderConnectsToInstallation(providerId),
  );
  const connection = useFetchQuery({
    queryKey: ["claude-setup-connection", installation?.installationId, serverId, providerId],
    queryFn: async () => (await claudeSetupRequest(serverId!, providerId, "read")).connection,
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTimeMs: 30_000,
    dataShape: "value",
    retry: false,
  });
  return enabled && connection.data?.needsSignIn === true;
}

interface SignInUsageRefreshInput {
  login: ProviderLoginState | undefined;
  environments: readonly { serverId: string; status: string }[] | undefined;
  serverId: string | null;
}

/**
 * Changes when a completed sign-in should show its usage: once on completion, and again when an
 * installation sign-in reaches this host, since the credential arrives after the attempt ends.
 */
export function signInUsageRefreshKey({
  login,
  environments,
  serverId,
}: SignInUsageRefreshInput): string | null {
  if (login?.status !== "succeeded") return null;
  const delivered = environments?.some(
    (environment) => environment.serverId === serverId && environment.status === "ready",
  );
  return `${login.attemptId}:${delivered ? "delivered" : "completed"}`;
}

export function useProviderLogin(
  serverId: string | null,
  providerId: string,
  provider: "claude" | "codex" = "codex",
  flow: ProviderLoginFlow = "connect",
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const hostConnected = useHostRuntimeIsConnected(serverId ?? "");
  const ownerAllowed = useOwnerAllowed(serverId);
  const installation = readExecutionInstallation();
  const shared = useSharedInstallationSignIn(serverId, provider);
  const sharedClaude = shared && provider === "claude";
  const connected = ownerAllowed && (shared || hostConnected);
  const cache = useQueryClient();
  const key = useMemo(
    () =>
      flow === "upgrade"
        ? ["providerLogin", serverId, providerId, flow]
        : ["providerLogin", serverId, providerId],
    [serverId, providerId, flow],
  );
  const action = useMutation({
    gcTime: 0,
    mutationFn: async (operation: "start" | "cancel" | "sign-out" | { code: string }) => {
      if ((!client && !shared) || !connected)
        throw new Error("Reconnect to the host and try again.");
      await cache.cancelQueries({ queryKey: key });
      if (operation === "sign-out") {
        if (!shared) throw new Error("Installation subscription connection required.");
        return installationLogin(provider, flow, serverId!, providerId, "sign-out");
      }
      if (operation === "start") {
        if (shared) return installationLogin(provider, flow, serverId!, providerId, "start");
        return (await client!.startProviderLogin(providerId)).state;
      }
      const state = cache.getQueryData<ProviderLoginState>(key);
      if (!state || state.status === "idle")
        throw new Error("Refresh the sign-in status and try again.");
      if (sharedClaude && typeof operation === "object") {
        const submission = { attemptId: state.attemptId, code: operation.code };
        if (flow === "upgrade")
          return claudeUpgradeRequest(serverId!, providerId, "submit", submission);
        return (await claudeSetupRequest(serverId!, providerId, "submit", submission)).login;
      }
      if (shared && typeof operation === "object")
        throw new Error("Codex sign-in uses a device code and takes no pasted code.");
      if (shared)
        return installationLogin(provider, flow, serverId!, providerId, "cancel", {
          attemptId: state.attemptId,
        });
      if (typeof operation === "object")
        return (await client!.submitProviderLoginCode(providerId, state.attemptId, operation.code))
          .state;
      return (await client!.cancelProviderLogin(providerId, state.attemptId)).state;
    },
    onSuccess: (state) => cache.setQueryData(key, state),
  });
  const enabled = Boolean((client || shared) && connected && !action.isPending);
  const query = useFetchQuery({
    queryKey: key,
    queryFn: async () => {
      if (shared) return installationLogin(provider, flow, serverId!, providerId, "read");
      if (!client) throw new Error("Host unavailable");
      return (await client.readProviderLogin(providerId)).state;
    },
    enabled,
    refetchInterval: enabled ? 2000 : false,
    staleTimeMs: 0,
    dataShape: "value",
    gcTime: 0,
    retry: false,
  });
  const synchronizing = ownerAllowed && shared && flow === "connect";
  const synchronization = useFetchQuery({
    queryKey: [
      provider === "claude" ? "claude-setup-connection" : "codex-installation-connection",
      installation?.installationId,
      serverId,
      providerId,
    ],
    queryFn: async () =>
      (await installationRequest(provider, serverId!, providerId, "read")).connection,
    enabled: synchronizing,
    refetchInterval: synchronizing ? 2000 : false,
    staleTimeMs: 0,
    dataShape: "value",
    gcTime: 0,
    retry: false,
  });
  const { mutate, reset } = action;
  const { refetch } = query;
  const start = useCallback(() => mutate("start"), [mutate]);
  const { mutateAsync } = action;
  const submitCode = useCallback(
    async (code: string) => {
      try {
        return await mutateAsync({ code });
      } finally {
        reset();
      }
    },
    [mutateAsync, reset],
  );
  const signOut = useCallback(() => mutate("sign-out"), [mutate]);
  const cancel = useCallback(() => mutate("cancel"), [mutate]);
  const refresh = useCallback(() => {
    reset();
    void refetch();
  }, [reset, refetch]);
  const refreshKey = signInUsageRefreshKey({
    login: query.data,
    environments: synchronization.data?.environments,
    serverId,
  });
  const refreshUsage = useForceProviderUsageRefresh(serverId);
  useEffect(() => {
    if (!refreshKey) return;
    void refreshUsage();
    void cache.invalidateQueries({ queryKey: ["providerReset", serverId, providerId] });
    // A completed upgrade is when a setup-token account starts reporting usage.
    if (flow === "upgrade")
      void cache.invalidateQueries({
        queryKey: claudeUpgradeAvailabilityKey(installation?.installationId, serverId, providerId),
      });
  }, [cache, refreshKey, refreshUsage, serverId, providerId, flow, installation?.installationId]);
  return {
    state: query.data,
    /** One sign-in for the whole installation, through the coordinator. */
    shared,
    sharedClaude,
    synchronization: synchronization.data,
    connected,
    busy: action.isPending || query.isLoading,
    actionPending: action.isPending,
    readFailed: query.isError,
    actionFailed: action.isError,
    refreshing: query.isFetching,
    start,
    cancel,
    signOut,
    submitCode,
    refresh,
  };
}
