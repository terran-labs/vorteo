import { useInstalledPlugins, usePluginCatalogStatus } from "@/plugins/registry";
import { resolvePluginSurfacePlaceholder } from "@/plugins/surface-contribution";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import type { InstalledPlugin } from "@/plugins/types";

/** Whether a host's Factory can be shown, and if not, which placeholder the page shows. */
export type FactoryAvailability = "ready" | "loading" | "offline" | "unavailable";

/**
 * The host's Factory plugin, or why it is missing. A host that is offline says so, as other
 * plugin pages do, instead of loading until it reconnects.
 */
export function useFactoryPlugin(serverId: string): {
  plugin: InstalledPlugin | undefined;
  availability: FactoryAvailability;
} {
  const plugin = useInstalledPlugins().find(
    (entry) => entry.id === "factory" && entry.serverId === serverId,
  );
  const catalogStatus = usePluginCatalogStatus(serverId);
  const connectionStatus = useHostRuntimeConnectionStatus(serverId);
  if (plugin) return { plugin, availability: "ready" };
  const placeholder = resolvePluginSurfacePlaceholder({ connectionStatus, catalogStatus });
  return {
    plugin,
    availability:
      placeholder === "loading" || placeholder === "offline" ? placeholder : "unavailable",
  };
}
