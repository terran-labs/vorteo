import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  checkProviderLaunchAvailable,
  createProviderEnvSpec,
  resolveProviderLaunch,
} from "../../agent/provider-launch-config.js";
import { ClaudeLoginSession } from "../../agent/providers/claude/login.js";
import { CLAUDE_SIGN_IN_ENV } from "../../agent/providers/claude/sign-in-mode.js";
import { execCommand } from "../../../utils/spawn.js";

/**
 * Host-side operations the coordinator performs on a full sign-in account's own CLI storage.
 * The coordinator runs as the same user on the Host and receives the account's exact
 * CLAUDE_CONFIG_DIR from the Host daemon, so the CLI derives the same storage it would.
 *
 * Storage naming and lock compatibility were checked against Claude Code 2.1.321.
 * Live refresh persistence still needs installation acceptance across multiple rotations.
 */

/**
 * Option A, chosen by the owner: one tiny non-interactive request through the official CLI.
 * The CLI refreshes an expiring grant under its own locks before the model request. The prompt
 * comes first so the variadic `--tools` option cannot consume it. `--bare` is avoided because it
 * disables the stored claude.ai sign-in. `--setting-sources user` keeps only the account's own
 * Vorteo-created settings, as its agents run; the empty working directory has no project or local
 * settings, and `--strict-mcp-config` loads no MCP servers.
 */
export const CLAUDE_REFRESH_REQUEST_ARGS = [
  "-p",
  "Reply with OK.",
  "--model",
  "haiku",
  "--max-turns",
  "1",
  "--tools",
  "",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--setting-sources",
  "user",
  "--output-format",
  "json",
];

export interface ClaudeIdentity {
  email: string | null;
  orgId: string | null;
}

interface HostCliOptions {
  run?: typeof execCommand;
  resolveLaunch?: () => Promise<{ executable: string; args: string[] }>;
  tempRoot?: string;
}

async function packagedLaunch(): Promise<{ executable: string; args: string[] }> {
  const launch = await resolveProviderLaunch({ defaultBinary: "claude" });
  const available = await checkProviderLaunchAvailable(launch);
  if (!available.resolvedPath) throw new Error("Claude Code is unavailable on this host.");
  return { executable: available.resolvedPath, args: launch.args };
}

/** The account's launch environment, including the full sign-in isolation overlay. */
function accountEnvironment(configDir: string) {
  return createProviderEnvSpec({
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir, [CLAUDE_SIGN_IN_ENV]: "full" } },
  });
}

export function createClaudeHostCli(options: HostCliOptions = {}) {
  const run = options.run ?? execCommand;
  const resolveLaunch = options.resolveLaunch ?? packagedLaunch;
  return {
    /** Option A. Success is judged by re-reading the grant, not by this request's result. */
    async refresh(configDir: string): Promise<void> {
      const launch = await resolveLaunch();
      const cwd = await mkdtemp(join(options.tempRoot ?? tmpdir(), "vorteo-claude-refresh-"));
      try {
        await run(launch.executable, [...launch.args, ...CLAUDE_REFRESH_REQUEST_ARGS], {
          ...accountEnvironment(configDir),
          cwd,
          // Short enough that a stuck request cannot hold other accounts past their lead.
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    async logout(configDir: string): Promise<void> {
      const launch = await resolveLaunch();
      await run(launch.executable, [...launch.args, "auth", "logout"], {
        ...accountEnvironment(configDir),
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
    },
    /** Identity is display metadata, so never start a CLI that can rotate credentials. */
    async identity(configDir: string): Promise<ClaudeIdentity | null> {
      try {
        const config = await readFile(join(configDir, ".claude.json"), "utf8");
        const status = z
          .object({
            oauthAccount: z
              .object({
                emailAddress: z.string().nullish(),
                organizationUuid: z.string().nullish(),
              })
              .optional(),
          })
          .parse(JSON.parse(config));
        if (!status.oauthAccount) return null;
        return {
          email: status.oauthAccount.emailAddress ?? null,
          orgId: status.oauthAccount.organizationUuid ?? null,
        };
      } catch {
        // Missing or unreadable display metadata does not determine authentication.
        return null;
      }
    },
    async loginSession(configDir: string): Promise<ClaudeLoginSession> {
      const launch = await resolveLaunch();
      return new ClaudeLoginSession({
        executable: launch.executable,
        args: launch.args,
        scope: configDir,
        runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir, [CLAUDE_SIGN_IN_ENV]: "full" } },
      });
    },
  };
}
export type ClaudeHostCli = ReturnType<typeof createClaudeHostCli>;
