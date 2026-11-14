import { getProviderProbeCwd } from "../../../../utils/provider-probe-cwd.js";
import type { ChildProcess } from "node:child_process";
import type { ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { raceProviderRefreshAbort } from "../../provider-refresh-deadline.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";
import { claudeQuery, type ClaudeQueryInput, type ClaudeQueryContext } from "./query.js";
import { claudeConfigDir } from "./project-dir.js";
import { claudeSignInMode } from "./sign-in-mode.js";
import { readClaudeOAuthGrant } from "../../../execution-installation/accounts/claude-oauth-storage.js";

/**
 * No probe starts this close to a full sign-in grant's expiry. Claude Code renews the grant
 * as it starts once the access token is within five minutes of expiry, and this probe is
 * force-killed as soon as it answers or times out. A probe killed after the token endpoint
 * rotated the grant, but before the CLI saved it, leaves a spent refresh token in storage; the
 * next renewal is rejected and the CLI erases the sign-in. Probes ran every few seconds per
 * account, so every renewal window was exposed (2026-11-13). Agent sessions, which are not
 * killed this way, renew the grant instead.
 */
export const CLAUDE_DISCOVERY_EXPIRY_GUARD_MS = 10 * 60_000;

/** A fresh answer is reused, so repeated catalog refreshes do not each start a CLI. */
export const CLAUDE_DISCOVERY_REUSE_MS = 10 * 60_000;

const recentDiscoveries = new Map<string, { models: ModelInfo[]; at: number }>();

interface ClaudeModelDiscoveryOptions {
  resolveBinary: () => Promise<string>;
  runtimeSettings?: ProviderRuntimeSettings;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** An explicit refresh skips the reuse of a recent answer, never the expiry guard. */
  force?: boolean;
  readGrant?: typeof readClaudeOAuthGrant;
  now?: () => number;
}

/** Whether starting a CLI for this account now could begin a renewal. */
async function renewalDue(options: ClaudeModelDiscoveryOptions, now: number): Promise<boolean> {
  if (claudeSignInMode(options.env) !== "full") return false;
  let grant;
  try {
    grant = await (options.readGrant ?? readClaudeOAuthGrant)(claudeConfigDir(options.env));
  } catch {
    // Unreadable storage keeps the earlier behavior; the guard needs a grant it can date.
    return false;
  }
  if (!grant?.hasRefreshToken) return false;
  return grant.expiresAt === null || grant.expiresAt - now < CLAUDE_DISCOVERY_EXPIRY_GUARD_MS;
}

type OpenDiscoveryQuery = (
  input: ClaudeQueryInput,
  context: ClaudeQueryContext,
) => Pick<Query, "supportedModels" | "close">;

// The curated catalog survives a failed or slow probe. This process never receives
// a prompt and must not persist a session or launch user MCP servers/hooks.
export async function discoverClaudeModels(
  options: ClaudeModelDiscoveryOptions,
  openQuery: OpenDiscoveryQuery = claudeQuery,
): Promise<ModelInfo[]> {
  const now = options.now ?? Date.now;
  // Providers can share a configuration directory yet reach another endpoint or run another
  // command, and each advertises its own models.
  const account = JSON.stringify([
    claudeConfigDir(options.env),
    claudeSignInMode(options.env),
    options.env.ANTHROPIC_BASE_URL ?? "",
    options.runtimeSettings?.command ?? null,
  ]);
  const recent = recentDiscoveries.get(account);
  if (!options.force && recent && now() - recent.at < CLAUDE_DISCOVERY_REUSE_MS) {
    return recent.models;
  }
  // The last answer, however old, stands in until the grant has renewed. With none, as after a
  // daemon restart this close to expiry, the catalog omits discovery-gated models until then.
  if (await renewalDue(options, now())) return recent?.models ?? [];
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error("Claude model discovery timed out")),
    5_000,
  );
  let endInput!: () => void;
  const ended = new Promise<void>((resolve) => {
    endInput = resolve;
  });
  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await ended;
          return { done: true, value: undefined };
        },
      };
    },
  };
  let query: ReturnType<OpenDiscoveryQuery> | undefined;
  let child: ChildProcess | undefined;
  try {
    signal.throwIfAborted();
    const binary = await raceProviderRefreshAbort(signal, options.resolveBinary());
    signal.throwIfAborted();
    query = openQuery(
      {
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: binary,
          cwd: await getProviderProbeCwd(),
          env: options.env,
          persistSession: false,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: ["user"],
          settings: { disableAllHooks: true },
          abortController: controller,
        },
      },
      {
        runtimeSettings: options.runtimeSettings,
        assertCanSpawn: () => signal.throwIfAborted(),
        onChildProcess: (process) => {
          child = process;
        },
      },
    );
    const models = await raceProviderRefreshAbort(signal, query.supportedModels());
    recentDiscoveries.set(account, { models, at: now() });
    return models;
  } finally {
    clearTimeout(timer);
    endInput();
    try {
      query?.close();
    } finally {
      if (child) {
        await terminateWithTreeKill(child, { gracefulTimeoutMs: 200, forceTimeoutMs: 200 });
      }
    }
  }
}
