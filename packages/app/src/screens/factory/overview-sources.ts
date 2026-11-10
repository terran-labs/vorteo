import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { projectNameForWorkspace } from "@/hooks/sidebar-workspaces-view-model";
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
import {
  boundedFactoryRead,
  factoryListQueryKey,
  loadFactoryList,
  OWNER_STOP_REASON,
} from "./factory-reads";
import {
  factoryScopeKey,
  canResumeHost,
  canStopHost,
  hostStopState,
  selectFreshTargets,
  type FactoryScopeEntry,
  type HostStopState,
} from "./all-factories-model";
import { checkProjectResume } from "./resume-confirm";
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

/**
 * Server ids whose daemon runs a Factory that is on or paused, from the same cached lists the
 * overview reads. Reads once per stale period and never polls.
 */
export function useFactoryServerIds(enabled: boolean): ReadonlySet<string> {
  const hosts = useFactoryHosts();
  const lists = useFetchQueries(
    hosts.map((host) => ({
      dataShape: "value" as const,
      queryKey: factoryListQueryKey(host.serverId),
      staleTimeMs: POLL_MS,
      enabled,
      queryFn: () => boundedFactoryRead(() => loadFactoryList(host.invoke)),
    })),
    combineLists,
  );
  return useMemo(
    () =>
      new Set(
        hosts
          .filter((_host, index) =>
            (lists[index]?.projects ?? []).some(
              (project) => project.state === "on" || project.state === "paused",
            ),
          )
          .map((host) => host.serverId),
      ),
    [hosts, lists],
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
  // Only running or paused projects are read; unavailable ones render from their list entry.
  const live = useMemo(
    () => shown.filter(({ project }) => project.state === "on" || project.state === "paused"),
    [shown],
  );
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

export interface StopAllControls {
  /** Some host has Factories running that nobody else holds. */
  canStop: boolean;
  /** Some host is held by Stop all alone. */
  canResume: boolean;
  /** Confirms, re-reads each host, then pauses every Factory on the hosts still running. */
  stop: () => void;
  /**
   * Confirms, re-reads each host, then releases our stop on each host still held by it alone.
   * resume_all releases every drain on a host, so a host anyone else holds is left alone.
   */
  resumeAll: () => void;
  /** One project's own pause or resume, as in the single-project view. */
  setProject: (entry: FactoryScopeEntry, method: "pause" | "resume") => void;
  /** A global stop or resume is confirming or running. */
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

/**
 * The installation-wide stop control over factory.project.pause_all and resume_all, per host.
 * Only the All Factories view offers it: it sees every project on each host it acts on.
 */
export function useStopAll(
  hosts: readonly FactoryHost[],
  entries: readonly FactoryScopeEntry[],
): StopAllControls {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectPending, setProjectPending] = useState<string | null>(null);
  const [projectErrors, setProjectErrors] = useState<Record<string, string>>({});
  const hostStates = useMemo(
    () =>
      new Map(
        hosts.map((host) => [
          host.serverId,
          hostStopState(entries.filter((entry) => entry.serverId === host.serverId)),
        ]),
      ),
    [hosts, entries],
  );
  const stopTargets = useMemo(
    () => hosts.filter((host) => canStopHost(hostStates.get(host.serverId)!)),
    [hosts, hostStates],
  );
  const resumeTargets = useMemo(
    () => hosts.filter((host) => canResumeHost(hostStates.get(host.serverId)!)),
    [hosts, hostStates],
  );
  /** Re-reads each target's list now; a failed read leaves that host alone. */
  const fresh = useCallback(
    async (targets: readonly FactoryHost[], qualifies: (state: HostStopState) => boolean) => {
      const reads = await Promise.allSettled(
        targets.map((host) =>
          client.fetchQuery({
            queryKey: factoryListQueryKey(host.serverId),
            queryFn: () => loadFactoryList(host.invoke),
            staleTime: 0,
          }),
        ),
      );
      return selectFreshTargets(targets, reads, qualifies);
    },
    [client],
  );
  const run = useCallback(
    async (input: {
      targets: readonly FactoryHost[];
      confirm: () => Promise<boolean>;
      qualifies: (state: HostStopState) => boolean;
      method: string;
      body: object;
      doneKey: "projectFactory.stopAll.stoppedOn" | "projectFactory.stopAll.resumedOn";
      nothingLeft: string;
    }) => {
      // Pending from the first press, so a second press cannot open a second dialog.
      setPending(true);
      setError(null);
      try {
        if (!(await input.confirm())) return;
        const { act, unreadable, skipped } = await fresh(input.targets, input.qualifies);
        const results = await Promise.allSettled(
          act.map(async (host) => {
            const list = ProjectFactoryListSchema.parse(
              await host.invoke(input.method, input.body),
            );
            client.setQueryData(factoryListQueryKey(host.serverId), list);
          }),
        );
        const done = act.filter((_, index) => results[index]!.status === "fulfilled");
        const failed = act.flatMap((host, index) => {
          const result = results[index]!;
          return result.status === "rejected" ? [`${host.label} (${message(result.reason)})`] : [];
        });
        const names = (list: readonly FactoryHost[]) => list.map((host) => host.label).join(", ");
        // Every host that was left alone or failed is named, beside the ones that did act.
        const report = [
          act.length === 0 ? input.nothingLeft : null,
          done.length ? t(input.doneKey, { hosts: names(done) }) : null,
          unreadable.length
            ? t("projectFactory.stopAll.unreadable", { hosts: names(unreadable) })
            : null,
          skipped.length ? t("projectFactory.stopAll.skipped", { hosts: names(skipped) }) : null,
          failed.length ? t("projectFactory.stopAll.failed", { hosts: failed.join(", ") }) : null,
        ].filter((line): line is string => line !== null);
        if (act.length === 0 || unreadable.length || skipped.length || failed.length) {
          setError(report.join(" "));
        }
        await client.invalidateQueries({ queryKey: ["projectFactory"] });
      } catch (failure) {
        setError(message(failure));
      } finally {
        setPending(false);
      }
    },
    [client, fresh, t],
  );
  const stop = useCallback(() => {
    void run({
      targets: stopTargets,
      confirm: () =>
        confirmDialog({
          title: t("projectFactory.stopAll.confirmTitle"),
          message: t("projectFactory.stopAll.confirmMessage", { count: stopTargets.length }),
          confirmLabel: t("projectFactory.stopAll.confirm"),
          destructive: true,
        }),
      qualifies: canStopHost,
      method: "factory.project.pause_all",
      body: { reason: OWNER_STOP_REASON },
      doneKey: "projectFactory.stopAll.stoppedOn",
      nothingLeft: t("projectFactory.stopAll.nothingToStop"),
    });
  }, [stopTargets, run, t]);
  const resumeAll = useCallback(() => {
    void run({
      targets: resumeTargets,
      confirm: () =>
        confirmDialog({
          title: t("projectFactory.stopAll.resumeTitle"),
          message: t("projectFactory.stopAll.resumeMessage", { count: resumeTargets.length }),
          confirmLabel: t("projectFactory.stopAll.resume"),
        }),
      qualifies: canResumeHost,
      method: "factory.project.resume_all",
      body: {},
      doneKey: "projectFactory.stopAll.resumedOn",
      nothingLeft: t("projectFactory.stopAll.nothingToResume"),
    });
  }, [resumeTargets, run, t]);
  const setProject = useCallback(
    (entry: FactoryScopeEntry, method: "pause" | "resume") => {
      const host = hosts.find((candidate) => candidate.serverId === entry.serverId);
      if (!host) return;
      setProjectPending(entry.key);
      setProjectErrors(({ [entry.key]: _cleared, ...rest }) => rest);
      void (async () => {
        try {
          if (method === "resume") {
            // Decided from a fresh read: a project another process now holds is not resumed.
            const check = await checkProjectResume({
              client,
              serverId: entry.serverId,
              projectId: entry.projectId,
              invoke: host.invoke,
              t,
            });
            if (!check.resume) {
              const notice = check.message;
              if (notice) setProjectErrors((current) => ({ ...current, [entry.key]: notice }));
              return;
            }
          }
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
    [client, hosts, t],
  );
  return {
    canStop: stopTargets.length > 0,
    canResume: resumeTargets.length > 0,
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
