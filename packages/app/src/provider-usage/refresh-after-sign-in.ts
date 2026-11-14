import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import { refreshAndApplyProvidersSnapshot } from "@/data/providers-snapshot";
import {
  findInstallationEnvironment,
  readExecutionInstallation,
} from "@/execution-installation/policy";
import { requestInstallationSettings } from "@/execution-installation/settings";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { useProviderLogin } from "./use-provider-login";
import { forceRefreshProviderUsage } from "./use-provider-usage";

type Login = ReturnType<typeof useProviderLogin>;
const ACTIVE: ReadonlySet<ProviderLoginState["status"] | undefined> = new Set([
  "starting",
  "waiting",
  "verifying",
]);

/**
 * After a sign-in completes in this dialog, re-reads provider status and usage in every
 * environment as its credential arrives, so connection rows and health items update without a
 * reload. The Host is ready on success; Dev once synchronization reports it ready. Opening the
 * dialog on an already connected account refreshes nothing.
 */
export function useRefreshAfterSignIn({
  login,
  upgrade,
  outcome,
  serverId,
  providerId,
}: {
  login: Login;
  upgrade: Login | null;
  outcome: "connected" | "failed" | null;
  serverId: string | null;
  providerId: string;
}) {
  const queryClient = useQueryClient();
  const armed = useRef(false);
  const refreshed = useRef(new Set<string>());
  const active = ACTIVE.has(login.state?.status) || ACTIVE.has(upgrade?.state?.status);
  // Each sign-in delivers a new credential, so a second attempt refreshes every environment again.
  const attempt = [login.state, upgrade?.state]
    .map((state) => (state && "attemptId" in state ? state.attemptId : ""))
    .join(":");
  useEffect(() => {
    refreshed.current.clear();
  }, [attempt]);
  useEffect(() => {
    if (active) armed.current = true;
  }, [active]);
  const ready = outcome === "connected" ? readyEnvironments(login, serverId) : [];
  const readyKey = ready.join("\n");
  useEffect(() => {
    if (!armed.current || !readyKey) return;
    const fresh = readyKey.split("\n").filter((id) => !refreshed.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) refreshed.current.add(id);
    void refreshEnvironments(queryClient, fresh, serverId, providerId);
  }, [readyKey, queryClient, serverId, providerId]);
}

/** Environments that hold the new credential now: the Host, plus each delivery reported ready. */
function readyEnvironments(login: Login, serverId: string | null): string[] {
  const installation = readExecutionInstallation();
  const environments = installation?.environments ?? [];
  if (!serverId || !environments.some((environment) => environment.serverId === serverId))
    return serverId ? [serverId] : [];
  const host = environments.find((environment) => environment.kind === "host")?.serverId;
  const delivered = (login.synchronization?.environments ?? [])
    .filter((environment) => environment.status === "ready")
    .map((environment) => environment.serverId);
  return [...new Set([...(host ? [host] : []), ...delivered])].sort();
}

async function refreshEnvironments(
  queryClient: QueryClient,
  serverIds: string[],
  serverId: string | null,
  providerId: string,
) {
  const bindings = await accountBindings(serverId, providerId);
  await Promise.allSettled(
    serverIds.map(async (id) => {
      const client = getHostRuntimeStore().getClient(id);
      if (!client) return;
      const bound = bindings?.[id] ?? (id === serverId ? providerId : undefined);
      const usage =
        useSessionStore.getState().sessions[id]?.serverInfo?.features?.providerUsageList;
      await Promise.allSettled([
        // The daemon re-checks the account's sign-in, then the cached snapshot is replaced.
        refreshAndApplyProvidersSnapshot({
          client,
          queryClient,
          serverId: id,
          cwd: null,
          ...(bound ? { providers: [bound] } : {}),
        }),
        usage === true ? forceRefreshProviderUsage({ client, queryClient, serverId: id }) : null,
      ]);
    }),
  );
}

/** The account's provider ID in each environment, from the shared definition when there is one. */
async function accountBindings(
  serverId: string | null,
  providerId: string,
): Promise<Record<string, string> | null> {
  if (!serverId || !findInstallationEnvironment(readExecutionInstallation(), serverId)) return null;
  try {
    const snapshot = await requestInstallationSettings();
    const definition = snapshot.settings?.providerDefinitions?.find(
      (item) => !item.removed && item.bindings[serverId] === providerId,
    );
    return definition?.bindings ?? null;
  } catch {
    return null;
  }
}
