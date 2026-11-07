import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPreviewBrokerDeploymentExecutor } from "./preview-broker-deployment-executor.js";
import { createPreviewBrokerExecutor } from "./preview-broker-executor.js";
import { inspectMaintenanceObservationRuntime } from "./coordinator-bootstrap-maintenance-observation-runtime.js";
import { reconcileNativeInitialHostActivation } from "./maintenance/host-supervisor-activation.js";
import { createNativeMaintenanceServiceExecutor } from "./coordinator-bootstrap-maintenance-service-producer.js";
import { observeNativeMaintenanceServices } from "./coordinator-bootstrap-maintenance-health.js";
import { observeNativeRecoveryAccess } from "./coordinator-bootstrap-maintenance-recovery-native-ports.js";
import { createNativeMaintenanceServiceRouter } from "./coordinator-bootstrap-maintenance-service-routing.js";
import { initializePackagedClaudeCli } from "../agent/providers/claude/packaged-cli.js";
import { createPreviewMonitorExecutor } from "./preview-monitor-executor.js";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveDaemonVersion } from "../daemon-version.js";
import { createOperationalTelemetry } from "./operational-telemetry.js";
import { createCoordinatorDispatchNotifier } from "./coordinator-dispatch-notifier.js";
import { createOperationalStore } from "./operational-telemetry-store.js";
import { createNativeHelperExecutor } from "./native-helper-executor.js";
import { createSessionHostExecutor } from "./session-host-job.js";
import { createNativeSessionHostPorts } from "./session-host-job-native.js";
import {
  inspectBootstrapWritableMountRoots,
  createHostReconciliationLedger,
} from "./coordinator-bootstrap-host.js";
import { loadCoordinatorStartupFence } from "./coordinator-bootstrap-startup.js";
import { createClaudeSetupRuntime } from "./accounts/claude-setup-runtime.js";
import { createClaudeOAuthRuntime } from "./accounts/claude-oauth-runtime.js";
import { createProviderSecretsRuntime } from "./accounts/provider-secrets-runtime.js";
import { createProjectSyncRuntime } from "./project-sync.js";
import { createCodexSignInRuntime } from "./accounts/codex-signin-runtime.js";
import { createInstallationProfiles, startProfileSynchronization } from "./profiles/runtime.js";
import pino from "pino";
import {
  claudeHostRefreshEnabled,
  codexHostRefreshEnabled,
  parseInstallationConfig,
} from "./config.js";
import { createInstallationServer } from "./server.js";
import {
  connectInstallationDaemon,
  createInstallationRegistrationAdmission,
  createInstallationRestartExecutor,
} from "./daemon.js";
import { createInstallationDaemonConnections } from "./daemon-connections.js";
import { createInstallationSettings, startSettingsReconciliation } from "./settings/runtime.js";

const configFile = process.argv[2];
if (!configFile) throw new Error("Usage: installation-entrypoint <private-config-file>");
// The exact bytes this coordinator runs; settings changes judge a silent restart against them.
const configText = readFileSync(configFile, "utf8");
const config = parseInstallationConfig(configText);
const logger = pino({ name: "vorteo-installation" });
const startupFence = loadCoordinatorStartupFence({
  installationId: config.public.installationId,
  stateDirectory: config.stateDir,
  node: realpathSync(process.execPath),
  entrypoint: realpathSync(process.argv[1]!),
  configuration: realpathSync(configFile),
});
// This installation entrypoint uses its release CLI, independent of daemon worker markers.
initializePackagedClaudeCli(true);
function assertRegistrationReadiness(target: "host" | "container-daemon"): void {
  app.assertRegistrationReadiness(target);
}
// Periodic settings, profile and restart-impact reads share one connection per
// environment instead of opening a fresh one each pass.
const daemonConnections = createInstallationDaemonConnections((kind) =>
  connectInstallationDaemon(config, kind),
);
const executor = createInstallationRestartExecutor(
  config,
  assertRegistrationReadiness,
  logger,
  daemonConnections.connect,
);
if (process.platform === "darwin") {
  executor.reconcileInitialHostActivation = () =>
    reconcileNativeInitialHostActivation({
      configuration: config,
      configurationFile: realpathSync(configFile),
    });
  executor.observeRecoveryAccess = (signal) =>
    observeNativeRecoveryAccess({
      installationId: config.public.installationId,
      stateDirectory: config.stateDir,
      signal,
    });
  executor.observeMaintenanceServices = (signal) =>
    observeNativeMaintenanceServices({
      installationId: config.public.installationId,
      stateDirectory: config.stateDir,
      signal,
    });
  executor.discoverMaintenanceServices = async () => {
    const observationRuntime = await inspectMaintenanceObservationRuntime({
      configuration: config,
      configurationFile: realpathSync(configFile),
    });
    return createNativeMaintenanceServiceRouter({
      installationId: config.public.installationId,
      stateDirectory: config.stateDir,
      mode: "replacement-only",
      observeRetained: async (request, reservation, executorTarget) => {
        const observer = await createNativeMaintenanceServiceExecutor({
          installationId: config.public.installationId,
          stateDirectory: config.stateDir,
          executorTarget,
          observationRuntime,
        });
        return observer.observe(request, reservation);
      },
    });
  };
}
if (config.nativeHelper) {
  if (process.platform !== "darwin")
    throw new Error("Native helper maintenance requires macOS Host");
  const helper = config.nativeHelper;
  Object.assign(
    executor,
    createNativeHelperExecutor({
      home: helper.home,
      installationId: config.public.installationId,
      writableMountRoots: () => inspectBootstrapWritableMountRoots(helper),
    }),
  );
}
// The coordinator owns the session host's launchd job wherever Host releases are selected
// through the current link. The lifecycle queue registers the matching release guard itself.
if (config.sourceUpdates && config.host.startupValidation && process.platform === "darwin")
  Object.assign(
    executor,
    createSessionHostExecutor({ config, ports: createNativeSessionHostPorts() }),
  );
if (config.previewMonitor)
  Object.assign(
    executor,
    createPreviewMonitorExecutor({
      installationId: config.public.installationId,
      configuration: config.previewMonitor,
      writableMountRoots: () => inspectBootstrapWritableMountRoots(config.previewMonitor!),
    }),
  );
if (config.previewBrokerDeployment && process.platform === "darwin") {
  executor.brokerDeployment = createPreviewBrokerDeploymentExecutor({
    config,
    configurationFile: {
      path: realpathSync(configFile),
      sha256: createHash("sha256").update(readFileSync(configFile)).digest("hex"),
    },
    assertActive() {
      if (startupFence && !startupFence.released())
        throw new Error("Coordinator startup remains fenced");
    },
    writableMountRoots: () => inspectBootstrapWritableMountRoots(config.previewBrokerDeployment!),
  });
}
if (config.previewBroker && process.platform === "darwin")
  Object.assign(
    executor,
    createPreviewBrokerExecutor({
      config,
      writableMountRoots: () => inspectBootstrapWritableMountRoots(config.previewBroker!),
    }),
  );
const profiles = createInstallationProfiles(
  config,
  assertRegistrationReadiness,
  daemonConnections.connect,
);
const settings = createInstallationSettings(
  config,
  assertRegistrationReadiness,
  daemonConnections.connect,
);
let stopProfileSynchronization: (() => void) | undefined;
let stopSettingsReconciliation: (() => void) | undefined;
let synchronizing = false;
function activateSynchronization() {
  if (synchronizing || (startupFence && !startupFence.released())) return;
  stopProfileSynchronization = startProfileSynchronization(profiles, logger);
  stopSettingsReconciliation = startSettingsReconciliation(settings, logger);
  void telemetry.start().catch(() => {
    logger.warn("Optional operational telemetry could not start");
  });
  synchronizing = true;
}
// Assigned below; the setup-token flow stays out of an account's full sign-in upgrade.
let upgradingClaudeAccount: (definitionId: string) => boolean = () => false;
const claudeSetup = createClaudeSetupRuntime(config, settings, assertRegistrationReadiness, {
  signInBlocked: (definitionId) => upgradingClaudeAccount(definitionId),
});
const host = config.public.environments.find((environment) => environment.kind === "host");
if (!host) throw new Error("Installation Host identity is missing");
const coordinatorRequests = createHostReconciliationLedger(config, configFile, host.serverId);
// Off unless a reviewed coordinator update set the installation lead.
const installationLead = config.installationLead;
let installationLeadTimer: NodeJS.Timeout | undefined;
if (installationLead && coordinatorRequests) {
  const ledger = coordinatorRequests;
  const notifier = createCoordinatorDispatchNotifier({
    agentId: installationLead.agentId,
    stateDirectory: config.stateDir,
    ports: {
      list: () => ledger.list(),
      readLifecycle: () => {
        if (!ledger.readLifecycle) throw new Error("Installation journal is unavailable");
        return ledger.readLifecycle();
      },
      leadAvailable: async (agentId) => {
        const client = await daemonConnections.connect("host");
        try {
          const lead = await client.fetchAgent({ agentId });
          return lead !== null && !lead.agent.archivedAt;
        } finally {
          await client.close();
        }
      },
      enqueue: async ({ agentId, text, messageId }) => {
        const client = await daemonConnections.connect("host");
        try {
          // The queue delivers only while the lead is idle and skips an archived thread.
          const result = await client.mutateMessageQueue(agentId, {
            kind: "enqueue",
            operationId: messageId,
            messageId,
            attachments: [],
            text,
          });
          if (result.error) throw new Error(result.error.message);
        } finally {
          await client.close();
        }
      },
      now: Date.now,
    },
  });
  installationLeadTimer = setInterval(() => {
    void notifier.check().catch(() => logger.warn("Installation lead notification is pending"));
  }, 60_000);
  installationLeadTimer.unref();
}
const claudeSetupTimer = setInterval(() => {
  if (!synchronizing) return;
  void claudeSetup
    .reconcile()
    .catch(() => logger.warn("Claude subscription synchronization is pending"));
}, 5000);
claudeSetupTimer.unref();
// Static provider secrets (API keys and tokens) are stored here once and delivered everywhere.
const providerSecrets = createProviderSecretsRuntime(config, settings, assertRegistrationReadiness);
const providerSecretsTimer = setInterval(() => {
  if (!synchronizing) return;
  void providerSecrets
    .reconcile()
    .catch(() => logger.warn("Provider key synchronization is pending"));
}, 5000);
providerSecretsTimer.unref();
// Projects registered on any environment exist on every environment that shares the folder.
const assertProjectSyncReady = createInstallationRegistrationAdmission(
  config,
  assertRegistrationReadiness,
);
const projectSync = createProjectSyncRuntime({
  environments: config.public.environments.map((environment) => environment.kind),
  connect: daemonConnections.connect,
  assertReady: (kind) => assertProjectSyncReady(kind === "host" ? "host" : "container-daemon"),
  logger,
});
let projectSyncRunning = false;
const projectSyncTimer = setInterval(() => {
  if (!synchronizing || projectSyncRunning) return;
  projectSyncRunning = true;
  void projectSync
    .reconcile()
    .catch(() => logger.warn("Project synchronization is pending"))
    .finally(() => (projectSyncRunning = false));
}, 15_000);
projectSyncTimer.unref();
// Opt-in: Host-owned refresh for full sign-in Claude accounts (`claudeHostRefresh: true`).
const claudeOAuth = claudeHostRefreshEnabled(config)
  ? createClaudeOAuthRuntime(config, settings, assertRegistrationReadiness, { setup: claudeSetup })
  : undefined;
if (claudeOAuth) upgradingClaudeAccount = claudeOAuth.upgrading;
const claudeOAuthTimer = claudeOAuth
  ? setInterval(() => {
      if (!synchronizing) return;
      void claudeOAuth.reconcile().catch(() => logger.warn("Claude sign-in refresh is pending"));
    }, 30_000)
  : undefined;
claudeOAuthTimer?.unref();
// Opt-in: shared Codex accounts sign in once on the Host (`codexHostRefresh: true`).
const codexSignIn = codexHostRefreshEnabled(config)
  ? createCodexSignInRuntime(config, settings, assertRegistrationReadiness)
  : undefined;
const codexSignInTimer = codexSignIn
  ? setInterval(() => {
      if (!synchronizing) return;
      void codexSignIn.reconcile().catch(() => logger.warn("Codex sign-in refresh is pending"));
    }, 30_000)
  : undefined;
codexSignInTimer?.unref();
const app = createInstallationServer(
  config,
  executor,
  logger,
  profiles,
  settings,
  undefined,
  claudeSetup,
  startupFence,
  coordinatorRequests,
  claudeOAuth,
  providerSecrets,
  {
    configFile: realpathSync(configFile),
    startupSha256: createHash("sha256").update(configText).digest("hex"),
  },
  codexSignIn,
);
const telemetry = createOperationalTelemetry({
  enabled: config.operationalTelemetryEnabled === true,
  version: resolveDaemonVersion(),
  clock: { now: Date.now, monotonic: () => performance.now() },
  writer: createOperationalStore(join(config.stateDir, "operational-telemetry-v1")),
  observe() {
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const connections = daemonConnections.operationalSnapshot();
    return {
      coordinator: {
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        uptimeSeconds: process.uptime(),
      },
      diskAvailableBytes: null,
      queues: app.operationalQueueSummary(),
      hostConnection: connections.host,
      devConnection: connections.container,
    };
  },
  schedule(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
});
if (config.operationalTelemetryEnabled === true) app.setOperationalActivitySink(telemetry);
activateSynchronization();
const restartTimer = setInterval(() => {
  try {
    activateSynchronization();
  } catch {
    logger.warn("Coordinator synchronization remains fenced for recovery");
  }
  void app.drainRestarts();
}, 2000);
restartTimer.unref();
// The release update check: shortly after start, then hourly. GitHub's unauthenticated limit
// is 60 requests an hour, so one request an hour leaves room for the interface's own check.
const RELEASE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const releaseCheck = () =>
  void app.checkReleases().catch((error) => logger.warn({ err: error }, "Update check failed"));
setTimeout(releaseCheck, 60_000).unref();
setInterval(releaseCheck, RELEASE_CHECK_INTERVAL_MS).unref();
const server = app.listen(config.listenPort, "127.0.0.1", () =>
  logger.info("Installation coordinator ready"),
);
// Live dev mode's Fast Refresh socket; every other upgrade is refused as before.
server.on("upgrade", (req, socket, head) => {
  if (!app.handleLiveDevUpgrade(req, socket, head)) socket.destroy();
});
server.on("error", (error) => {
  logger.error({ err: error }, "Installation listener failed");
  process.exitCode = 1;
});
// Linux Docker bridges cannot reach Host loopback; the gate route then needs this listener.
// The server admits only the gate authority's agent routes on it, as on loopback.
const gateListenAddress = config.container ? config.access?.gateRoute?.listenAddress : undefined;
const gateServer = gateListenAddress
  ? app.listen(config.listenPort, gateListenAddress, () =>
      logger.info("Installation gate route listener ready"),
    )
  : undefined;
gateServer?.on("error", (error) => {
  logger.error({ err: error }, "Installation gate route listener failed");
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    telemetry.stop();
    clearInterval(installationLeadTimer);
    clearInterval(restartTimer);
    clearInterval(claudeSetupTimer);
    clearInterval(providerSecretsTimer);
    if (claudeOAuthTimer) clearInterval(claudeOAuthTimer);
    if (codexSignInTimer) clearInterval(codexSignInTimer);
    void claudeSetup.dispose();
    void claudeOAuth?.dispose();
    void codexSignIn?.dispose();
    stopProfileSynchronization?.();
    stopSettingsReconciliation?.();
    daemonConnections.close();
    void app.stopLiveDev();
    server.close();
    gateServer?.close();
  });
