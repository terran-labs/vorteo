import { useRef } from "react";
import type { ProviderUsage } from "@/provider-usage/types";

interface UsageInput {
  identity: string;
  supported: boolean;
  valid: boolean;
  latest: ProviderUsage | undefined;
}

/** Retain readings only for the same usable connection, independently of its reserved space. */
export function useRetainedUsage({ identity, supported, valid, latest }: UsageInput) {
  const retained = useRef({
    identity,
    usage: undefined as ProviderUsage | undefined,
    reservedWindows: supported ? 1 : 0,
    loaded: false,
  });
  if (retained.current.identity !== identity) {
    retained.current = {
      identity,
      usage: undefined,
      reservedWindows: supported ? 1 : 0,
      loaded: false,
    };
  }
  const state = retained.current;
  if (supported && !state.loaded) state.reservedWindows = Math.max(1, state.reservedWindows);
  const rejected =
    latest &&
    (latest.status !== "available" || latest.authRecovery || latest.error || latest.refreshError);
  if (!valid || !supported || rejected) state.usage = undefined;
  else if (latest) {
    // The first successful reading sizes the row. Subsequent readings cannot change
    // its number of visible slots, including when a refresh returns fewer windows.
    if (!state.loaded) {
      state.reservedWindows = Math.max(state.reservedWindows, latest.windows.length);
      state.loaded = true;
    }
    state.usage = { ...latest, windows: latest.windows.slice(0, state.reservedWindows) };
  }
  return { usage: state.usage, reservedWindows: state.reservedWindows };
}
