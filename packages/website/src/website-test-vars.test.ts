import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unstable_getVarsForDev } from "wrangler";
import { parseWebsiteTestVars, websiteTestServerEnv } from "./website-test-vars";

const WRANGLER_CONFIG = path.resolve(__dirname, "../wrangler.toml");
const CANARY = "WEBSITE_TEST_CANARY_TOKEN";
const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("website test bindings", () => {
  it("keeps unlisted process variables out of the preview's .dev.vars", () => {
    // The browser test server's environment, plus a secret an agent shell or CI job might hold.
    setEnv({
      ...websiteTestServerEnv({ GITHUB_API_URL: "http://127.0.0.1:8188" }),
      [CANARY]: "secret",
    });
    // The Cloudflare Vite plugin writes exactly this result to dist/server/.dev.vars.
    const devVars = unstable_getVarsForDev(WRANGLER_CONFIG, undefined, {}, undefined, true);
    expect(Object.keys(devVars)).not.toContain(CANARY);
    expect(Object.keys(devVars)).not.toContain("WEBSITE_TEST_VARS");

    // Only allowlisted names become Worker vars.
    expect(
      parseWebsiteTestVars(
        JSON.stringify({ GITHUB_API_URL: "http://127.0.0.1:8188", [CANARY]: "secret" }),
      ),
    ).toEqual({ GITHUB_API_URL: "http://127.0.0.1:8188" });
  });
});
