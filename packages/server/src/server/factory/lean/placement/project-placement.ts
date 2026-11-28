import { createDevPlacementVerifier, type DevPlacementOptions } from "./dev-placement.js";
import { createDevRunnerAdapter, type DevRunnerOptions } from "./dev-runners.js";
import { devReviewBranch, resolveDevWorkspace } from "./dev-workspace.js";
import type { BoundDevInstallation } from "./installation.js";

export interface DevProjectPlacement {
  bound: BoundDevInstallation;
  readBoundInstallation(): Promise<BoundDevInstallation | null>;
  createRunner(
    readIssueAuthority: DevPlacementOptions["readIssueAuthority"],
  ): ReturnType<typeof createDevRunnerAdapter>;
}

type ProjectOptions = Pick<
  DevRunnerOptions,
  "hosts" | "installation" | "projectId" | "repository" | "state" | "now" | "readBoundInstallation"
>;

export function createDevProjectPlacement(
  options: ProjectOptions & {
    bound: BoundDevInstallation;
    readProjectKey(): Promise<string | null>;
  },
): DevProjectPlacement {
  const { bound, readProjectKey, ...runner } = options;
  return {
    bound,
    readBoundInstallation: runner.readBoundInstallation,
    createRunner(readIssueAuthority) {
      const verifyPlacement = createDevPlacementVerifier({
        readIssueAuthority,
        reviewBranch: devReviewBranch,
        async resolveWorkspace(input, authority) {
          const projectKey = await readProjectKey();
          if (!projectKey || authority.repository !== runner.repository) return null;
          return resolveDevWorkspace(
            { ...input, projectKey, installation: runner.installation },
            authority,
          );
        },
      });
      return createDevRunnerAdapter({ ...runner, devServerId: bound.devServerId, verifyPlacement });
    },
  };
}
