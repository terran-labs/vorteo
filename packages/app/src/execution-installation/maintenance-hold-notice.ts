import { useSyncExternalStore } from "react";
import { holdLine, maintenanceProgress, operationName } from "./maintenance-progress";
import { useInstallationSystemModel } from "./panel";

const noSubscription = () => () => {};
const noState = () => null;

/**
 * Health's line while a restart or update keeps the owner's messages out (#720): progress, not a
 * request for approval. Kept apart from maintenance-status.tsx so Health loads no navigation or
 * session code.
 */
export function useMessageHoldNotice(): { label: string; hint: string } | null {
  const model = useInstallationSystemModel();
  const state = useSyncExternalStore(
    model?.subscribe ?? noSubscription,
    model?.getState ?? noState,
    model?.getState ?? noState,
  );
  if (!state?.unlocked) return null;
  const progress = maintenanceProgress({
    unlocked: true,
    jobs: state.jobs,
    serviceJobs: state.serviceQueue?.jobs ?? [],
    summary: state.restartSummary,
    lastUpdatedAt: state.lastUpdatedAt,
    now: Date.now(),
    visibleThread: () => null,
  });
  const holding = progress.operations.find((operation) => operation.holdsMessages);
  if (!holding) return null;
  return { label: `${operationName(holding)} in progress`, hint: holdLine(holding) ?? "" };
}
