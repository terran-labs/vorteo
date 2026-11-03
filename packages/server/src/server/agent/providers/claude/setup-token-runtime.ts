import { mkdirSync } from "node:fs";
import { mkdir, lstat } from "node:fs/promises";
import {
  readClaudeSetupFile,
  writeClaudeSetupFile,
} from "../../../execution-installation/accounts/claude-setup-file.js";
import {
  ClaudeSetupDeliveryReceiptSchema,
  setupCredentialDigest,
} from "../../../execution-installation/accounts/claude-setup-delivery.js";
import { ClaudeSetupTokenError } from "./setup-token-output.js";
import { join } from "node:path";
import { claudeConfigDir } from "./project-dir.js";
import { ClaudeSetupTokenStore, type ClaudeSetupToken } from "./setup-token-store.js";
import { claudeSignInMode } from "./sign-in-mode.js";

export function claudeSetupTokenStore(configDirectory: string): ClaudeSetupTokenStore {
  return new ClaudeSetupTokenStore({ directory: join(configDirectory, ".vorteo-auth") });
}

const FULL_SIGN_IN_MARKER = "full-sign-in.json";

/**
 * Records that this account directory moved from a setup token to full sign-in. Sessions started
 * before the upgrade still carry the setup-token environment; they read this to switch over.
 * Not a credential.
 */
export function markClaudeAccountFullSignIn(configDirectory: string): void {
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  writeClaudeSetupFile(join(configDirectory, ".vorteo-auth", FULL_SIGN_IN_MARKER), {
    version: 1,
    signIn: "full",
  });
}

export function claudeAccountUpgradedToFullSignIn(configDirectory: string): boolean {
  try {
    return readClaudeSetupFile(join(configDirectory, ".vorteo-auth", FULL_SIGN_IN_MARKER)) !== null;
  } catch {
    // An unsafe or unreadable marker never changes how a session authenticates.
    return false;
  }
}

export async function readClaudeSetupToken(
  env: NodeJS.ProcessEnv,
): Promise<ClaudeSetupToken | null> {
  // A full sign-in account authenticates with the CLI's own credentials for its config
  // directory. It never injects a setup token, even if a stray .vorteo-auth exists.
  if (claudeSignInMode(env) === "full") return null;
  const config = claudeConfigDir(env);
  const credential = await claudeSetupTokenStore(config).read();
  let receipt: unknown;
  try {
    receipt = readClaudeSetupFile(join(config, ".vorteo-auth", "delivery.json"));
  } catch {
    throw new ClaudeSetupTokenError();
  }
  if (receipt === null) {
    // Bound accounts must wait for delivery. The unconfigured native CLI account
    // has no delivery record and should use its existing login on this machine.
    // A Dev image sets CLAUDE_CONFIG_DIR for the whole daemon, so only a directory the
    // binding chose differently from the daemon's own marks a bound account.
    const bindingDirectory =
      env.CLAUDE_CONFIG_DIR !== undefined &&
      env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR;
    const boundAccount = bindingDirectory || credential !== null;
    if (process.env.VORTEO_INSTALLATION_CLIENT_CONFIG && boundAccount)
      throw new ClaudeSetupTokenError();
    if (credential) await ensureConsumerSecureDirectory(config);
    return credential;
  }
  const parsed = ClaudeSetupDeliveryReceiptSchema.safeParse(receipt);
  if (
    !parsed.success ||
    parsed.data.phase !== "applied" ||
    !parsed.data.active ||
    parsed.data.digest !== setupCredentialDigest(credential) ||
    !credential
  )
    throw new ClaudeSetupTokenError();
  await ensureConsumerSecureDirectory(config);
  return credential;
}

async function ensureConsumerSecureDirectory(config: string): Promise<void> {
  const directory = join(config, ".vorteo-auth", "secure");
  try {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)
    )
      throw new ClaudeSetupTokenError();
  } catch {
    throw new ClaudeSetupTokenError();
  }
}

/** Applied last, after user/runtime overlays, so another provider cannot silently win precedence. */
export function claudeSetupTokenEnvironment(
  credential: ClaudeSetupToken,
  configDirectory: string,
): Record<string, string> {
  return {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: join(configDirectory, ".vorteo-auth", "secure"),
    CLAUDE_CODE_OAUTH_TOKEN: credential.accessToken,
    CLAUDE_CODE_OAUTH_SCOPES: "user:inference",
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_PROFILE: "",
    ANTHROPIC_FEDERATION_RULE_ID: "",
    ANTHROPIC_ORGANIZATION_ID: "",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
  };
}
