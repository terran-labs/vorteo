import type {
  AgentProfileSwitchTarget,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { ProfileSwitchRequest } from "./confirm-sheet";

export type ThreadSwitchClient = Pick<DaemonClient, "cancelAgent" | "switchAgentProfile">;

/**
 * Offer to stop the turn only while one is running. A permission request left
 * open without a running turn keeps the plain switch, which the daemon refuses
 * with its own message: stopping then would cancel nothing yet still pause an
 * active goal.
 */
export function offersStopTurn(agent: { status: string } | null | undefined): boolean {
  return agent?.status === "running";
}

/**
 * Switches a thread's account, stopping its running turn first when asked.
 * The target is read only after the stop settles, so the recorded reason
 * includes everything the stopped turn wrote.
 */
export async function switchThreadProfile(
  client: ThreadSwitchClient,
  agentId: string,
  readTarget: () => AgentProfileSwitchTarget,
  { stopTurn, onStage }: ProfileSwitchRequest,
): Promise<void> {
  if (stopTurn) {
    // Resolves after the turn settles and its permission requests are declined.
    await client.cancelAgent(agentId);
    onStage("switching");
  }
  await client.switchAgentProfile(agentId, readTarget());
}
