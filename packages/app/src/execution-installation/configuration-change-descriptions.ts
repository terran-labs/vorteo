import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  planConfigurationChanges,
  type ReviewedConfigurationSetting,
  type ReviewedConfigurationValue,
} from "@getpaseo/protocol/coordinator-configuration-settings";

type Descriptions = {
  [S in ReviewedConfigurationSetting]: (value: ReviewedConfigurationValue<S> | null) => string;
};

/**
 * Review text for every registered coordinator setting. The type requires an entry
 * for each setting, and the client offers to review every registered setting, so a
 * new setting cannot reach approval without a description here.
 */
const DESCRIPTIONS: Descriptions = {
  operationalTelemetryEnabled: (config) =>
    config === null
      ? "Turn off future coordinator performance samples. Keep retained private logs."
      : "Turn on private minute-by-minute coordinator performance logging, up to 12 MiB. Records process CPU and memory, cached queue and connection health, and fixed operation status labels; no prompts or account content.",
  installationLead: (lead) =>
    lead === null
      ? "Stop notifying an installation lead thread about failed or stalled coordinator updates."
      : `Notify agent thread ${lead.agentId} once when a coordinator update fails before it starts or stalls after approval. The thread receives a message only; it gains no approval or installation authority.`,
  containerSourceUpdateNode: (node) =>
    node === null
      ? "This plan cannot remove the Node executable required by Dev source updates."
      : `Use ${node} for subsequent Dev source updates. This does not replace the running supervisor or restart Dev.`,
  factoryRuntimeAdoption: (config) =>
    config === null
      ? "Disable new Factory startup adoption requests. Existing recovery requirements remain."
      : `Configure Factory startup adoption plan ${config.sha256}. Adopting startup still requires a separate approval.`,
  previewBrokerDeployment: (config) =>
    config === null
      ? "Disable new broker consumer deployments. Retained recovery evidence remains."
      : "Configure the protected broker pair and declared participant scope. Consumer replacement requires a separate exact approval; channel trust is unchanged.",
  previewBroker: (config) =>
    config === null
      ? "Disable new broker trust migrations. Retained jobs and fences remain."
      : "Configure manual broker channel identity migration for two exact protected configs. Trust activation requires a separate exact approval; no hostname or service change is included.",
  previewMonitor: (config) =>
    config === null
      ? "Disable new preview monitor requests. Existing receipts remain in history."
      : "Enable Dev preview monitor maintenance with compatible selected and recovery coordinators. Each replacement still requires its own approval.",
  claudeHostRefresh: (config) =>
    config === null
      ? "Turn off Host-owned refresh for full sign-in Claude accounts. Dev loses those accounts when their current access expires, within about 8 hours, and new full sign-in accounts can no longer be added. Host use and setup-token accounts are unaffected."
      : "Turn on Host-owned refresh for full sign-in Claude accounts. The Host keeps each account signed in and sends Dev short-lived access, so long Dev turns survive token expiry. Adding a full sign-in account becomes available once every environment supports it.",
  codexHostRefresh: (config) =>
    config === null
      ? "Turn off one-time Codex sign-in for the installation. Dev loses shared Codex accounts when their current access expires, and each environment needs its own sign-in again. Host use is unaffected."
      : "Turn on one-time Codex sign-in for the installation. Shared Codex accounts sign in once on the Host, which keeps them fresh and sends Dev access without a second sign-in. It becomes available once every environment supports it.",
  engineRestart: (config) =>
    config === null
      ? "Remove the tracked Docker restart plan."
      : `Allow a tracked Docker Desktop restart for Dev, which you approve each time. Pinned containers: Dev ${config.containers.dev.slice(0, 12)}, gateway Tailscale ${config.containers.gatewayTailscale.slice(0, 12)}, gateway Caddy ${config.containers.gatewayCaddy.slice(0, 12)}.${config.factoryVerify ? ` Factory lock check ${config.factoryVerify.sha256.slice(0, 12)}, owner mode ${config.factoryVerify.ownerMode}.` : ""}`,
  engineRecovery: (config) =>
    config === null
      ? "Remove degraded Docker recovery."
      : `Allow separately reviewed recovery when Docker does not answer. Unknown running work may be interrupted. Preserve the pinned containers and paused Factory custody from ${config.baseline.observedAt}; verify them after recovery.`,
  recoveryOrigin: (origin) =>
    origin === null
      ? "Remove the independent private recovery origin."
      : `Serve the existing interface and password-protected installation controls at ${origin} without redirecting to the Docker gateway. Existing credentials and environment identities remain unchanged.`,
  factoryGate: (config) =>
    config === null
      ? "Stop running Factory's checks around Dev restarts."
      : `Run Factory's read-only checks before and after every Dev restart. A restart is refused, or reported as failed, if Factory's lock, supervisor, pause state or custody records are wrong. Check ${config.verify.sha256.slice(0, 12)}, owner mode ${config.verify.ownerMode}, Dev ${config.container.slice(0, 12)}.`,
  hostLauncherUpdate: (config) =>
    config === null
      ? "Remove the Host launcher update plan."
      : `Allow a one-time Host launcher update, which you approve separately: managed release selection, or release seals on or off. Candidate launcher ${config.sha256.slice(0, 12)}.`,
  releaseSeals: (config) =>
    config === null
      ? "Turn off release seals for the coordinator. Its launcher drops VORTEO_RELEASE_SEALS, so later Host builds are not sealed and installs check release bytes in full. Existing sealed releases keep their flags."
      : "Turn on release seals for the coordinator. Its launcher gains VORTEO_RELEASE_SEALS=enabled, so later Host builds are made read-only and digested once, and installs check seals. Seals take effect only when the Host launcher also sets it.",
};

function describe<S extends ReviewedConfigurationSetting>(setting: S, value: unknown): string {
  return DESCRIPTIONS[setting](value as ReviewedConfigurationValue<S> | null);
}

/** One line per configuration change in the plan, from either plan shape. */
export function describeConfigurationChanges(plan: CoordinatorBootstrapPlan): string[] {
  const result = planConfigurationChanges(plan);
  if (!result.ok) return [`This plan cannot be approved: ${result.reason}.`];
  return result.changes.map((change) => describe(change.setting, change.value));
}
