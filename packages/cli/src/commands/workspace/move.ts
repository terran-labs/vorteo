import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceMoveResult {
  workspaceId: string;
  projectId: string;
}

const workspaceMoveSchema: OutputSchema<WorkspaceMoveResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 24 },
    { header: "PROJECT ID", field: "projectId", width: 24 },
  ],
};

export interface WorkspaceMoveOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  project?: string;
}

/**
 * Moves a workspace and its chats into a project on the same host and clears any separate
 * sidebar grouping. Checkouts and worktrees move only into their own repository's project.
 */
export async function runMoveCommand(
  workspaceId: string,
  options: WorkspaceMoveOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceMoveResult>> {
  const projectId = options.project?.trim();
  if (!projectId)
    throw {
      code: "MISSING_PROJECT",
      message: "A destination project is required",
      details: "Usage: paseo workspace move <workspace-id> --project <project-id>",
    } satisfies CommandError;
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  });
  try {
    if (client.getLastServerInfoMessage()?.features?.workspaceProjectPlacement !== true)
      throw {
        code: "WORKSPACE_MOVE_UNSUPPORTED",
        message: "Update this host to move workspaces between projects",
      } satisfies CommandError;
    await client.setWorkspaceProject({ workspaceId, membership: null, projectId });
    return {
      type: "single",
      data: { workspaceId, projectId },
      schema: workspaceMoveSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_MOVE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
