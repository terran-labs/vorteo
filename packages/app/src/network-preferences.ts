import { useSyncExternalStore } from "react";
import { isWeb } from "@/constants/platform";

/**
 * Data saving for the browser build. While it is on, the app keeps system fonts instead of the
 * optional web fonts (about 60 to 200 KB once) and asks before downloading the diagram runtime
 * (about 820 KB brotli). Both are hashed assets cached for a year, so the saving matters on a
 * first load over a slow or metered connection.
 *
 * The browser decides by default: its data saver, a 2G-class connection or
 * `prefers-reduced-data`. The startup screen in `public/index.html`, which appears exactly when
 * loading is slow or failing, offers the only manual choice; it persists as an override until
 * the person returns to automatic from Settings > Appearance. The boot script applies the same
 * rule before first paint, so fonts are skipped before they are requested.
 */

const eventName = "vorteo-data-saver-change";
export const DATA_SAVER_OVERRIDE_KEY = "vorteo-data-saver-override-v2";
/** The retired settings switch. Its choice is dropped so it cannot force data saving forever. */
const legacyStorageKey = "vorteo-data-saver-v1";
const reducedDataQuery = "(prefers-reduced-data: reduce)";

declare global {
  interface Window {
    __vorteoSetDataSaver?: (enabled: boolean, persist?: boolean) => boolean;
  }
}

/** The subset of the Network Information API this reads. Most browsers outside Chromium lack it. */
interface NetworkConnection {
  saveData?: boolean;
  effectiveType?: string;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}

export interface DataSaverSignals {
  connection?: NetworkConnection | null;
  prefersReducedData?: boolean;
}

/**
 * True when the browser asks to save data: the user's data saver (`saveData`), a 2G-class
 * connection, or `prefers-reduced-data`. 3G is left alone because Chromium reports it for
 * many usable connections, and a false positive would hide diagrams for no reason.
 */
export function shouldSaveData(signals: DataSaverSignals): boolean {
  const connection = signals.connection;
  if (connection?.saveData === true) return true;
  if (connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") return true;
  return signals.prefersReducedData === true;
}

/** The startup screen's explicit choice, or null to follow the browser. Unknown values follow it. */
export function parseDataSaverOverride(stored: string | null): boolean | null {
  if (stored === "on") return true;
  if (stored === "off") return false;
  return null;
}

/** An explicit choice wins; otherwise the browser's signals decide. */
export function resolveDataSaver(override: boolean | null, signals: DataSaverSignals): boolean {
  return override ?? shouldSaveData(signals);
}

function browserConnection(): NetworkConnection | null {
  if (typeof navigator === "undefined") return null;
  const connection: unknown = Reflect.get(navigator, "connection");
  return typeof connection === "object" && connection !== null
    ? (connection as NetworkConnection)
    : null;
}

function reducedDataMedia(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(reducedDataQuery);
}

function currentSignals(): DataSaverSignals {
  return {
    connection: browserConnection(),
    prefersReducedData: reducedDataMedia()?.matches === true,
  };
}

export function readDataSaverOverride(): boolean | null {
  if (!isWeb || typeof window === "undefined") return null;
  try {
    return parseDataSaverOverride(window.localStorage.getItem(DATA_SAVER_OVERRIDE_KEY));
  } catch {
    return null;
  }
}

/** Mirrors the current decision into the document, where the boot script and fonts read it. */
function applyDataSaver(): void {
  if (!isWeb || typeof document === "undefined") return;
  const enabled = resolveDataSaver(readDataSaverOverride(), currentSignals());
  if (document.documentElement.dataset.vorteoDataSaver !== String(enabled)) {
    // The boot helper also detaches the optional font stylesheet. Never persist from here.
    if (window.__vorteoSetDataSaver) {
      window.__vorteoSetDataSaver(enabled, false);
      return;
    }
    document.documentElement.dataset.vorteoDataSaver = String(enabled);
  }
  // Also announces override changes that leave the value as it was.
  window.dispatchEvent(new Event(eventName));
}

/** Drops the startup screen's choice so the browser decides again. */
export function clearDataSaverOverride(): void {
  if (!isWeb || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DATA_SAVER_OVERRIDE_KEY);
  } catch {
    // Storage can be unavailable; the automatic value below still applies to this page.
  }
  applyDataSaver();
}

if (isWeb && typeof window !== "undefined") {
  try {
    window.localStorage.removeItem(legacyStorageKey);
  } catch {
    // Storage can be unavailable; the value below still applies to this page.
  }
  applyDataSaver();
}

export function readDataSaver(): boolean {
  return (
    isWeb &&
    typeof document !== "undefined" &&
    document.documentElement.dataset.vorteoDataSaver === "true"
  );
}

function subscribe(notify: () => void): () => void {
  if (!isWeb || typeof window === "undefined") return () => undefined;
  const connection = browserConnection();
  const media = reducedDataMedia();
  // Another tab changing the override applies here too.
  function storageChanged(event: StorageEvent) {
    if (event.key === DATA_SAVER_OVERRIDE_KEY || event.key === null) applyDataSaver();
  }
  window.addEventListener(eventName, notify);
  window.addEventListener("storage", storageChanged);
  connection?.addEventListener?.("change", applyDataSaver);
  media?.addEventListener?.("change", applyDataSaver);
  return () => {
    window.removeEventListener(eventName, notify);
    window.removeEventListener("storage", storageChanged);
    connection?.removeEventListener?.("change", applyDataSaver);
    media?.removeEventListener?.("change", applyDataSaver);
  };
}

export function useDataSaver(): boolean {
  return useSyncExternalStore(subscribe, readDataSaver, () => false);
}

/** The startup screen's choice, or null while the browser decides. */
export function useDataSaverOverride(): boolean | null {
  return useSyncExternalStore(subscribe, readDataSaverOverride, () => null);
}
