import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";

export type FinishObservationResult = WaitForFinishResult & {
  reason?:
    | "was canceled"
    | "is not running"
    | "could not be reopened"
    | "host unreachable"
    | "host removed";
};

/**
 * Cancel reason a local observation uses for a child found closed at rest without an archive:
 * stopped by a daemon restart or released while idle. It is not the child's end.
 */
export const NOT_RUNNING_CANCEL_REASON = "paseo:not-running";
/** Cancel reason for a child that was running at a restart and could not be reopened. */
export const REOPEN_FAILED_CANCEL_REASON = "paseo:reopen-failed";

/** Coalesces duplicate checkpoints and retains one terminal result while delivery is pending. */
export function createObservationBuffer(signal: AbortSignal) {
  const delivered = new Set<string>();
  const permissions = new Map<string, FinishObservationResult>();
  const resolvedBeforeInitial = new Set<string>();
  let initialPending = true;
  let terminal: FinishObservationResult | undefined;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const abort = () => {
    failure = signal.reason;
    wake?.();
  };
  signal.addEventListener("abort", abort, { once: true });
  function push(result: FinishObservationResult): void {
    if (result.status === "timeout") return;
    if (result.status === "permission") {
      for (const request of result.final?.pendingPermissions ?? [])
        if (!delivered.has(request.id)) permissions.set(request.id, result);
    } else terminal = result;
    wake?.();
  }
  return {
    pushInitial(result: FinishObservationResult) {
      initialPending = false;
      if (result.status === "permission" && result.final) {
        const pendingPermissions = result.final.pendingPermissions.filter(
          (request) => !resolvedBeforeInitial.has(request.id),
        );
        if (pendingPermissions.length)
          push({ ...result, final: { ...result.final, pendingPermissions } });
      } else if (
        !terminal &&
        result.final?.status !== "running" &&
        result.final?.status !== "initializing"
      )
        push(result);
      resolvedBeforeInitial.clear();
    },
    push,
    resolved(id: string) {
      if (initialPending) resolvedBeforeInitial.add(id);
      delivered.delete(id);
      permissions.delete(id);
    },
    fail(error: unknown) {
      failure = error;
      wake?.();
    },
    async next(): Promise<FinishObservationResult> {
      while (true) {
        signal.throwIfAborted();
        const first = permissions.entries().next().value;
        if (first) {
          for (const request of first[1].final?.pendingPermissions ?? []) {
            delivered.add(request.id);
            permissions.delete(request.id);
          }
          return first[1];
        }
        if (terminal) {
          const result = terminal;
          terminal = undefined;
          return result;
        }
        if (failure) throw failure;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
    dispose() {
      signal.removeEventListener("abort", abort);
    },
  };
}
