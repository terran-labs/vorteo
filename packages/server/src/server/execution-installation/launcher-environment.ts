import { isDeepStrictEqual } from "node:util";

/** The one launcher environment variable a reviewed release seal change may add or remove. */
export const RELEASE_SEALS_VARIABLE = "VORTEO_RELEASE_SEALS";
/** The only value that turns release seals on (coordinator-bootstrap-release-seal.ts). */
export const RELEASE_SEALS_VALUE = "enabled";

/** A launcher's environment, `{}` when it has none, or null when it is not a string dictionary. */
export function launcherEnvironment(
  launcher: Record<string, unknown>,
): Record<string, string> | null {
  const value = launcher.EnvironmentVariables;
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * The launcher with release seals turned on or off: exactly `VORTEO_RELEASE_SEALS=enabled`
 * added to, or removed from, its environment. Throws naming the unexpected current state.
 */
export function withReleaseSeals(
  launcher: Record<string, unknown>,
  seals: "enabled" | null,
  subject: string,
): Record<string, unknown> {
  const environment = launcherEnvironment(launcher);
  if (!environment) throw new Error(`${subject} EnvironmentVariables is not a string dictionary`);
  const present = Object.hasOwn(environment, RELEASE_SEALS_VARIABLE);
  if (seals === RELEASE_SEALS_VALUE) {
    if (present) throw new Error(`${subject} already sets ${RELEASE_SEALS_VARIABLE}`);
    return {
      ...launcher,
      EnvironmentVariables: { ...environment, [RELEASE_SEALS_VARIABLE]: RELEASE_SEALS_VALUE },
    };
  }
  if (environment[RELEASE_SEALS_VARIABLE] !== RELEASE_SEALS_VALUE)
    throw new Error(
      `${subject} does not set ${RELEASE_SEALS_VARIABLE}=${RELEASE_SEALS_VALUE}, so there is nothing to remove`,
    );
  const { [RELEASE_SEALS_VARIABLE]: _removed, ...rest } = environment;
  return { ...launcher, EnvironmentVariables: rest };
}

/**
 * Names, never values, of the launcher settings where `actual` differs from `expected`.
 * Environment variables are named individually as `EnvironmentVariables.<name>`.
 */
export function launcherDifferences(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): string[] {
  const differences: string[] = [];
  for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    if (isDeepStrictEqual(expected[key], actual[key])) continue;
    const before = key === "EnvironmentVariables" ? launcherEnvironment(expected) : null;
    const after = key === "EnvironmentVariables" ? launcherEnvironment(actual) : null;
    const names =
      before && after
        ? [...new Set([...Object.keys(before), ...Object.keys(after)])]
            .sort()
            .filter((name) => before[name] !== after[name])
        : [];
    // An absent dictionary and an empty one differ only in the key itself.
    if (names.length === 0) differences.push(key);
    else differences.push(...names.map((name) => `EnvironmentVariables.${name}`));
  }
  return differences;
}
