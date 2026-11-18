import { isDeepStrictEqual } from "node:util";
import type { expect } from "@playwright/test";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationSettingsSnapshot } from "@getpaseo/protocol/installation-settings";

interface SettingsConvergence {
  minimumRevision: number;
  providerDefinitions: InstallationProvider[];
  serverIds: string[];
}

export function settingsHaveConverged(
  sample: InstallationSettingsSnapshot,
  expected: SettingsConvergence,
): boolean {
  if (sample.settings === null || sample.conflicts) return false;
  if (sample.revision < expected.minimumRevision) return false;
  if (!sample.settings.providerDefinitions) return false;

  const byId = (left: InstallationProvider, right: InstallationProvider) =>
    left.id.localeCompare(right.id);
  const catalogMatches = isDeepStrictEqual(
    [...sample.settings.providerDefinitions].sort(byId),
    [...expected.providerDefinitions].sort(byId),
  );
  const allApplied =
    expected.serverIds.length > 0 &&
    expected.serverIds.every((serverId) => {
      const status = sample.sources[serverId];
      return (
        status !== undefined &&
        status.appliedRevision === sample.revision &&
        status.pendingRevision === null &&
        status.error === null
      );
    });
  return catalogMatches && allApplied;
}

interface WaitForSettingsConvergence extends SettingsConvergence {
  read: () => Promise<InstallationSettingsSnapshot>;
  poll: typeof expect.poll;
}

export async function waitForSettingsConvergence(
  options: WaitForSettingsConvergence,
): Promise<void> {
  // Each attempt compares the catalog and projections from one accepted snapshot.
  await options
    .poll(async () => settingsHaveConverged(await options.read(), options), {
      timeout: 60_000,
    })
    .toBe(true);
}
