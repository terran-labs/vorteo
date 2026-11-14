import {
  MutableDaemonConfigSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { DEMO_TIMESTAMP } from "./scenario";
import { demoProviderConnections } from "./installation";

type DaemonConfig = Extract<
  SessionOutboundMessage,
  { type: "get_daemon_config_response" }
>["payload"]["config"];

type ProvidersSnapshot = Extract<
  SessionOutboundMessage,
  { type: "get_providers_snapshot_response" }
>["payload"];

/** Seven sample profiles, more than the provider page shows before "Show all". */
const PROFILES = [
  ["demo-profile-builder", "Builder", "claude-account-work"],
  ["demo-profile-reviewer", "Reviewer", "claude-account-personal"],
  ["demo-profile-designer", "Designer", "claude-account-work"],
  ["demo-profile-researcher", "Researcher", "claude-account-research"],
  ["demo-profile-fixer", "Bug fixer", "codex-account-team"],
  ["demo-profile-writer", "Docs writer", "claude-account-personal"],
  ["demo-profile-release", "Release captain", "codex-account-team"],
] as const;

/** A demo daemon's settings: the sample provider accounts and agent profiles. */
export function createDemoDaemonConfig(): DaemonConfig {
  return MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: true },
    // Each account names its base provider, which decides whether it offers Connect or Reconnect.
    providers: Object.fromEntries(
      demoProviderConnections().map((connection) => [
        connection.providerId,
        connection.accountId
          ? {
              extends: connection.providerType,
              installationAccountId: connection.accountId,
              enabled: true,
            }
          : { enabled: true },
      ]),
    ),
    agentProfiles: PROFILES.map(([id, name, provider]) => ({ id, name, provider })),
  });
}

/** Each sample connection as an installed provider. Signed-out accounts report an error. */
export function demoProvidersSnapshot(requestId: string): ProvidersSnapshot {
  return {
    requestId,
    generatedAt: DEMO_TIMESTAMP,
    entries: demoProviderConnections().map((connection) => ({
      provider: connection.providerId,
      label: connection.label,
      status: connection.ready ? ("ready" as const) : ("error" as const),
      enabled: true,
      error: connection.ready ? undefined : "Sign in to use this account.",
      fetchedAt: DEMO_TIMESTAMP,
    })),
  };
}
