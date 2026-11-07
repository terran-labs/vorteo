/**
 * Worker bindings that browser tests may set. Only these names reach the built Worker, as plain
 * `vars`; the build never copies the rest of the process environment, which in an agent shell or
 * CI job can hold tokens, into `dist/server/.dev.vars`.
 */
export const WEBSITE_TEST_VAR_NAMES = ["PLUGINS_REGISTRY_URL", "GITHUB_API_URL"] as const;

export type WebsiteTestVars = Partial<Record<(typeof WEBSITE_TEST_VAR_NAMES)[number], string>>;

/** Environment for the test web server: the allowlisted bindings, passed as one JSON value. */
export function websiteTestServerEnv(vars: WebsiteTestVars): Record<string, string> {
  return {
    // Wrangler would otherwise copy every process variable into the preview's .dev.vars.
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    WEBSITE_TEST_VARS: JSON.stringify(vars),
  };
}

/** Reads WEBSITE_TEST_VARS, keeping only allowlisted names with string values. */
export function parseWebsiteTestVars(raw: string | undefined): WebsiteTestVars {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return {};
  const vars: WebsiteTestVars = {};
  for (const name of WEBSITE_TEST_VAR_NAMES) {
    const value = (parsed as Record<string, unknown>)[name];
    if (typeof value === "string") vars[name] = value;
  }
  return vars;
}
