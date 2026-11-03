import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

/** Snapshot errors mean the installed CLI needs attention; request errors can be retried. */
export function catalogRecoveryAction(
  entry: Pick<ProviderSnapshotEntry, "status"> | undefined,
  discoveryError?: string | null,
): "sign-in" | "retry" {
  return !discoveryError && entry?.status === "error" ? "sign-in" : "retry";
}
