import { parseGitHubRemoteUrl } from "@getpaseo/protocol/git-remote";
import type { ProjectFactoryState } from "./project-factory";
export const validFactoryRepository = (value: string) =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
export function factoryActions(
  state: ProjectFactoryState["state"],
): ("enable" | "pause" | "resume" | "disable")[] {
  if (state === "off") return ["enable"];
  if (state === "on") return ["pause", "disable"];
  if (state === "paused") return ["resume", "disable"];
  return [];
}
export function factoryRepositoryFromRemote(remote: string | null | undefined) {
  return remote ? (parseGitHubRemoteUrl(remote)?.repo ?? "") : "";
}

export function freshFactoryStatus(
  status: { line: string; updatedAt: string } | null | undefined,
  now = Date.now(),
) {
  if (
    !status ||
    !Number.isFinite(Date.parse(status.updatedAt)) ||
    now - Date.parse(status.updatedAt) >= 86_400_000
  )
    return null;
  return status;
}

export async function sendThreadToFactory(
  invoke: (method: string, input: unknown) => Promise<unknown>,
  projectId: string,
  agentId: string,
) {
  await invoke("factory.project.send_thread", { projectId, agentId });
}
export function factoryModelConfiguration(
  projectId: string,
  field: "role" | "workerProfileId" | "reviewerProfileId",
  profileId: string | null,
  role?: import("./factory-instructions-model").RoleId,
  provider?: string | null,
) {
  if (field === "role") return { projectId, role, provider: provider ?? null, profileId };
  return { projectId, [field]: profileId };
}
