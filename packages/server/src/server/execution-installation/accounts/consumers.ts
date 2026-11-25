import type { Express } from "express";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { mountClaudeOAuthConsumer } from "./claude-oauth-consumer.js";
import { mountClaudeSetupConsumer } from "./claude-setup-consumer.js";
import { mountCodexSignInConsumer } from "./codex-signin-consumer.js";
import { CodexRefreshLeases } from "./codex-signin-lease.js";
import { mountProviderSecretsConsumer } from "./provider-secrets-consumer.js";

export interface InstallationAccountConsumerOptions {
  paseoHome: string;
  store: DaemonConfigStore;
  /** Called with the provider whose installation account credentials changed. */
  onApplied(providerId: string): void;
  /**
   * `busy` while a session on this provider starts or runs a turn, `loaded` while one is idle.
   * Called only for requests after startup.
   */
  providerSessionActivity(providerId: string): "busy" | "loaded" | "none";
  /** Whether an agent session, or one being started, uses this provider ID. */
  providerInUse(providerId: string): boolean;
}

/** What agent sessions need from the account consumers: a wait before a provider starts. */
export interface InstallationAccountSessionHooks {
  /** Resolves when a credential refresh holding this provider ends; undefined when none does. */
  holdProviderStart(providerId: string): Promise<void> | undefined;
}

/**
 * Mounts the routes that receive installation account deliveries from the coordinator. Keeps
 * provider-specific account wiring out of the generic server bootstrap.
 */
export function mountInstallationAccountConsumers(
  app: Express,
  options: InstallationAccountConsumerOptions,
): InstallationAccountSessionHooks {
  const codexRefreshLeases = new CodexRefreshLeases({
    activity: (providerId) => options.providerSessionActivity(providerId),
  });
  mountClaudeSetupConsumer(app, options);
  // Inert until the installation coordinator delivers a Host-refreshed Claude sign-in.
  mountClaudeOAuthConsumer(app, options);
  // Inert until the coordinator delivers a Host-owned Codex sign-in.
  mountCodexSignInConsumer(app, { ...options, codexRefreshLeases });
  mountProviderSecretsConsumer(app, options);
  return { holdProviderStart: (providerId) => codexRefreshLeases.hold(providerId) };
}
