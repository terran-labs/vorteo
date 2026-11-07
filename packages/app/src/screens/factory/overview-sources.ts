import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { projectNameForWorkspace } from "@/hooks/sidebar-workspaces-view-model";
import { selectPendingArchiveAgentIds, usePendingArchiveState } from "@/hooks/use-archive-agent";
import { useFetchQueries } from "@/data/query";
import {
  ProjectFactoryStateSchema,
  type ProjectFactoryState,
} from "@/components/sidebar/factory-state";
import { useInstalledPlugins } from "@/plugins/registry";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { ProjectFactoryListSchema } from "../../../../../plugins/factory/shared/project";
import {
  factoryQuestions,
  factoryScopeKey,
  type FactoryQuestion,
  type FactoryScopeEntry,
} from "./all-factories-model";
import { loadFactoryQueue, type FactoryInvoke, type FactoryQueue } from "./queue";

type FactoryList = ReturnType<typeof ProjectFactoryListSchema.parse>;

/** At most this many Factory requests run at once, however many projects the installation has. */
const MAX_CONCURRENT = 4;
let running = 0;
const waiting: (() => void)[] = [];
async function bounded<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

const POLL_MS = 30_000;

interface FactoryHost {
  serverId: string;
  label: string;
  invoke: FactoryInvoke;
}

/** Every connected host that runs the Factory plugin, with its label. */
export function useFactoryHosts(): FactoryHost[] {
  const plugins = useInstalledPlugins();
  const hosts = useHosts();
  return useMemo(
    () =>
      plugins
        .filter((plugin) => plugin.id === "factory")
        .map((plugin) => ({
          serverId: plugin.serverId,
          label: hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId,
          invoke: plugin.invoke,
        })),
    [plugins, hosts],
  );
}

function combineLists(results: { data?: FactoryList }[]) {
  return results.map((result) => result.data ?? null);
}
function combineStates(results: { data?: ProjectFactoryState }[]) {
  return results.map((result) => result.data ?? null);
}
function combineQueues(results: { data?: FactoryQueue | null; dataUpdatedAt: number }[]) {
  return results.map((result) => ({ queue: result.data ?? null, at: result.dataUpdatedAt }));
}

/**
 * Every project's Factory on every Factory host: the list from each host, then each project's
 * state and queue under the same query keys as the sidebar card and the project overview, so
 * all three share one cache. Polls every 30 seconds while the overview is focused.
 */
export function useAllFactories(active: boolean): {
  entries: FactoryScopeEntry[];
  loading: boolean;
  updatedAt: number;
  hosts: FactoryHost[];
} {
  const hosts = useFactoryHosts();
  const lists = useFetchQueries(
    hosts.map((host) => ({
      dataShape: "value" as const,
      queryKey: ["factoryList", host.serverId],
      staleTimeMs: POLL_MS,
      enabled: active,
      refetchInterval: active ? POLL_MS : false,
      queryFn: () =>
        bounded(async () =>
          ProjectFactoryListSchema.parse(await host.invoke("factory.project.list", {})),
        ),
    })),
    combineLists,
  );
  const projects = useMemo(
    () =>
      hosts.flatMap((host, index) =>
        (lists[index]?.projects ?? []).map((project) => ({ host, project })),
      ),
    [hosts, lists],
  );
  const live = useMemo(() => projects.filter(({ project }) => project.state !== "off"), [projects]);
  const states = useFetchQueries(
    live.map(({ host, project }) => ({
      dataShape: "value" as const,
      queryKey: ["projectFactory", host.serverId, project.projectId],
      staleTimeMs: POLL_MS,
      enabled: active,
      refetchInterval: active ? POLL_MS : false,
      queryFn: () =>
        bounded(async () =>
          ProjectFactoryStateSchema.parse(
            await host.invoke("factory.project.get", { projectId: project.projectId }),
          ),
        ),
    })),
    combineStates,
  );
  const queues = useFetchQueries(
    live.map(({ host, project }) => ({
      dataShape: "value" as const,
      queryKey: ["factoryQueue", host.serverId, project.projectId],
      staleTimeMs: POLL_MS,
      enabled: active,
      refetchInterval: active ? POLL_MS : false,
      queryFn: () => bounded(() => loadFactoryQueue(host.invoke, project.projectId)),
    })),
    combineQueues,
  );
  const names = useProjectNames();
  const entries = useMemo(() => {
    const multiHost = new Set(live.map(({ host }) => host.serverId)).size > 1;
    return live.map(({ host, project }, index): FactoryScopeEntry => {
      const state = states[index] ?? null;
      return {
        key: factoryScopeKey(host.serverId, project.projectId),
        serverId: host.serverId,
        projectId: project.projectId,
        name: names(host.serverId, project.projectId) ?? project.repository ?? project.projectId,
        hostLabel: multiHost ? host.label : null,
        state,
        status: state?.state ?? project.state,
        drain: project.drain ?? state?.drain ?? null,
        issues: queues[index]?.queue?.issues ?? null,
      };
    });
  }, [live, states, queues, names]);
  const updatedAt = Math.max(0, ...queues.map((entry) => entry.at));
  const loading = hosts.length > 0 && lists.some((list) => list === null);
  return { entries, loading, updatedAt, hosts };
}

/** The sidebar's display name for a project on a host. */
export function useProjectNames(): (serverId: string, projectId: string) => string | undefined {
  const sessions = useSessionStore((store) => store.sessions);
  return useCallback(
    (serverId: string, projectId: string) => {
      const session = sessions[serverId];
      const workspace = Array.from(session?.workspaces.values() ?? []).find(
        (entry) => entry.projectId === projectId,
      );
      const project = session?.projects.get(projectId);
      return workspace
        ? projectNameForWorkspace(workspace)
        : (project?.projectCustomName ?? project?.projectDisplayName);
    },
    [sessions],
  );
}

/** Open questions from these Factories' threads, read from the session store like the card. */
export function useFactoryQuestions(entries: readonly FactoryScopeEntry[]): FactoryQuestion[] {
  const sessions = useSessionStore((store) => store.sessions);
  const pending = usePendingArchiveState();
  return useMemo(() => {
    const serverIds = new Set(entries.map((entry) => entry.serverId));
    const hosts = [...serverIds].flatMap((serverId) => {
      const session = sessions[serverId];
      if (!session) return [];
      return [
        {
          serverId,
          agents: session.agents.values(),
          pendingArchive: selectPendingArchiveAgentIds(pending, serverId),
        },
      ];
    });
    return factoryQuestions(entries, hosts);
  }, [entries, pending, sessions]);
}

export interface StopAllControls {
  /** Confirms, then pauses every Factory on these hosts. */
  stop: () => void;
  /** Releases exactly what pause_all held. */
  resume: (serverId?: string) => void;
  pending: boolean;
  error: string | null;
  available: boolean;
}

/** The installation-wide stop switch: factory.project.pause_all and resume_all per host. */
export function useStopAll(hosts: readonly FactoryHost[], hostCount: number): StopAllControls {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (targets: readonly FactoryHost[], method: string, input: object) => {
      setPending(true);
      setError(null);
      try {
        const results = await Promise.allSettled(
          targets.map(async (host) => {
            const list = ProjectFactoryListSchema.parse(await host.invoke(method, input));
            client.setQueryData(["factoryList", host.serverId], list);
          }),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed) {
          const reason = (failed as PromiseRejectedResult).reason;
          setError(reason instanceof Error ? reason.message : String(reason));
        }
        await client.invalidateQueries({ queryKey: ["projectFactory"] });
      } finally {
        setPending(false);
      }
    },
    [client],
  );
  const stop = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("projectFactory.stopAll.confirmTitle"),
        message: t("projectFactory.stopAll.confirmMessage", { count: hostCount }),
        confirmLabel: t("projectFactory.stopAll.confirm"),
        destructive: true,
      });
      if (!confirmed) return;
      await run(hosts, "factory.project.pause_all", {
        reason: t("projectFactory.stopAll.defaultReason"),
      });
    })();
  }, [hostCount, hosts, run, t]);
  const resume = useCallback(
    (serverId?: string) => {
      const targets = serverId ? hosts.filter((host) => host.serverId === serverId) : hosts;
      void run(targets, "factory.project.resume_all", {});
    },
    [hosts, run],
  );
  return { stop, resume, pending, error, available: hosts.length > 0 };
}
