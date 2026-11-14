import { useContext, useEffect, useSyncExternalStore } from "react";
import { QueryClientContext, type Query, type QueryClient } from "@tanstack/react-query";

/**
 * Health rows that do not come from the installation state: provider accounts, the primary
 * connection and app updates. The System Health list computes them from the settings queries and
 * publishes their ids here; the sidebar's "System needs attention" button adds them to the
 * installation rows it already reads. The button subscribes to no provider or settings query of
 * its own, so the main app sidebar adds no fetching or polling.
 *
 * The published rows depend on cached query data. When that data changes while the Health list is
 * not on screen, for example after an account is fixed from Providers, the rows can no longer be
 * trusted, so they are dropped until the list computes them again. The button then counts only
 * what it knows, the installation rows, rather than a fix that already happened. It only listens
 * to the query cache; nothing is fetched.
 */

/** Query roots the published rows were computed from. */
const SOURCE_ROOTS = new Set([
  "providersSnapshot",
  "installation-settings",
  "providerUsage",
  "daemon-config",
  "vorton-update",
]);

let extras: readonly string[] = [];
/** The source data the published rows were computed from, keyed by query hash. */
let basis = new Map<string, string>();
let mountedLists = 0;
const listeners = new Set<() => void>();

function isSource(query: Query): boolean {
  return SOURCE_ROOTS.has(String(query.queryKey[0]));
}

function fingerprint(data: unknown): string {
  try {
    return JSON.stringify(data) ?? "";
  } catch {
    return String(Math.random());
  }
}

function setExtras(ids: readonly string[]): void {
  if (ids.length === extras.length && ids.every((id, index) => id === extras[index])) return;
  extras = [...ids];
  for (const listener of listeners) listener();
}

/** Records the rows the Health list shows and the data they came from. */
export function publishHealthExtras(ids: readonly string[], client?: QueryClient): void {
  if (client) {
    basis = new Map(
      client
        .getQueryCache()
        .findAll()
        .filter(isSource)
        .map((query) => [query.queryHash, fingerprint(query.state.data)]),
    );
  }
  setExtras(ids);
}

/** Marks the Health list as on screen; while it is, it keeps the rows current itself. */
export function useHealthListMounted(): void {
  useEffect(() => {
    mountedLists += 1;
    return () => {
      mountedLists -= 1;
    };
  }, []);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How many non-installation Health rows the list last showed. */
export function healthExtrasCount(): number {
  return extras.length;
}

/** The extra row count, dropped when its source data changes while the list is away. */
export function useHealthExtrasCount(): number {
  // The notice also mounts where no query client exists (lock screens, isolated mounts). With no
  // cache there is nothing to invalidate the rows, so read the context instead of requiring it.
  const client = useContext(QueryClientContext);
  useEffect(
    () =>
      client?.getQueryCache().subscribe((event) => {
        if (mountedLists > 0 || extras.length === 0) return;
        if (event.type !== "updated" || event.action.type !== "success") return;
        if (!isSource(event.query)) return;
        if (basis.get(event.query.queryHash) === fingerprint(event.query.state.data)) return;
        setExtras([]);
      }),
    [client],
  );
  return useSyncExternalStore(subscribe, healthExtrasCount, healthExtrasCount);
}
