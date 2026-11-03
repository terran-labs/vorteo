import path from "node:path";
import { z } from "zod";
import type { DaemonConfigStore } from "../../server/daemon-config-store.js";
import {
  claudeSignInEnvironment,
  claudeSignInMode,
  type ClaudeSignInMode,
} from "../../server/agent/providers/claude/sign-in-mode.js";
import { markClaudeAccountFullSignIn } from "../../server/agent/providers/claude/setup-token-runtime.js";

export class AccountCreationError extends Error {}

const AccountEnvironmentSchema = z.record(z.string(), z.string());

interface AccountCreationInput {
  paseoHome: string;
  store: Pick<DaemonConfigStore, "get" | "createProviderAccountBinding">;
  creationId: string;
  name: string;
}

interface ClaudeAccountCreationInput extends AccountCreationInput {
  /** Fixed at creation. A retry must request the same type as the original. */
  signIn?: ClaudeSignInMode;
}

export function createCodexAccount(input: AccountCreationInput) {
  return createAccount(input, "codex", "CODEX_HOME");
}

export function createClaudeAccount(input: ClaudeAccountCreationInput) {
  return createAccount(input, "claude", "CLAUDE_CONFIG_DIR", input.signIn ?? "setup-token");
}

/** Additional subscription accounts must not use credentials inherited from the daemon. */
function claudeAccountEnvironment(home: string, signIn: ClaudeSignInMode): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ...claudeSignInEnvironment(signIn),
  };
}

interface ClaudeAccountUpgradeInput extends AccountCreationInput {
  store: Pick<
    DaemonConfigStore,
    | "get"
    | "createProviderAccountBinding"
    | "replaceProviderEnv"
    | "readInstallationSettingsAuthority"
  >;
}

/**
 * Switches a managed setup-token binding to full sign-in in place: same provider ID, same
 * CLAUDE_CONFIG_DIR and history, other env entries kept. It runs only after the installation
 * definition records `signIn: "full"`, which the coordinator writes after a verified sign-in, so
 * no client can drop a working setup token without one. A missing binding is created as full.
 */
export async function upgradeClaudeAccount(
  input: ClaudeAccountUpgradeInput,
): Promise<{ providerId: string; name: string }> {
  const creationId = z.string().uuid().parse(input.creationId);
  const providerId = `claude-account-${creationId}`;
  const home = path.join(input.paseoHome, "claude-accounts", providerId);
  const existing = input.store.get().providers[providerId];
  if (!existing) return createClaudeAccount({ ...input, signIn: "full" });
  if (existing.removed)
    throw new AccountCreationError(
      "This local connection was removed. Restore it in Settings before signing in.",
    );
  const env = AccountEnvironmentSchema.safeParse(existing.env);
  if (existing.extends !== "claude" || !env.success || env.data.CLAUDE_CONFIG_DIR !== home)
    throw new AccountCreationError("This account identifier is already in use.");
  if (typeof existing.label !== "string")
    throw new AccountCreationError("The account configuration has no name.");
  const result = { providerId, name: existing.label };
  if (claudeSignInMode(env.data) === "full") return result;
  const admission = await input.store.readInstallationSettingsAuthority();
  const definition = admission?.settings.providerDefinitions?.find(
    (item) => item.bindings[admission.serverId] === providerId,
  );
  if (
    definition?.accountSetup?.provider !== "claude" ||
    definition.accountSetup.creationId !== creationId ||
    definition.accountSetup.signIn !== "full"
  )
    throw new AccountCreationError(
      "Upgrade this account through the installation's Claude sign-in controls.",
    );
  // Written first so a retry after a failed env write still reaches running sessions, which move
  // from the setup token to the full sign-in on their next turn.
  markClaudeAccountFullSignIn(home);
  input.store.replaceProviderEnv(providerId, {
    ...env.data,
    ...claudeAccountEnvironment(home, "full"),
  });
  return result;
}

/** A retry uses the same provider ID and home, including after a lost response or restart. */
async function createAccount(
  input: AccountCreationInput,
  provider: "codex" | "claude",
  homeVariable: "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
  claudeSignIn: ClaudeSignInMode = "setup-token",
): Promise<{ providerId: string; name: string }> {
  const creationId = z.string().uuid().parse(input.creationId);
  const name = input.name.trim();
  if (!name || name.length > 100)
    throw new AccountCreationError("Enter an account name of 1 to 100 characters.");
  const providerId = `${provider}-account-${creationId}`;
  const home = path.join(input.paseoHome, `${provider}-accounts`, providerId);
  const existing = input.store.get().providers[providerId];
  if (existing) {
    if (existing.removed)
      throw new AccountCreationError(
        "This local connection was removed. Restore it in Settings before signing in.",
      );
    const env = AccountEnvironmentSchema.safeParse(existing.env);
    if (
      existing.extends !== provider ||
      !env.success ||
      env.data[homeVariable] !== home ||
      (provider === "claude" && claudeSignInMode(env.data) !== claudeSignIn)
    ) {
      throw new AccountCreationError("This account identifier is already in use.");
    }
    if (typeof existing.label !== "string")
      throw new AccountCreationError("The account configuration has no name.");
    return { providerId, name: existing.label };
  }
  const env =
    provider === "claude" ? claudeAccountEnvironment(home, claudeSignIn) : { [homeVariable]: home };
  // The login session creates the directory. Never copy another account's credentials.
  const saved = await input.store.createProviderAccountBinding(providerId, {
    extends: provider,
    label: name,
    enabled: true,
    env,
  });
  const label = saved.providers[providerId].label;
  return { providerId, name: typeof label === "string" ? label : name };
}
