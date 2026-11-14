import { defineConfig, devices } from "@playwright/test";
import { stripHostEnvironment } from "./e2e/support/host-environment";

stripHostEnvironment();

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
// Later entries match the spec file too, because Playwright tests these patterns against
// "project file describe title", so a retired title cannot hide a namesake in another spec.
const retiredUpstreamTests = [
  /opening Settings closes the composer model selector until it is opened again/,
  /opening Settings closes an existing chat's model selector until it is opened again/,
  /docked navigation keeps its density and Settings preserves reading width/,
  // The composer diff pill went with Standard mode (6483ba11c, citing 471d7f22a); the merge in
  // 51f16b39f restored these three. The file's review comment and feedback tests stay routed in.
  /composer-diff-stat\.spec\.ts.* composer diff stat /,
  // Vorteo's meter (7723a55f6, 12eb45f71) is a desktop Tooltip with role image, renders nothing
  // until context data exists, keeps its ring hidden through importantForAccessibility, and
  // moves Refresh into the compact sheet and the Context window card.
  /context-window-meter\.spec\.ts.* draws usage clockwise from twelve o'clock/,
  /context-window-meter\.spec\.ts.* shows account usage before the first turn \((desktop|compact)\)/,
  /context-window-meter\.spec\.ts.* the context window hover card shows the agent's usage \((light|dark)\)/,
  /context-window-meter\.spec\.ts.* context details support keyboard entry and dismiss when the viewport moves/,
  /context-window-meter\.spec\.ts.* Find remains available after dismissing context details/,
  // Its setup waits for "Select agent mode", but the composer shows the profile picker since
  // 471d7f22a. The file's other tests on that helper are already fixme'd for the same commit.
  /command-center-agent-controls\.spec\.ts.* keeps an action first when the action is the best match/,
  // The Claude details sheet opens with sign-in guidance (8ffd96665), shown for every Claude
  // host since 471d7f22a, so at 390px the model list starts below the fold.
  /custom-model-removal\.spec\.ts.* removes a long custom model at 390px without removing another model/,
  // Install failures report through a toast instead of the inline alert (cdafe96d5).
  /acp-provider-catalog\.spec\.ts.* unsupported host asks for an update without writing Hoplite config/,
  // Asserts the chevron's CSS transform through an svg/../.. lookup; the testing budget in
  // AGENTS.md forbids CSS assertions.
  /usage-modal\.spec\.ts.* direct-route Usage Settings disclosure (desktop|compact) (light|dark)/,
  // Vorteo keeps sidebar order on the Host (c5fefc7f9). Once any device has initialized it, a
  // device's pre-beta local order is ignored by design, so upstream's restore step cannot apply.
  // Manual drag order across sorting and reloads stays covered by this file's other Manual tests.
  /sidebar-reorder\.spec\.ts.* Manual restores pre-beta order and keeps drag order across sorting and reloads/,
  // The compact sidebar's close button and New workspace nav row went with the Vorton toolbar
  // (471d7f22a); New workspace is a main menu item, so there is no row to sit beside.
  /sidebar-workspace\.spec\.ts.* places the close button beside the first nav row instead of over it/,
  // Drives the composer model selector, which Vorteo replaced with the profile picker (471d7f22a).
  /new-workspace-composer-draft\.spec\.ts.* does not restore a submitted draft after deferred publication/,
  // Upstream collapses workspace groups to 7 rows; Vorteo's folder trees keep 20 (8ccc81917). The
  // open and active rows these tests check stay visible past the limit (selectLimitedTreeRows,
  // covered in tree.test.ts); their seeded counts assume 7.
  /sidebar-reorder\.spec\.ts.* compact groups retain active overflow and reveal the current ordered rows/,
  /sidebar-reorder\.spec\.ts.* collapsed groups lead with the open workspace instead of hiding it behind Show more/,
  /sidebar-reorder\.spec\.ts.* a Manual drag in a collapsed group keeps the open workspace's saved place/,
  // Asserts pixel insets around the bundled skills label; the settings redesign put a hint row
  // under that label on purpose, and the testing budget in AGENTS.md forbids pixel assertions.
  /agent-skills-settings\.spec\.ts.* Agent skills sheet inset (compact|desktop) keeps more space above the bundled skills label than below/,
  // The fixture injects prompt rejections through featureValues, but every UI launch uses a
  // profile, and Vorteo keeps a profile launch's features out of reach of plugin hooks.
  /creation-idempotency\.spec\.ts.* becomes an agent tab when the first prompt is rejected/,
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
