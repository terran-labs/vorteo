import { defineConfig, devices } from "@playwright/test";

// E2E_METRO_PORT is set dynamically by global-setup.ts after finding a free port
// This allows multiple test runs in parallel across different worktrees
const baseURL =
  process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_METRO_PORT ?? "8081"}`;
const relayDeploymentSpec = "**/relay-deployment-reconnect.real.spec.ts";
// Vorteo keeps its own onboarding: upstream's first-run walkthrough is off behind
// UPSTREAM_SETUP_ENABLED in src/onboarding/index.ts. Route its spec back in if that flag is enabled.
const upstreamSetupWalkthroughSpec = "**/onboarding.spec.ts";
// Upstream tests for controls Vorteo removed on purpose, routed out by title so upstream merges
// keep applying cleanly. Re-check each one against Vorteo behavior after every upstream merge.
// - The composer model selector: Vorteo's composer picks an account profile instead (471d7f22a).
// - Labeled docked navigation at 600-720px: Vorteo compacts narrow windows to the icon rail,
//   whose larger buttons leave Settings in the More menu (912be3133, ab60c1e39).
const retiredUpstreamTests = [
  /opening Settings closes the composer model selector until it is opened again/,
  /opening Settings closes an existing chat's model selector until it is opened again/,
  /docked navigation keeps its density and Settings preserves reading width/,
];

function videoMode(): "on" | "on-first-retry" | "retain-on-failure" {
  if (process.env.E2E_RECORD_VIDEO === "1") return "on";
  if (process.env.CI) return "on-first-retry";
  return "retain-on-failure";
}

export default defineConfig({
  testDir: "./e2e/browser",
  globalSetup: "./e2e/support/global-setup.ts",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  // Files run concurrently, while each worker owns its daemon state. Keeping a
  // spec on one worker avoids repeating its file-level setup across daemons.
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? (process.env.CI ? "2" : "1")),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: videoMode(),
  },
  projects: [
    {
      name: "browser",
      testIgnore: ["**/*.real.spec.ts", "**/*.packaged.spec.ts", upstreamSetupWalkthroughSpec],
      grepInvert: retiredUpstreamTests,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "real-provider",
      testMatch: ["**/*.real.spec.ts"],
      testIgnore: [relayDeploymentSpec],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "relay-deployment",
      testMatch: [relayDeploymentSpec],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Note: Metro is started by global-setup.ts on a dynamic port to allow parallel test runs
});
