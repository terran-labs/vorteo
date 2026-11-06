import { basename } from "node:path";
import { z } from "zod";
import { readInstallationClientConfig } from "../settings/admission.js";

export const ClaudeOAuthRecoveryRequestSchema = z.strictObject({
  providerId: z.string().min(1).max(512),
  configDir: z.string().min(1).max(4096),
});
export type ClaudeOAuthRecoveryRequest = z.infer<typeof ClaudeOAuthRecoveryRequestSchema>;

const Support = z.object({ available: z.boolean() });
const Reply = z.object({ completed: z.boolean() });

interface RecoveryOptions {
  config?: ReturnType<typeof readInstallationClientConfig>;
  request?: typeof fetch;
}

/** Ask the existing Host writer; neither this transport nor Dev can rotate credentials. */
export async function recoverClaudeOAuthGrant(
  configDir: string,
  overrides: RecoveryOptions = {},
): Promise<void> {
  const config =
    overrides.config === undefined
      ? readInstallationClientConfig(process.env.VORTEO_INSTALLATION_CLIENT_CONFIG)
      : overrides.config;
  const request = overrides.request ?? fetch;
  if (!config) return;
  const url = new URL("/api/installation/claude/oauth/recovery", config.origin);
  const options = {
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    redirect: "error" as const,
    signal: AbortSignal.timeout(75_000),
  };
  // Older coordinators have no route. Detect support before requesting recovery.
  const support = await request(url, options);
  if (!support.ok || !Support.parse(await support.json()).available) return;
  const response = await request(url, {
    ...options,
    method: "POST",
    body: JSON.stringify({ providerId: basename(configDir), configDir }),
  });
  if (!response.ok || !Reply.parse(await response.json()).completed)
    throw new Error("Account recovery is unavailable.");
}
