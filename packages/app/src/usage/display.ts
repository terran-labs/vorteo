import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import { setUsageDisplayAs, type UsageDisplayAs, type UsagePreferences } from "./preferences";

/** What usage views need from the preferences: how to read percents. */
export interface UsageDisplay {
  displayAs: UsageDisplayAs;
  setDisplayAs: (displayAs: UsageDisplayAs) => void;
}

interface UsagePreferencesState {
  preferences: UsagePreferences;
  display: UsageDisplay;
}

/** The device's usage preferences. */
export function useUsageDisplay(): UsagePreferencesState {
  const { settings, updateSettings } = useAppSettings();
  const preferences = settings.usage;
  const setDisplayAs = useCallback(
    (displayAs: UsageDisplayAs) => {
      void updateSettings((current) => ({ usage: setUsageDisplayAs(current.usage, displayAs) }));
    },
    [updateSettings],
  );
  const display = useMemo<UsageDisplay>(
    () => ({ displayAs: preferences.displayAs, setDisplayAs }),
    [preferences.displayAs, setDisplayAs],
  );
  return { preferences, display };
}
