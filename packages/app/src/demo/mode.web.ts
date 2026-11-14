import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import { isIsolatedDemoPreview } from "./preview";
import { demoInstallation, installDemoCoordinator } from "./installation";

const SESSION_KEY = "vorteo:demo-active";
const GENERATION_KEY = "vorteo:demo-generation";
const DATABASES_KEY = "vorteo:demo-databases";

function readDemoSession(): boolean {
  if (typeof window === "undefined") return false;
  if (new URL(window.location.href).searchParams.get("demo") === "1") {
    window.sessionStorage.setItem(SESSION_KEY, "1");
  }
  return window.sessionStorage.getItem(SESSION_KEY) === "1";
}

/**
 * A random ID that also works where `crypto.randomUUID` does not: iOS before 15.4 and pages
 * served without HTTPS. Anything here that throws runs at module load, before the app mounts,
 * and would fail every load while the demo flag stays set.
 */
function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Session-stored list of demo database names; unreadable values count as none. */
function readDatabaseNames(): string[] {
  try {
    const names: unknown = JSON.parse(window.sessionStorage.getItem(DATABASES_KEY) ?? "[]");
    return Array.isArray(names)
      ? names.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

// Changes take effect after a full navigation, before any host stores are constructed.
const active = readDemoSession();
const isolatedStorage = active || isIsolatedDemoPreview;
function readGeneration(): string {
  if (!isolatedStorage) return "inactive";
  const existing = window.sessionStorage.getItem(GENERATION_KEY);
  if (existing) return existing;
  const created = randomId();
  window.sessionStorage.setItem(GENERATION_KEY, created);
  return created;
}
const generation = readGeneration();
if (isolatedStorage) {
  const retained: string[] = [];
  for (const name of readDatabaseNames()) {
    if (!name.startsWith("vorteo-demo:")) continue;
    if (name.startsWith(`vorteo-demo:${generation}:`)) retained.push(name);
    else {
      // Old generations are only cleanup; a WebKit context without IndexedDB must still boot.
      try {
        indexedDB.deleteDatabase(name);
      } catch {
        /* Left for the browser to evict. */
      }
    }
  }
  window.sessionStorage.setItem(DATABASES_KEY, JSON.stringify(retained));
}
// The demo answers its simulated installation's coordinator routes in memory, before any request.
if (active) installDemoCoordinator();

export function isDemoSession(): boolean {
  return active;
}

/** The simulated "Demo Lab" installation, only inside a demo session. */
export function readDemoInstallation(): ExecutionInstallation | null {
  return active ? demoInstallation(window.location.origin) : null;
}
export function demoStorageName(name: string): string {
  if (!isolatedStorage) return name;
  const scoped = `vorteo-demo:${generation}:${name}`;
  const known = readDatabaseNames();
  if (!known.includes(scoped))
    window.sessionStorage.setItem(DATABASES_KEY, JSON.stringify([...known, scoped]));
  return scoped;
}

export function resetDemo(): void {
  window.sessionStorage.setItem(GENERATION_KEY, randomId());
  for (const key of Object.keys(window.sessionStorage)) {
    if (key.startsWith("vorteo:demo:")) window.sessionStorage.removeItem(key);
  }
  window.location.assign("/?demo=1");
}

export function enterDemo(): void {
  window.sessionStorage.setItem(SESSION_KEY, "1");
  window.location.assign("/?demo=1");
}

export function exitDemo(): void {
  window.sessionStorage.removeItem(SESSION_KEY);
  window.location.assign("/welcome");
}
