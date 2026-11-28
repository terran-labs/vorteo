import { useSyncExternalStore } from "react";
import type { InstallationPanelModel } from "./panel-model";

/**
 * The installation model that maintenance progress reads (#720), published by the app-wide
 * installation session. Surfaces that show progress import this light module instead of the
 * installation panel, so Settings, Health and their tests load no panel, router or policy code.
 */
export interface MaintenanceSource {
  model: InstallationPanelModel;
  /** Each daemon's server id, from the installation the app was served with. */
  servers: Partial<Record<"host" | "dev", string>>;
}

let source: MaintenanceSource | null = null;
const listeners = new Set<() => void>();

export function publishMaintenanceSource(next: MaintenanceSource): void {
  if (source?.model === next.model) return;
  source = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const read = () => source;

/** The published source, or null before the installation session starts or without one. */
export function useMaintenanceSource(): MaintenanceSource | null {
  return useSyncExternalStore(subscribe, read, read);
}

/** Which daemon a server id belongs to, for the composer's hold check. */
export function serverTarget(serverId: string): "host" | "dev" | null {
  if (source?.servers.host === serverId) return "host";
  if (source?.servers.dev === serverId) return "dev";
  return null;
}
