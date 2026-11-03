import { claudeConfigDir } from "./project-dir.js";
import { readClaudeSetupToken, claudeSetupTokenEnvironment } from "./setup-token-runtime.js";
import { z } from "zod";
import { execCommand } from "../../../../utils/spawn.js";
import {
  createProviderEnvSpec,
  createProviderEnv,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";

const AuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
});
const SignedOutCommandSchema = z.object({ code: z.literal(1), stdout: z.string() });

export class ClaudeAuthenticationError extends Error {
  constructor(readonly code: "SIGN_IN_REQUIRED" | "CHECK_FAILED") {
    super(
      code === "SIGN_IN_REQUIRED"
        ? "Claude is not connected. Connect your subscription in Providers settings, then refresh the provider."
        : "Could not verify Claude authentication. Check the connection in Providers settings, then refresh the provider.",
    );
  }
}

/** `claude auth status` takes about 0.1s idle; the limit only matters on a loaded machine. */
const AUTH_STATUS_TIMEOUT_MS = 15_000;

/** execFile kills a child that exceeds its timeout and reports it without an exit code. */
function isTimedOut(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { killed?: unknown }).killed === true &&
    (error as { code?: unknown }).code == null
  );
}

interface AuthenticationCheck {
  executable: string;
  args: string[];
  runtimeSettings?: ProviderRuntimeSettings;
  signal?: AbortSignal;
  run?: typeof execCommand;
}

/** Use the CLI's effective auth configuration, including API keys and cloud providers. */
export async function requireClaudeAuthentication(input: AuthenticationCheck): Promise<void> {
  const run = input.run ?? execCommand;
  const env = createProviderEnv({ runtimeSettings: input.runtimeSettings });
  const credential = await readClaudeSetupToken(env);
  const authEnv = credential
    ? claudeSetupTokenEnvironment(credential, claudeConfigDir(env))
    : undefined;
  const args = [...input.args];
  if (credential) args.push("--settings", JSON.stringify({ apiKeyHelper: "" }));
  args.push("auth", "status");
  let stdout: string;
  let commandSucceeded = true;
  const options = {
    ...createProviderEnvSpec({ runtimeSettings: input.runtimeSettings, overlays: [authEnv] }),
    timeout: AUTH_STATUS_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    signal: input.signal,
  };
  try {
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(input.executable, args, options);
    } catch (error) {
      // A slow CLI start under heavy load is not an authentication failure: retry a timed
      // out check once. A cancelled check or any other failure is not retried.
      if (!isTimedOut(error) || input.signal?.aborted) throw error;
      result = await run(input.executable, args, options);
    }
    stdout = result.stdout;
  } catch (error) {
    // The CLI returns JSON with exit status 1 when signed out.
    const signedOut = SignedOutCommandSchema.safeParse(error);
    if (!signedOut.success) throw new ClaudeAuthenticationError("CHECK_FAILED");
    stdout = signedOut.data.stdout;
    commandSucceeded = false;
  }

  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ClaudeAuthenticationError("CHECK_FAILED");
  }
  const status = AuthStatusSchema.safeParse(value);
  if (!status.success) throw new ClaudeAuthenticationError("CHECK_FAILED");
  if (!status.data.loggedIn) throw new ClaudeAuthenticationError("SIGN_IN_REQUIRED");
  if (!commandSucceeded) throw new ClaudeAuthenticationError("CHECK_FAILED");
  if (
    credential &&
    (status.data.authMethod !== "oauth_token" || status.data.apiProvider !== "firstParty")
  )
    throw new ClaudeAuthenticationError("CHECK_FAILED");
}
