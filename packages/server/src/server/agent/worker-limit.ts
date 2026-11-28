import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import type { AgentProfileLaunch } from "@getpaseo/protocol/messages";

/** null is an explicit uncapped policy, never an omitted/default limit. */
export function managedWorkerLimit(profile: AgentProfile): number | null {
  return profile.uncappedWorkers === true ? null : (profile.maxWorkers ?? 2);
}

export function hasManagedWorkers(
  launch: AgentProfileLaunch | null | undefined,
): launch is AgentProfileLaunch {
  return Boolean(launch?.worker || launch?.workers?.length);
}
