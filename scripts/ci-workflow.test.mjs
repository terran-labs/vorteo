import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative as relativePath } from "node:path";
import test from "node:test";
import { isVersionOnlyChange } from "./ci-neutralize-version-bumps.mjs";
import { runInNewContext } from "node:vm";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  // Vorteo's main ruleset requires format and lint by name, so they stay separate jobs.
  ["format", { name: "format", contract: "format" }],
  ["lint", { name: "lint", contract: "quality" }],
  ["quality", { name: "quality", contracts: ["quality", "relay", "sdk"] }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  [
    "server-integration-windows",
    { name: "server-integration (windows-latest)", contract: "server" },
  ],
  ["server-tests-macos", { name: "server-tests (macos-15, file observation)", contract: "server" }],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["playwright-1", { name: "playwright (shard 1/8)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/8)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/8)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/8)", contract: "browser" }],
  ["playwright-5", { name: "playwright (shard 5/8)", contract: "browser" }],
  ["playwright-6", { name: "playwright (shard 6/8)", contract: "browser" }],
  ["playwright-7", { name: "playwright (shard 7/8)", contract: "browser" }],
  ["playwright-8", { name: "playwright (shard 8/8)", contract: "browser" }],
  ["playwright-smoke", { name: "playwright (smoke)", contract: "browser" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
  ["cli-unit", { name: "cli-unit", contract: "cli" }],
]);

// Vorteo: suites that run only on merge groups, manual and nightly runs and release tags.
const heavyCiJobs = new Set([
  "installer-tests",
  "server-tests-windows",
  "server-integration-windows",
  "server-tests-macos",
  "desktop-tests-ubuntu",
  "desktop-tests-windows",
  ...Array.from({ length: 8 }, (_, index) => `playwright-${index + 1}`),
  "playwright-smoke",
  "playwright-installation",
  ...Array.from({ length: 3 }, (_, index) => `cli-tests-${index + 1}`),
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of (source.split("\njobs:\n")[1] ?? source).split("\n")) {
    const jobMatch = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("pull-request checks run for every base branch, including stacked PRs", () => {
  for (const workflowPath of [ciWorkflowPath]) {
    const trigger = readFileSync(workflowPath, "utf8").split("jobs:", 1)[0];
    const pullRequest = trigger.match(/^  pull_request:\n((?:    .*\n)*)/m);
    assert.ok(pullRequest, `${workflowPath.pathname} runs on pull requests`);
    assert.doesNotMatch(pullRequest[1], /branches/);
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  const ci = readFileSync(ciWorkflowPath, "utf8");
  assert.match(
    ci,
    /^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m,
    "a newer pull request push cancels the superseded run; main runs finish",
  );
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("published npm packages declare and ship the repository license", () => {
  const rootManifest = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8"));
  const workspaceArgs = rootManifest.scripts["release:publish"].match(/--workspace=\S+/g);
  assert.notEqual(workspaceArgs, null, "release:publish must select public packages");
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", ...workspaceArgs], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
  const manifests = new Map(
    rootManifest.workspaces.map((workspace) => {
      const directory = new URL(`${workspace}/`, repoRoot);
      const manifest = JSON.parse(readFileSync(new URL("package.json", directory), "utf8"));
      return [manifest.name, { directory, manifest }];
    }),
  );
  const licenses = packed.map(({ name, files }) => ({
    name,
    license: manifests.get(name).manifest.license,
    files: files.filter((file) => file.path === "LICENSE").map((file) => file.path),
  }));
  assert.deepEqual(
    licenses,
    workspaceArgs.map((workspace) => ({
      name: workspace.slice("--workspace=".length),
      license: "Apache-2.0",
      files: ["LICENSE"],
    })),
  );
  const repositoryLicense = readFileSync(new URL("LICENSE", repoRoot), "utf8");
  for (const { name } of packed) {
    const { directory } = manifests.get(name);
    assert.equal(readFileSync(new URL("LICENSE", directory), "utf8"), repositoryLicense, name);
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("PR routing ignores manifests whose only change is the Vorteo version", () => {
  const changes = jobBlocks(readFileSync(ciWorkflowPath, "utf8")).get("changes")?.join("\n") ?? "";
  assert.match(changes, /node scripts\/ci-neutralize-version-bumps\.mjs[\s\S]*dorny\/paths-filter/);
  assert.match(changes, /token: ""/);

  const base =
    '{\n  "version": "1.0.0-vorteo.1",\n  "dependencies": { "@getpaseo/client": "1.0.0-vorteo.1" }\n}\n';
  const bumped = base.replaceAll("vorteo.1", "vorteo.2");
  assert.equal(isVersionOnlyChange(base, bumped, "1.0.0-vorteo.1", "1.0.0-vorteo.2"), true);
  const withDependency = bumped.replace("}\n}", '}, "zod": "4.0.0"\n}');
  assert.equal(
    isVersionOnlyChange(base, withDependency, "1.0.0-vorteo.1", "1.0.0-vorteo.2"),
    false,
  );
  assert.equal(isVersionOnlyChange(base, base, "1.0.0-vorteo.1", "1.0.0-vorteo.1"), false);
});

test("ordinary CI keeps app tests without prebuilding Android modules", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const app = jobBlocks(source).get("app-tests").join("\n");
  assert.match(app, /npm run build:app-deps/);
  assert.match(app, /npm run test --workspace=@getpaseo\/app/);
  assert.doesNotMatch(source, /test:android|expo prebuild|gradlew|actions\/setup-java/);
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: [
      "plugins/**",
      "packages/server/**",
      "docker/tailscale/broker_*.py",
      "docker/tailscale/channel_identity.py",
      "docker/tailscale/test_broker_deployment.py",
      "packages/app/e2e/support/fixtures/recording.*",
    ],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/app/src/**/*.electron.{ts,tsx}",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/app/src/**/*.electron.{ts,tsx}",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

/** Desktop and Windows server suites run only on manual runs; see the heavy-suites test. */
function assertManualOnlyRouting(jobs, contextFor, selected, all) {
  // Desktop suites (PWA is the only release channel) and Windows server suites (no Windows
  // Host yet) run only on manual runs.
  const manualOnly = [
    ["desktop_apps", ["desktop-tests-ubuntu", "desktop-tests-windows"]],
    ["windows_host", ["server-tests-windows", "server-integration-windows"]],
  ];
  for (const [output, jobIds] of manualOnly) {
    const expression = new RegExp(`^      ${output}: \\$\\{\\{ (.+) \\}\\}$`, "m").exec(
      jobs.get("changes").join("\n"),
    )[1];
    for (const [event, ref, expected] of [
      ["merge_group", "refs/heads/gh-readonly-queue/main/pr-1-abc", false],
      ["schedule", "refs/heads/main", false],
      ["push", "refs/tags/release-26.11.500-beta", false],
      ["workflow_dispatch", "refs/heads/main", true],
    ]) {
      const value = String(runInNewContext(expression, contextFor(event, ref)));
      const outputs = { ...all, heavy: "true", [output]: value };
      for (const jobId of jobIds) {
        assert.equal(selected(jobs.get(jobId).join("\n"), outputs), expected, `${jobId} ${event}`);
      }
    }
  }
}

test("heavy suites run only on merge groups, manual and nightly runs and release tags", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const trigger = source.split("jobs:", 1)[0];
  for (const event of ["merge_group", "workflow_dispatch", "schedule"]) {
    assert.match(trigger, new RegExp(`^  ${event}:`, "m"));
  }
  assert.match(trigger, /push:\n\s+branches: \[main\]\n\s+tags: \["release-\*"\]/);
  const secretScan = readFileSync(new URL(".github/workflows/secret-scan.yml", repoRoot), "utf8");
  assert.match(secretScan.split("jobs:", 1)[0], /^  merge_group:/m, "scan is required");
  // Pull requests, merge groups and main pushes scan the commits they add; the nightly
  // and manual runs scan all reachable history. Branch pushes rely on their pull request.
  const scanTrigger = secretScan.split("jobs:", 1)[0];
  assert.match(scanTrigger, /push:\n\s+branches: \[main\]/);
  assert.match(scanTrigger, /^  schedule:/m);
  assert.match(scanTrigger, /^  workflow_dispatch:/m);
  assert.match(secretScan, /pull_request\) range="\$PR_BASE\.\.\$PR_HEAD"/);
  assert.match(secretScan, /merge_group\) range="\$QUEUE_BASE\.\.\$QUEUE_HEAD"/);
  assert.match(secretScan, /\*\) range="--all --full-history"/);
  assert.match(
    secretScan,
    /SECRET_SCAN_LOG_OPTS: \$\{\{ steps\.range\.outputs\.log_opts \}\}\n\s+run: npm run security:secrets/,
  );
  const secretsScript = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8")).scripts[
    "security:secrets"
  ];
  assert.match(secretsScript, /--log-opts="\$\{SECRET_SCAN_LOG_OPTS:---all --full-history\}"/);

  const jobs = jobBlocks(source);
  const heavy = /^      heavy: \$\{\{ (.+) \}\}$/m.exec(jobs.get("changes").join("\n"))[1];
  const contextFor = (event_name, ref = "refs/heads/main") => ({
    github: { event_name, ref },
    contains: (list, item) => list.includes(item),
    fromJSON: JSON.parse,
    startsWith: (text, prefix) => text.startsWith(prefix),
  });
  for (const [event, ref, expected] of [
    ["pull_request", "refs/pull/1/merge", false],
    ["push", "refs/heads/main", false],
    ["push", "refs/tags/release-26.11.500-beta", true],
    ["merge_group", "refs/heads/gh-readonly-queue/main/pr-1-abc", true],
    ["workflow_dispatch", "refs/heads/main", true],
    ["schedule", "refs/heads/main", true],
  ]) {
    assert.equal(runInNewContext(heavy, contextFor(event, ref)), expected, `${event} ${ref}`);
  }

  const condition = (job) => /^    if: \$\{\{ (.+) \}\}$/m.exec(job)?.[1] ?? "";
  const selected = (job, outputs, event = "workflow_dispatch") =>
    runInNewContext(condition(job), {
      ...contextFor(event),
      needs: { changes: { outputs } },
      cancelled: () => false,
    });
  const all = { full: "true" };
  for (const [jobId, lines] of jobs) {
    if (jobId === "changes") continue;
    const job = lines.join("\n");
    const isHeavy = heavyCiJobs.has(jobId);
    // Consumers of the shared server-stack build also wait for `build`, which itself
    // needs only `changes` so it never queues behind the required checks.
    assert.match(
      job,
      isHeavy
        ? /^    needs: \[changes, format, lint, typecheck(?:, build)?\]$/m
        : /^    needs: (?:changes|\[changes, build\])$/m,
      jobId,
    );
    // The smoke replaces the full Playwright suite only when routing says so.
    const smoke = jobId === "playwright-smoke";
    assert.equal(selected(job, { ...all, heavy: "true" }), jobId !== "cli-unit" && !smoke, jobId);
    assert.equal(
      selected(job, { ...all, heavy: "false" }, "pull_request"),
      !isHeavy && jobId !== "build",
      jobId,
    );
    // Missing routing outputs fail open to the heavy suites.
    assert.equal(selected(job, all), jobId !== "cli-unit" && !smoke, jobId);
  }
  // Merge groups run the Playwright smoke; nightly, manual and release runs the full shards.
  const e2e = /^      e2e: \$\{\{ (.+) \}\}$/m.exec(jobs.get("changes").join("\n"))[1];
  for (const [event, ref, full] of [
    ["merge_group", "refs/heads/gh-readonly-queue/main/pr-1-abc", false],
    ["schedule", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/main", true],
    ["push", "refs/tags/release-26.11.500-beta", true],
  ]) {
    const outputs = {
      ...all,
      heavy: "true",
      e2e: String(runInNewContext(e2e, contextFor(event, ref))),
    };
    assert.equal(selected(jobs.get("playwright-1").join("\n"), outputs), full, event);
    assert.equal(selected(jobs.get("playwright-smoke").join("\n"), outputs), !full, event);
  }
  // Model Actions' implicit success() guard as well as its dependency barrier.
  // A plain expression evaluator would miss the skipped-needs regression.
  function eligible(job, outputs, results, cancelled, context = contextFor("workflow_dispatch")) {
    const dependencies = /^    needs: (.+)$/m.exec(job)[1].replace(/[[\]]/g, "").split(/, */);
    if (dependencies.some((id) => results[id] === "in_progress")) return false;
    const expression = condition(job);
    const success = dependencies.every((id) => results[id] === "success");
    const hasStatusCheck = /\b(?:success|failure|cancelled|always)\(/.test(expression);
    if (!hasStatusCheck && !success) return false;
    const needs = Object.fromEntries(dependencies.map((id) => [id, { result: results[id] }]));
    needs.changes.outputs = outputs;
    return runInNewContext(expression, {
      ...context,
      needs,
      cancelled: () => cancelled,
      success: () => success,
    });
  }
  // Compare against direct changes-only dependencies using the same routing.
  // New routing outputs or heavy jobs must not change failure/skip scheduling.
  const eventOutputExpressions = [
    ...jobs
      .get("changes")
      .join("\n")
      .matchAll(/^      (\w+): \$\{\{ (.+) \}\}$/gm),
  ].filter(([, , expression]) => !expression.includes("steps."));
  const disabled = Object.fromEntries(
    [
      "full",
      "format",
      "quality",
      "hub",
      "server",
      "desktop",
      "app",
      "sdk",
      "browser",
      "relay",
      "cli",
    ].map((key) => [key, "false"]),
  );
  const completed = {
    changes: "success",
    format: "success",
    lint: "success",
    typecheck: "success",
    build: "success",
  };
  for (const [event, ref] of [
    ["pull_request", "refs/pull/1/merge"],
    ["push", "refs/heads/main"],
    ["push", "refs/tags/release-26.11.500-beta"],
    ["merge_group", "refs/heads/gh-readonly-queue/main/pr-1-abc"],
    ["workflow_dispatch", "refs/heads/main"],
    ["schedule", "refs/heads/main"],
  ]) {
    const eventOutputs = Object.fromEntries(
      eventOutputExpressions.map(([, name, expression]) => [
        name,
        String(runInNewContext(expression, contextFor(event, ref))),
      ]),
    );
    const routes = [{ full: "true", ...eventOutputs }, {}];
    if (event === "pull_request") {
      routes.push({ ...disabled, ...eventOutputs });
      for (const contract of Object.keys(disabled)) {
        routes.push({ ...disabled, [contract]: "true", ...eventOutputs });
      }
    }
    for (const outputs of routes) {
      const entries = [...jobs].filter(([id]) => id !== "changes");
      const before = JSON.stringify(
        entries
          .filter(([, lines]) =>
            eligible(
              lines.join("\n").replace(/^    needs: .+$/m, "    needs: changes"),
              outputs,
              completed,
              false,
              contextFor(event, ref),
            ),
          )
          .map(([id]) => id),
      );
      for (const results of [
        completed,
        { ...completed, lint: "failure" },
        { ...completed, typecheck: "skipped" },
        { ...completed, lint: "failure", typecheck: "skipped" },
        { ...completed, build: "failure" },
        { ...completed, build: "skipped" },
      ]) {
        const after = JSON.stringify(
          entries
            .filter(([, lines]) =>
              eligible(lines.join("\n"), outputs, results, false, contextFor(event, ref)),
            )
            .map(([id]) => id),
        );
        assert.equal(
          after,
          before,
          `${event} ${ref}: identical selected job sets after failure or skip`,
        );
        assert.equal(
          entries.some(([, lines]) =>
            eligible(lines.join("\n"), outputs, results, true, contextFor(event, ref)),
          ),
          false,
        );
      }
    }
  }
  for (const id of heavyCiJobs) {
    const job = jobs.get(id).join("\n");
    const outputs = {
      full: "true",
      heavy: "true",
      e2e: id === "playwright-smoke" ? "false" : "true",
    };
    assert.equal(eligible(job, outputs, completed, false), true, `${id} is selected`);
    for (const required of ["format", "lint", "typecheck"]) {
      assert.equal(
        eligible(job, outputs, { ...completed, [required]: "in_progress" }, false),
        false,
        `${id} waits for ${required}`,
      );
    }
  }
  assertManualOnlyRouting(jobs, contextFor, selected, all);
  // Cheap runs replace the Ubuntu integration chain with server unit tests.
  const server = jobs.get("server-tests-ubuntu").join("\n");
  assert.match(
    server,
    /- name: Run server unit tests\n\s+if: .*heavy == 'false'.*\n\s+run: npm run test:unit --workspace=@getpaseo\/server/,
  );
});

test("packaged installation browsers run only nightly and on manual dispatch", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const job = jobs.get("playwright-installation").join("\n");
  const condition = /^    if: \$\{\{ (.+) \}\}$/m.exec(job)[1];
  for (const [event_name, ref, expected] of [
    ["schedule", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/task-branch", true],
    ["pull_request", "refs/pull/185/merge", false],
    ["merge_group", "refs/heads/gh-readonly-queue/main/pr-185", false],
    ["push", "refs/heads/main", false],
    ["push", "refs/tags/release-26.11.601-beta", false],
  ]) {
    for (const cancelled of [false, true]) {
      assert.equal(
        runInNewContext(condition, {
          github: { event_name, ref },
          cancelled: () => cancelled,
        }),
        expected && !cancelled,
        `${event_name} ${ref}, cancelled=${cancelled}`,
      );
    }
  }
  assert.match(job, /^    needs: \[changes, format, lint, typecheck\]$/m);
  assert.match(job, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(job, /node-version: "22"/);
  assert.match(job, /run: node scripts\/npm-retry\.mjs ci/);
  assert.match(job, /run: npx playwright install --with-deps chromium/);
  assert.match(job, /run: npm run test:e2e:installation --workspace=@getpaseo\/app/);
  assert.doesNotMatch(job, /run: npm run build|--project=|--grep|continue-on-error/);
  assert.match(job, /if: \$\{\{ success\(\) \|\| failure\(\) \|\| cancelled\(\) \}\}/);
  assert.match(job, /uses: actions\/upload-artifact@v4/);
  assert.match(job, /packages\/app\/test-results\//);
  assert.match(job, /packages\/app\/playwright-report\//);
});

test("heavy suites reuse one server-stack build and build locally without it", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const build = jobs.get("build").join("\n");
  assert.match(build, /run: npm run build:server$/m);
  assert.match(
    build,
    /uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: server-stack-dist\n[\s\S]*retention-days: 1$/m,
  );
  // Windows builds natively; typecheck keeps its own build; cheap-only cli-unit never
  // overlaps the heavy-only build job.
  const consumers = [...jobs]
    .filter(([, lines]) => /^    needs: \[.*\bbuild\]$/m.test(lines.join("\n")))
    .map(([id]) => id);
  assert.deepEqual(consumers, [
    "server-tests-ubuntu",
    "server-tests-macos",
    "app-tests",
    ...Array.from({ length: 8 }, (_, index) => `playwright-${index + 1}`),
    "playwright-smoke",
    ...Array.from({ length: 3 }, (_, index) => `cli-tests-${index + 1}`),
  ]);
  const unpack = /&dist_unpack\n[\s\S]*?run: (.+)$/m.exec(
    jobs.get("server-tests-ubuntu").join("\n"),
  );
  assert.match(
    unpack[1],
    /^tar -xzf .+ && echo "PASEO_PREBUILT_SERVER_STACK=1" >> "\$GITHUB_ENV"$/,
  );
  // A consumer builds only when the unpack did not succeed, so a missing artifact fails open.
  for (const id of consumers) {
    const lines = jobs.get(id);
    const job = lines.join("\n");
    if (/^    steps: \*(playwright|cli)_test_steps$/m.test(job)) continue;
    assert.match(job, /- [*&]dist_unpack$/m, id);
    lines.forEach((line, index) => {
      if (!/^\s+run: npm run build\b/.test(line)) return;
      assert.equal(
        lines[index - 1].trim(),
        "if: ${{ env.PASEO_PREBUILT_SERVER_STACK != '1' }}",
        `${id}: ${line.trim()}`,
      );
    });
  }
  const runner = readFileSync(new URL("packages/cli/tests/run-all.ts", repoRoot), "utf8");
  assert.match(runner, /if \(process\.env\.PASEO_PREBUILT_SERVER_STACK === "1"\) \{/);
});

test("Nix packaging runs on main without allocating pull-request runners", () => {
  const source = readFileSync(nixWorkflowPath, "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.doesNotMatch(trigger, /pull_request/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  // Desktop packages build only on manual runs while PWA is the only release channel.
  assert.match(trigger, /^  workflow_dispatch:/m);
  const darwin = jobBlocks(source).get("build-desktop-darwin").join("\n");
  assert.match(darwin, /^    if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}$/m);
  assert.match(
    source,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}\n\s+run: nix build \.#desktop -o result-desktop/,
  );
});

test("container installation smokes run after merge and on demand, not on pull requests", () => {
  const source = readFileSync(dockerWorkflowPath, "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.doesNotMatch(trigger, /^  pull_request:/m);
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]\s*\n\s+paths:/);
  assert.match(trigger, /^  workflow_dispatch:/m);
  assert.match(trigger, /- "docker\/\*\*"/);
  assert.match(source, /architecture: \[amd64, arm64\]/);
  // Each architecture runs natively; QEMU emulation made the arm64 smoke the slowest job.
  assert.match(
    source,
    /runs-on: \$\{\{ matrix\.architecture == 'arm64' && 'ubuntu-24\.04-arm' \|\| 'ubuntu-latest' \}\}/,
  );
  assert.doesNotMatch(source, /setup-qemu-action/);
  assert.match(source, /bash docker\/multiplex\/smoke.sh paseo-container:check/);
  // Version-only manifest bumps do not rebuild the container; manual runs always do.
  const jobs = jobBlocks(source);
  const changes = jobs.get("changes").join("\n");
  assert.match(changes, /node scripts\/ci-neutralize-version-bumps\.mjs[\s\S]*dorny\/paths-filter/);
  for (const path of ["docker/**", "package-lock.json", "packages/server/**"]) {
    assert.ok(changes.includes(`- "${path}"`), path);
  }
  const verify = jobs.get("verify").join("\n");
  assert.match(verify, /^    needs: changes$/m);
  const condition = /^    if: \$\{\{ (.+) \}\}$/m.exec(verify)[1];
  const run = (event_name, container) =>
    runInNewContext(condition, {
      github: { event_name },
      needs: { changes: { outputs: container === undefined ? {} : { container } } },
    });
  assert.equal(run("push", "false"), false);
  assert.equal(run("push", "true"), true);
  assert.equal(run("push", undefined), true);
  assert.equal(run("workflow_dispatch", "false"), true);
  assert.match(jobs.get("smoke").join("\n"), /^    needs: verify$/m);
});

test("desktop packaging smokes run only on manual runs while PWA is the only channel", () => {
  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.doesNotMatch(trigger, /^  push:/m);
  assert.doesNotMatch(trigger, /^  pull_request:/m);
  assert.match(trigger, /^  workflow_dispatch:/m);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});

test("stable iOS releases upload once and distribute to external testers before App Store review", () => {
  const source = readFileSync(
    new URL("packages/app/.eas/workflows/release-mobile.yml", repoRoot),
    "utf8",
  );
  const jobs = jobBlocks(source);
  const uploads = [...jobs.entries()].filter(
    ([, lines]) =>
      lines.some((line) => /^    type: (submit|testflight)$/.test(line)) &&
      lines.some((line) => line.includes("needs.build_ios.outputs.build_id")),
  );
  assert.equal(uploads.length, 1, "the iOS binary must be uploaded exactly once");
  const [distributionId, distributionLines] = uploads[0];
  const distribution = distributionLines.join("\n");
  assert.match(distribution, /^    type: testflight$/m);
  assert.match(distribution, /external_groups:\s*\n\s+- Paseo Beta/);
  assert.match(distribution, /^      submit_beta_review: true$/m);

  const review = jobs.get("submit_ios_for_review").join("\n");
  assert.match(review, new RegExp(`needs: \\[build_ios, ${distributionId}\\]`));
  assert.match(review, /APP_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_version \}\}"/);
  assert.match(
    review,
    /APP_BUILD_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_build_version \}\}"/,
  );
  assert.match(review, /bundle exec fastlane ios submit_review/);
});

test("eight Playwright shards share two-worker coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  assert.equal(jobs.size, 28);
  assert.ok(jobs.has("installer-tests"));
  // The shared server-stack build is a fan-out producer, not a result gate.
  assert.ok(jobs.has("build"));
  for (let shard = 1; shard <= 8; shard++) {
    const job = jobs.get(`playwright-${shard}`).join("\n");
    assert.match(job, new RegExp(`PLAYWRIGHT_SHARD: "${shard}/8"`));
    assert.match(job, new RegExp(`PLAYWRIGHT_ARTIFACT: "${shard}"`));
    assert.match(
      job,
      shard === 1 ? /steps: &playwright_test_steps/ : /steps: \*playwright_test_steps/,
    );
  }
  const shared = jobs.get("playwright-1").join("\n");
  assert.match(shared, /E2E_WORKERS: "2"/);
  const weights = /PWTEST_SHARD_WEIGHTS: "([\d:]+)"/.exec(shared)[1].split(":").map(Number);
  assert.equal(weights.length, 8);
  assert.ok(weights.every((weight) => weight > 0));
  assert.match(shared, /npm run test:e2e --workspace=@getpaseo\/app -- --shard=/);

  // No fan-in result job: a gate needs its own runner and under contention it
  // queued 8m08s behind the last shard. Required checks name the shards directly.
  assert.equal(jobs.has("playwright"), false);
});

test("quality preserves commands and routes each domain independently after failures", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const quality = jobs.get("quality").join("\n");
  assert.doesNotMatch(quality, /^\s+continue-on-error:/m);
  // The required format and lint jobs keep their commands; quality runs the rest.
  const format = jobs.get("format").join("\n");
  assert.match(format, /^        run: npm run format:check$/m);
  const lint = jobs.get("lint").join("\n");
  for (const command of [
    "npx --yes lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
    "npx --yes npm@11.19.1 audit signatures",
    "npm run lint",
  ]) {
    assert.ok(
      lint.includes(`        run: ${command}\n`) || lint.endsWith(`        run: ${command}`),
      command,
    );
  }
  const commands = {
    quality: ["node --test scripts/oxlint/paseo-plugin.test.mjs"],
    relay: ["npm run build:relay", "npm run test --workspace=@getpaseo/relay"],
    sdk: [
      "npm run build:relay && npm run build:client",
      "npm run build:plugin",
      "npm run test --workspace=@getpaseo/plugin",
      "npm run test --workspace=@getpaseo/protocol",
      "npm run test --workspace=@getpaseo/client",
      "npm run test --workspace=@getpaseo/highlight",
      "npm run typecheck:examples --workspace=@getpaseo/client",
    ],
  };
  const checks = [...quality.matchAll(/        if: \$\{\{ (.+) \}\}\n        run: (.+)/g)];
  assert.deepEqual(
    checks.map(([, , command]) => command),
    Object.values(commands).flat(),
  );
  const domains = Object.keys(commands);
  function accepts(expression, outputs, { cancelled = false, installed = true } = {}) {
    // Prior checks have failed: success() is false. Explicit !cancelled() must
    // override Actions' default success condition so later domains still run.
    assert.match(expression, /!cancelled\(\)/);
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      steps: { install: { outcome: installed ? "success" : "failure" } },
      cancelled: () => cancelled,
      success: () => false,
    });
  }
  const disabled = { full: "false", ...Object.fromEntries(domains.map((key) => [key, "false"])) };
  const jobCondition = /    if: \$\{\{ (.+) \}\}/.exec(quality)[1];
  assert.equal(accepts(jobCondition, disabled), false);
  for (const selected of domains) {
    const outputs = { ...disabled, [selected]: "true" };
    assert.equal(accepts(jobCondition, outputs), true);
    for (const [, expression, command] of checks) {
      assert.equal(accepts(expression, outputs), commands[selected].includes(command), command);
    }
  }
  for (const [, expression] of checks) {
    assert.equal(accepts(expression, { ...disabled, full: "true" }), true);
    assert.equal(accepts(expression, {}), true, "missing routing outputs fail open");
    assert.equal(accepts(expression, {}, { cancelled: true }), false);
    assert.equal(accepts(expression, {}, { installed: false }), false);
  }
  assert.equal(accepts(jobCondition, {}, { cancelled: true }), false);
});

test("Windows units and integration run independently with complete routed coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const ubuntu = jobs.get("server-tests-ubuntu").join("\n");
  const windows = jobs.get("server-tests-windows").join("\n");
  const integration = jobs.get("server-integration-windows").join("\n");
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/server/);
  assert.match(windows, /run: npm run test:unit --workspace=@getpaseo\/server/);
  assert.doesNotMatch(windows, /run: npm run test(?: |:integration)/);
  assert.match(integration, /run: npm run test:integration --workspace=@getpaseo\/server/);
  assert.doesNotMatch(integration, /test:unit|server_plugin_tests|server_hub_contract/);
  for (const job of [windows, integration]) {
    assert.match(
      job,
      /^    needs: \[changes, format, lint, typecheck\]$/m,
      "both phases become eligible independently after required checks finish",
    );
    assert.match(job, /^    runs-on: windows-latest$/m);
    assert.doesNotMatch(job, /continue-on-error|maxWorkers|--exclude/);
    for (const step of [
      "server_capacity",
      "server_checkout",
      "server_node",
      "server_fetch",
      "server_install",
      "server_agent_clis",
      "server_build",
    ]) {
      assert.match(ubuntu, new RegExp(`&${step}\\b`));
      assert.match(job, new RegExp(`- \\*${step}\\b`));
    }
    assert.match(job, /env: \*server_test_env/);
  }
  assert.match(windows, /- \*server_plugin_tests/);
  assert.match(windows, /- \*server_hub_contract/);
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/builtin-plugins/);
  assert.match(ubuntu, /run: npm run test:hub-cli-contract --workspace=@getpaseo\/server/);

  const scripts = JSON.parse(
    readFileSync(new URL("packages/server/package.json", repoRoot), "utf8"),
  ).scripts;
  assert.equal(scripts.test, "npm run test:unit && npm run test:integration");
  assert.equal(scripts["test:unit"], 'vitest run --fileParallelism --exclude "**/*.e2e.test.ts"');
  const invocations = scripts["test:integration"].split(" && ");
  // Each vitest start costs about half a minute on Windows, so the
  // name-filtered files share one invocation and one combined filter.
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((command) => command.startsWith("vitest run --maxWorkers=1 ")));
  assert.doesNotMatch(invocations[0], / -t /);
  assert.equal(
    invocations[1],
    'vitest run --maxWorkers=1 src/server/agent/providers/omp/history.e2e.test.ts src/server/daemon-e2e/git-operations.e2e.test.ts src/server/session.create-agent-worktree-autoarchive.e2e.test.ts src/server/agent/providers/opencode-bridge.local.e2e.test.ts src/server/daemon-e2e/relay-transport.e2e.test.ts -t "merges into|creates a worktree and auto-archives both|versioned runtime|oversized attachments|connected hosts|password-protected daemon refuses|replays selected OMP history"',
  );
  const serverConfig = readFileSync(new URL("packages/server/vitest.config.ts", repoRoot), "utf8");
  assert.match(serverConfig, /maxWorkers: process.platform === "win32" \? 2 : undefined/);

  function condition(job) {
    return /    if: \$\{\{ (.+) \}\}/.exec(job)[1];
  }
  function selected(expression, outputs, cancelled = false) {
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      cancelled: () => cancelled,
    });
  }
  const unitCondition = condition(windows);
  const integrationCondition = condition(integration);
  const unitStep = /      - name: Run server unit tests\n        if: \$\{\{ (.+) \}\}/.exec(
    windows,
  )[1];
  const hubStep =
    /      - &server_hub_contract\n        name: Run Hub CLI\/daemon contract\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  const pluginStep =
    /      - &server_plugin_tests\n        name: Run built-in plugin tests\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  for (const [outputs, units, integrations, hub] of [
    [{ full: "true", server: "false", hub: "false" }, true, true, false],
    [{ full: "false", server: "true", hub: "false" }, true, true, false],
    [{ full: "false", server: "false", hub: "true" }, true, false, true],
    [{ full: "false", server: "false", hub: "false" }, false, false, false],
    [{}, true, true, false],
  ]) {
    assert.equal(selected(unitCondition, outputs), units);
    assert.equal(selected(integrationCondition, outputs), integrations);
    assert.equal(selected(unitStep, outputs), integrations);
    assert.equal(selected(pluginStep, outputs), integrations);
    assert.equal(selected(hubStep, outputs), hub);
    assert.equal(selected(unitCondition, outputs, true), false);
    assert.equal(selected(integrationCondition, outputs, true), false);
  }
});

test("macOS release retries only transient stapling failures without rebuilding the signed app", async (t) => {
  const workflow = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  const wrapper = workflow
    .match(/<<'STAPLER'\n([\s\S]*?)\n          STAPLER/)[1]
    .replace(/^          /gm, "");
  const networkError =
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
  const cases = [
    {
      name: "success",
      outcomes: [0],
      output: "stapled",
      command: "stapler",
      expected: 0,
      attempts: 1,
    },
    {
      name: "transient then success",
      outcomes: [68, 0],
      output: networkError,
      command: "stapler",
      expected: 0,
      attempts: 2,
    },
    {
      name: "exhausted network retries",
      outcomes: [68, 68, 68, 68, 0],
      output: networkError,
      command: "stapler",
      expected: 68,
      attempts: 4,
    },
    {
      name: "non-network staple error",
      outcomes: [68, 0],
      output: "ticket not found",
      command: "stapler",
      expected: 68,
      attempts: 1,
    },
    {
      name: "different exit code",
      outcomes: [1, 0],
      output: networkError,
      command: "stapler",
      expected: 1,
      attempts: 1,
    },
    {
      name: "notary submission is not retried",
      outcomes: [68, 0],
      output: networkError,
      command: "notarytool",
      expected: 68,
      attempts: 1,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const directory = mkdtempSync(join(tmpdir(), "stapler-retry-"));
      try {
        const statePath = join(directory, "state.json");
        const realXcrun = join(directory, "real-xcrun");
        const wrapperPath = join(directory, "xcrun");
        writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
        writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(
          statePath,
          JSON.stringify({ outcomes: scenario.outcomes, output: scenario.output, calls: [] }),
        );
        writeFileSync(
          realXcrun,
          `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STAPLER_STATE, "utf8"));
state.calls.push(process.argv.slice(2));
const code = state.outcomes.shift();
fs.writeFileSync(process.env.STAPLER_STATE, JSON.stringify(state));
console.log(state.output);
process.exit(code);
`,
          { mode: 0o755 },
        );
        const args = [scenario.command, "staple", "-v", "Paseo signed.app"];
        const result = spawnSync("bash", [wrapperPath, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            PASEO_REAL_XCRUN: realXcrun,
            STAPLER_STATE: statePath,
            PATH: `${directory}:${process.env.PATH}`,
          },
          timeout: 5000,
        });
        assert.equal(result.status, scenario.expected, result.stdout + result.stderr);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(
          state.calls,
          Array.from({ length: scenario.attempts }, () => args),
        );
        assert.match(result.stdout, /stapled|network connection was lost|ticket not found/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

// GitHub retires macOS 14 on 2026-11-02; brownouts already reject these jobs.
test("workflows avoid retired macOS 14 runners", () => {
  for (const path of filesUnder(".github/workflows", (candidate) => /\.ya?ml$/.test(candidate))) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /macos-14(?:-large|-xlarge)?\b/,
      path,
    );
  }
});

test("macOS jobs use supported pinned runners while preserving release architectures", () => {
  for (const [workflow, jobId] of [
    [ciWorkflowPath, "server-tests-macos"],
    [nixWorkflowPath, "build-desktop-darwin"],
  ]) {
    assert.match(
      jobBlocks(readFileSync(workflow, "utf8")).get(jobId).join("\n"),
      /^    runs-on: macos-15$/m,
    );
  }
  const release = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  assert.match(release, /runner: macos-15\n\s+electron_arch: arm64/);
  // GitHub has no standard macos-latest-intel alias; use the newest Intel image.
  assert.match(release, /runner: macos-26-intel\n\s+electron_arch: x64/);
});

test("Nix desktop packaging resolves the workspace-local builder", () => {
  const source = readFileSync(new URL("nix/desktop-package.nix", repoRoot), "utf8");
  const invocation = source.match(/^\s+([^\n]*electron-builder) \\\n/m)?.[1];
  assert.ok(invocation, "Nix invokes the desktop packaging tool");
  const directory = mkdtempSync(join(tmpdir(), "nix-builder-resolution-"));
  try {
    const desktop = join(directory, "packages/desktop");
    mkdirSync(join(desktop, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(desktop, "node_modules/electron-builder"));
    writeFileSync(
      join(desktop, "node_modules/electron-builder/package.json"),
      JSON.stringify({
        name: "electron-builder",
        version: "1.0.0",
        bin: { "electron-builder": "../.bin/electron-builder" },
      }),
    );
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/desktop"] }),
    );
    writeFileSync(
      join(desktop, "package.json"),
      JSON.stringify({
        name: "desktop-fixture",
        private: true,
        devDependencies: { "electron-builder": "1.0.0" },
      }),
    );
    writeFileSync(
      join(desktop, "node_modules/.bin/electron-builder"),
      '#!/bin/sh\nprintf "workspace-builder\\n"\n',
      { mode: 0o755 },
    );
    const result = spawnSync("sh", ["-c", `${invocation} --version`], {
      cwd: desktop,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "workspace-builder");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
