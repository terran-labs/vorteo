import type {
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
  ProviderUsageFetcherManifestEntry,
} from "./provider.js";
import { AntigravityQuotaProvider } from "./providers/antigravity.js";
import { ClaudeQuotaProvider } from "./providers/claude.js";
import { claudeSignInMode } from "../../server/agent/providers/claude/sign-in-mode.js";
import { CodexQuotaProvider } from "./providers/codex.js";
import { CopilotQuotaProvider } from "./providers/copilot.js";
import { CursorQuotaProvider } from "./providers/cursor.js";
import { GrokQuotaProvider } from "./providers/grok.js";
import { KimiQuotaProvider } from "./providers/kimi.js";
import { MiniMaxQuotaProvider } from "./providers/minimax.js";
import { ZaiQuotaProvider } from "./providers/zai.js";

export const PROVIDER_USAGE_FETCHERS: readonly ProviderUsageFetcherManifestEntry[] = [
  {
    providerId: "claude",
    create: (options) =>
      new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
      }),
  },
  {
    providerId: "codex",
    create: (options) =>
      new CodexQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
      }),
  },
  {
    providerId: "copilot",
    create: (options) => new CopilotQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "cursor",
    create: (options) => new CursorQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "zai",
    create: (options) => new ZaiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "grok",
    create: (options) => new GrokQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "kimi",
    create: (options) => new KimiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "minimax",
    create: (options) => new MiniMaxQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "antigravity",
    create: (options) => new AntigravityQuotaProvider({ logger: options.logger }),
  },
];

type ConfiguredProvider = NonNullable<ProviderUsageFetcherFactoryOptions["providers"]>[string];

function createClaudeFetcher(
  providerId: string,
  configured: ConfiguredProvider | undefined,
  strictHome: boolean,
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher | null {
  if (configured?.enabled === false) return null;
  const claudeHome = configured?.env?.CLAUDE_CONFIG_DIR;
  return new ClaudeQuotaProvider({
    logger: options.logger,
    fetch: options.fetch,
    providerId,
    displayName: configured?.label ?? (providerId === "claude" ? undefined : providerId),
    claudeHome,
    strictClaudeHome: strictHome || claudeHome !== undefined,
    signIn: claudeSignInMode(configured?.env),
    limitObservations: options.claudeLimitObservations,
  });
}

function createAntigravityFetcher(
  providerId: string,
  configured: ConfiguredProvider | undefined,
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher | null {
  if (configured?.enabled === false || configured?.removed === true) return null;
  return new AntigravityQuotaProvider({
    logger: options.logger,
    providerId,
    displayName: configured?.label ?? (providerId === "antigravity" ? "Antigravity" : providerId),
    command: configured?.command,
    env: configured?.env,
  });
}

function createCodexFetcher(
  providerId: string,
  configured: ConfiguredProvider | undefined,
  strictHome: boolean,
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher | null {
  if (configured?.enabled === false) return null;
  const codexHome = configured?.env?.["CODEX_HOME"];
  return new CodexQuotaProvider({
    logger: options.logger,
    fetch: options.fetch,
    providerId,
    displayName: configured?.label ?? (providerId === "codex" ? "Codex" : providerId),
    codexHome,
    strictCodexHome: strictHome || codexHome !== undefined,
  });
}

function createBuiltinUsageFetcher(
  entry: ProviderUsageFetcherManifestEntry,
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher | null {
  if (entry.providerId === "claude") {
    return createClaudeFetcher("claude", options.providers?.claude, false, options);
  }
  if (entry.providerId === "antigravity") {
    return createAntigravityFetcher("antigravity", options.providers?.["antigravity"], options);
  }
  if (entry.providerId === "codex") {
    return createCodexFetcher("codex", options.providers?.["codex"], false, options);
  }
  return entry.create(options);
}

function createExtendedUsageFetcher(
  providerId: string,
  provider: ConfiguredProvider,
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher | null {
  if (providerId !== "claude" && provider.extends === "claude") {
    return createClaudeFetcher(providerId, provider, true, options);
  }
  if (providerId !== "antigravity" && provider.extends === "antigravity") {
    return createAntigravityFetcher(providerId, provider, options);
  }
  if (providerId !== "codex" && provider.extends === "codex") {
    return createCodexFetcher(providerId, provider, true, options);
  }
  return null;
}

export function createProviderUsageFetchers(
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher[] {
  const fetchers: ProviderUsageFetcher[] = [];
  for (const entry of PROVIDER_USAGE_FETCHERS) {
    const fetcher = createBuiltinUsageFetcher(entry, options);
    if (fetcher) fetchers.push(fetcher);
  }
  for (const [providerId, provider] of Object.entries(options.providers ?? {})) {
    const fetcher = createExtendedUsageFetcher(providerId, provider, options);
    if (fetcher) fetchers.push(fetcher);
  }
  return fetchers;
}
