import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSessionStore } from "@/stores/session-store";
import {
  blockersLine,
  estimateLine,
  holdLine,
  maintenanceProgress,
  operationName,
  overdueLine,
  phaseLine,
  sinceLine,
  staleLine,
  stepLine,
  type MaintenanceOperation,
  type MaintenanceProgress,
  type MaintenanceTarget,
} from "./maintenance-progress";
import { useMaintenanceSource } from "./maintenance-model-source";

/**
 * Live maintenance progress and its Settings detail (#720). Light on purpose: it reads the
 * published installation model, never the panel, the router or the installation policy, so the
 * Settings views and their tests can import it.
 */

// The installation polls every 5 seconds; re-reading staleness slightly slower is enough.
const STALE_CHECK_MS = 5_000;

const noSubscription = () => () => {};
const noState = () => null;

/** An operation that finished while the app was watching, shown briefly so it does not vanish. */
export interface FinishedOperation {
  id: string;
  name: string;
  at: string;
}
export type LiveMaintenance = MaintenanceProgress & { finished: FinishedOperation[] };

/** How long a finished operation stays mentioned. A failure keeps its own attention item. */
const FINISHED_SHOWN_MS = 60_000;

/** The live maintenance snapshot, or null where this app has no installation. */
export function useMaintenanceProgress(): LiveMaintenance | null {
  const published = useMaintenanceSource();
  const model = published?.model;
  const state = useSyncExternalStore(
    model?.subscribe ?? noSubscription,
    model?.getState ?? noState,
    model?.getState ?? noState,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state) return;
    const timer = setInterval(() => setNow(Date.now()), STALE_CHECK_MS);
    return () => clearInterval(timer);
  }, [state]);
  const progress = useMemo(() => {
    if (!state) return null;
    const servers = published?.servers ?? {};
    return maintenanceProgress({
      unlocked: state.unlocked,
      jobs: state.jobs,
      serviceJobs: state.serviceQueue?.jobs ?? [],
      summary: state.restartSummary,
      lastUpdatedAt: state.lastUpdatedAt,
      now,
      // Only a thread this app lists for that daemon is named; others stay anonymous.
      visibleThread: (target, agentId) => {
        const serverId = servers[target];
        if (!serverId) return null;
        const agent = useSessionStore.getState().sessions[serverId]?.agents?.get(agentId);
        return agent ? (agent.title ?? null) : null;
      },
    });
  }, [now, published, state]);
  const finished = useRecentlyFinished(progress, state?.jobs, state?.serviceQueue?.jobs);
  return useMemo(() => (progress ? { ...progress, finished } : null), [finished, progress]);
}

interface TrackedRecord {
  id: string;
  status: string;
  finishedAt?: string;
}

/**
 * Operations that left the running list because they succeeded, kept for a minute. The finish
 * time is the coordinator's when it reports one, otherwise when this app saw it end.
 */
function useRecentlyFinished(
  progress: MaintenanceProgress | null,
  jobs: readonly TrackedRecord[] | undefined,
  serviceJobs: readonly TrackedRecord[] | undefined,
): FinishedOperation[] {
  const seen = useRef(new Map<string, MaintenanceOperation>());
  const [finished, setFinished] = useState<FinishedOperation[]>([]);
  useEffect(() => {
    if (!progress) return;
    const records = [...(jobs ?? []), ...(serviceJobs ?? [])];
    const active = new Map(progress.operations.map((operation) => [operation.id, operation]));
    const ended: FinishedOperation[] = [];
    for (const [id, operation] of seen.current) {
      if (active.has(id)) continue;
      const record = records.find((job) => job.id === id);
      if (record?.status !== "succeeded") continue;
      ended.push({
        id,
        name: operationName(operation),
        at: record.finishedAt ?? new Date().toISOString(),
      });
    }
    seen.current = active;
    if (ended.length) setFinished((current) => [...current, ...ended]);
  }, [jobs, progress, serviceJobs]);
  useEffect(() => {
    if (!finished.length) return;
    const expire = () =>
      setFinished((current) =>
        current.filter((entry) => Date.now() - Date.parse(entry.at) < FINISHED_SHOWN_MS),
      );
    const timer = setTimeout(expire, FINISHED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [finished]);
  return finished;
}

/** A one-second clock for elapsed times, running only while something is shown. */
export function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The System page anchor for a target's row; System services share the page's top. */
export function maintenanceAnchorId(target: MaintenanceTarget): string {
  return target === "system" ? "settings-system-services" : `settings-system-${target}`;
}
/** The full progress of a target's operations, under its row in Settings > System. */
export function MaintenanceOperationDetail({ target }: { target: MaintenanceTarget }) {
  const progress = useMaintenanceProgress();
  const operations = progress?.operations.filter((operation) => operation.target === target) ?? [];
  const now = useClock(operations.length > 0);
  if (!progress || operations.length === 0) return null;
  const stale = staleLine(progress);
  return (
    <View style={styles.detail} testID={`maintenance-detail-${target}`}>
      {operations.map((operation) => (
        <View key={operation.id} style={styles.detailOperation}>
          <Text style={styles.detailTitle}>
            {`${operationName(operation)}: ${phaseLine(operation)}`}
          </Text>
          {[
            sinceLine(operation, now),
            stepLine(operation, now),
            estimateLine(operation),
            holdLine(operation),
            blockersLine(operation),
            overdueLine(operation),
          ]
            .filter((line): line is string => Boolean(line))
            .map((line) => (
              <Text key={line} style={styles.description}>
                {line}
              </Text>
            ))}
        </View>
      ))}
      {stale ? <Text style={styles.description}>{stale}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  description: { fontSize: theme.fontSize.sm, lineHeight: 16, color: theme.colors.foregroundMuted },
  detail: { gap: theme.spacing[2], paddingTop: theme.spacing[1] },
  detailOperation: { gap: 2 },
  detailTitle: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));
