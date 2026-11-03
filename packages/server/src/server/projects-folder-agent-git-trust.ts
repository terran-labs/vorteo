// Agents and terminals run their own git, which the daemon's per-invocation trust does not
// reach. When the daemon registers a project or creates a Paseo-owned worktree whose real
// path lies under a Projects folder alias or has another account's ownership, it
// appends that exact physical path to the daemon user's global `safe.directory` once, so git before 2.46 trusts it there too. No wildcard is
// written. Same-owner repositories at the logical root need no config change.
// Self-contained so an installation can drop it without touching per-invocation trust.
// See docs/execution-installation.md#projects-folder.
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";
import {
  findProjectsFolderRepository,
  gitSafeDirectoryValue,
} from "./projects-folder-git-trust.js";
import { activeProjectsFolderConfig, type ProjectsFolderConfig } from "./projects-folder.js";

export interface TrustRepositoryForAgentsDependencies {
  config?: Pick<ProjectsFolderConfig, "root" | "aliases"> | null;
  runGit?: RunGitCommand;
  currentUid?: number;
  logger?: Pick<Logger, "info" | "warn">;
}

// Paths already present or added in this process; avoids a git process per registration.
const trustedThisProcess = new Set<string>();
// Serializes writes, because concurrent `git config --add` calls contend for one lock.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Adds the physical top level of the repository at `directory` to the global
 * `safe.directory` list when reached through a Projects folder alias or owned by
 * another account, and not yet listed. Never throws: a failure is logged and leaves
 * git's behavior unchanged.
 * Resolves to the added path, or null when nothing was written.
 */
export function trustProjectsFolderRepositoryForAgents(
  directory: string,
  dependencies: TrustRepositoryForAgentsDependencies = {},
): Promise<string | null> {
  const config =
    dependencies.config === undefined ? activeProjectsFolderConfig() : dependencies.config;
  if (!config) return Promise.resolve(null);
  const repository = findProjectsFolderRepository(config, directory);
  if (!repository) return Promise.resolve(null);
  if (!repository.throughAlias) {
    const uid = dependencies.currentUid ?? process.getuid?.();
    if (uid === undefined) return Promise.resolve(null);
    try {
      const owners = [repository.physical, path.join(repository.physical, ".git")].map(
        (file) => statSync(file, { throwIfNoEntry: false })?.uid,
      );
      if (!owners.some((owner) => owner !== undefined && owner !== uid))
        return Promise.resolve(null);
    } catch (error) {
      dependencies.logger?.warn(
        { err: error, directory },
        "Could not inspect shared repository ownership",
      );
      return Promise.resolve(null);
    }
  }
  const physical = gitSafeDirectoryValue(repository.physical);
  if (trustedThisProcess.has(physical)) return Promise.resolve(null);
  const runGit = dependencies.runGit ?? runGitCommand;
  const operation = queue.then(async () => {
    if (trustedThisProcess.has(physical)) return null;
    // Runs outside the folder, so this command itself gets no per-invocation trust.
    const options = { cwd: os.homedir(), acceptExitCodes: [0, 1] };
    try {
      const listed = await runGit(["config", "--global", "--get-all", "safe.directory"], options);
      if (listed.stdout.split("\n").includes(physical)) {
        trustedThisProcess.add(physical);
        return null;
      }
      await runGit(["config", "--global", "--add", "safe.directory", physical], {
        cwd: os.homedir(),
      });
      trustedThisProcess.add(physical);
      dependencies.logger?.info(
        { directory: physical },
        "Trusted a Projects folder repository for agents and terminals",
      );
      return physical;
    } catch (error) {
      dependencies.logger?.warn(
        { err: error, directory: physical },
        "Could not trust a Projects folder repository for agents and terminals",
      );
      return null;
    }
  });
  queue = operation;
  return operation;
}

/** Test hook: forgets paths trusted in this process. */
export function resetProjectsFolderAgentTrustForTests(): void {
  trustedThisProcess.clear();
}
