import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

type Availability = Pick<ProviderSnapshotEntry, "enabled" | "status">;

export function isProviderSelectable(entry: Availability): boolean {
  return entry.enabled && entry.status !== "unavailable";
}

export function isProviderDetecting(entry: Availability): boolean {
  return entry.status === "loading";
}

export function areProvidersDetecting(entries: readonly Availability[] | undefined): boolean {
  return Boolean(entries?.length && entries.every(isProviderDetecting));
}
