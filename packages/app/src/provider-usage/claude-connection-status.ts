import type { z } from "zod";
import type { ClaudeSetupConnectionSchema } from "./claude-setup-login";

/** How the connect dialog's single status line presents a state. "busy" shows a spinner. */
export type ConnectionTone = "busy" | "success" | "error" | "neutral";
export interface ConnectionStatus {
  tone: ConnectionTone;
  text: string;
}

/** Status of one installation-wide connection, for Claude or Codex. */
export function installationConnectionStatus(
  connection: z.infer<typeof ClaudeSetupConnectionSchema> | undefined,
  provider: "Claude" | "Codex",
): ConnectionStatus {
  if (!connection) return { tone: "busy", text: "Checking connection..." };
  const status = sharedStatus(connection, provider);
  if (status.tone !== "success" || !connection.accountLabel) return status;
  return { ...status, text: `${status.text} as ${connection.accountLabel}` };
}

function sharedStatus(
  connection: z.infer<typeof ClaudeSetupConnectionSchema>,
  provider: "Claude" | "Codex",
): ConnectionStatus {
  if (connection.needsSignIn)
    return { tone: "error", text: `${provider} sign-in expired. Sign in again.` };
  const environments = connection.environments.filter((entry) => entry.status !== "excluded");
  if (environments.some((entry) => entry.status === "disconnecting"))
    return { tone: "busy", text: "Disconnecting. This finishes when every environment is online." };
  if (!connection.connected) return { tone: "neutral", text: "Not connected" };
  if (environments.length === 0 && connection.environments.length > 0)
    return { tone: "neutral", text: "Connected, but excluded from every environment" };
  // Host-owned sign-in lists only Dev deliveries; the Host uses its own sign-in directly.
  const hostOnly = connection.needsSignIn !== undefined && connection.environments.length === 0;
  if (
    hostOnly ||
    (environments.length > 0 && environments.every((entry) => entry.status === "ready"))
  )
    return { tone: "success", text: "Connected" };
  // Delivery retries on its own; the owner has nothing to do.
  return { tone: "busy", text: "Connected. Syncing to your other environments..." };
}
