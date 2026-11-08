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
import {
  ProjectFactoryListSchema,
  type ProjectFactoryList,
} from "../../../../../plugins/factory/shared/project";
import { isListedFactory } from "@/components/sidebar/factory-global-model";
import {
  boundedFactoryRead,
  factoryListQueryKey,
  loadFactoryList,
  OWNER_STOP_REASON,
} from "./factory-reads";
import {
  factoryQuestions,
  factoryScopeKey,
  type FactoryQuestion,
  type FactoryScopeEntry,
  type FactoryStop,
} from "./all-factories-model";
import { loadFactoryQueue, type FactoryInvoke, type FactoryQueue } from "./queue";

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

function combineLists(results: { data?: ProjectFactoryList }[]) {
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
      queryKey: factoryListQueryKey(host.serverId),
      staleTimeMs: POLL_MS,
      enabled: active,
      refetchInterval: active ? POLL_MS : false,
      queryFn: () => boundedFactoryRead(() => loadFactoryList(host.invoke)),
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
  const shown = useMemo(
    () => projects.filter(({ project }) => project.state !== "off" || project.drain !== null),
    [projects],
  );
  // Unavailable projects render from their list entry; only running or paused ones are read.
  const live = useMemo(() => shown.filter(({ project }) => isListedFactory(project)), [shown]);
  const states = useFetchQueries(
    live.map(({ host, project }) => ({
      dataShape: "value" as const,
      queryKey: ["projectFactory", host.serverId, project.projectId],
      staleTimeMs: POLL_MS,
      enabled: active,
      refetchInterval: active ? POLL_MS : false,
      queryFn: () =>
        boundedFactoryRead(async () =>
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
      // A daemon without the queue answers null; never poll it again.
      refetchInterval: (query: { state: { data: unknown } }) =>
        active && query.state.data !== null ? POLL_MS : false,
      queryFn: () => boundedFactoryRead(() => loadFactoryQueue(host.invoke, project.projectId)),
    })),
    combineQueues,
  );
  const names = useProjectNames();
  const entries = useMemo(() => {
    const multiHost = new Set(shown.map(({ host }) => host.serverId)).size > 1;
    const read = new Map(live.map((item, index) => [item, index]));
    return shown.map((item): FactoryScopeEntry => {
      const { host, project } = item;
      const index = read.get(item);
      const state = index === undefined ? null : (states[index] ?? null);
      return {
        key: factoryScopeKey(host.serverId, project.projectId),
        serverId: host.serverId,
        projectId: project.projectId,
        name: names(host.serverId, project.projectId) ?? project.repository ?? project.projectId,
        hostLabel: multiHost ? host.label : null,
        state,
        status: state?.state ?? project.state,
        drain: project.drain ?? state?.drain ?? null,
        issues: index === undefined ? null : (queues[index]?.queue?.issues ?? null),
      };
    });
  }, [shown, live, states, queues, names]);
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
  /** What the one global control does now: stop running hosts, resume our stop, or nothing. */
  mode: "stop" | "resume" | "none";
  /** Confirms, then pauses every Factory on the hosts that are not stopped yet. */
  stop: () => void;
  /**
   * Confirms, then releases our stop on each host held only by it. resume_all releases every
   * drain on a host, so a host that someone else, such as Builds, also holds is left alone.
   */
  resumeAll: () => void;
  /** One project's own pause or resume, as in the single-project view. */
  setProject: (entry: FactoryScopeEntry, method: "pause" | "resume") => void;
  pending: boolean;
  /** The project key whose pause or resume is in flight. */
  projectPending: string | null;
  projectErrors: Readonly<Record<string, string>>;
  error: string | null;
  /** Some shown host runs the Factory plugin. */
  available: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The installation-wide stop control over factory.project.pause_all and resume_all, per host. */
export function useStopAll(
  hosts: readonly FactoryHost[],
  stops: readonly FactoryStop[],
): StopAllControls {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectPending, setProjectPending] = useState<string | null>(null);
  const [projectErrors, setProjectErrors] = useState<Record<string, string>>({});
  const stopTargets = useMemo(
    () => hosts.filter((host) => !stops.some((stop) => stop.serverId === host.serverId)),
    [hosts, stops],
  );
  const resumeTargets = useMemo(
    () =>
      hosts.filter((host) => {
        const own = stops.filter((stop) => stop.serverId === host.serverId);
        return own.length > 0 && own.every((stop) => stop.owner);
      }),
    [hosts, stops],
  );
  const run = useCallback(
    async (targets: readonly FactoryHost[], method: string, input: object) => {
      setPending(true);
      setError(null);
      try {
        const results = await Promise.allSettled(
          targets.map(async (host) => {
            const list = ProjectFactoryListSchema.parse(await host.invoke(method, input));
            client.setQueryData(factoryListQueryKey(host.serverId), list);
          }),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed) setError(message((failed as PromiseRejectedResult).reason));
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
        message: t("projectFactory.stopAll.confirmMessage", { count: stopTargets.length }),
        confirmLabel: t("projectFactory.stopAll.confirm"),
        destructive: true,
      });
      if (!confirmed) return;
      await run(stopTargets, "factory.project.pause_all", { reason: OWNER_STOP_REASON });
    })();
  }, [stopTargets, run, t]);
  const resumeAll = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("projectFactory.stopAll.resumeTitle"),
        message: t("projectFactory.stopAll.resumeMessage", { count: resumeTargets.length }),
        confirmLabel: t("projectFactory.stopAll.resume"),
      });
      if (!confirmed) return;
      await run(resumeTargets, "factory.project.resume_all", {});
    })();
  }, [resumeTargets, run, t]);
  const setProject = useCallback(
    (entry: FactoryScopeEntry, method: "pause" | "resume") => {
      const host = hosts.find((candidate) => candidate.serverId === entry.serverId);
      if (!host) return;
      setProjectPending(entry.key);
      setProjectErrors(({ [entry.key]: _cleared, ...rest }) => rest);
      void (async () => {
        try {
          const next = ProjectFactoryStateSchema.parse(
            await host.invoke(`factory.project.${method}`, { projectId: entry.projectId }),
          );
          client.setQueryData(["projectFactory", entry.serverId, entry.projectId], next);
          await client.invalidateQueries({ queryKey: factoryListQueryKey(entry.serverId) });
        } catch (failure) {
          setProjectErrors((current) => ({ ...current, [entry.key]: message(failure) }));
        } finally {
          setProjectPending(null);
        }
      })();
    },
    [client, hosts],
  );
  let mode: StopAllControls["mode"] = "none";
  if (resumeTargets.length) mode = "resume";
  else if (stopTargets.length) mode = "stop";
  return {
    mode,
    stop,
    resumeAll,
    setProject,
    pending,
    projectPending,
    projectErrors,
    error,
    available: hosts.length > 0,
  };
}
