import { getProviderProbeCwd } from "../../../../utils/provider-probe-cwd.js";
import type { ChildProcess } from "node:child_process";
import type { ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { raceProviderRefreshAbort } from "../../provider-refresh-deadline.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";
import { claudeQuery, type ClaudeQueryInput, type ClaudeQueryContext } from "./query.js";
import { acquireClaudeStartSlot, waitForClaudeRenewal } from "./account-starts.js";
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

/**
 * Even a forced refresh reuses an answer younger than this, and a failed probe is not retried
 * within it. Client reconnects force a catalog refresh, and on the lab Host they started a CLI
 * per account every five seconds (2026-11-13). Refreshes that overlap, or that are canceled
 * before they answer, still each start a CLI.
 */
export const CLAUDE_DISCOVERY_MIN_INTERVAL_MS = 60_000;

/**
 * A full sign-in grant this far past its expiry was renewed by no session, so nothing is using
 * the account. Claude Code renews a grant only as a session starts or makes a request, so such an
 * account stays expired until its next use, and an environment that receives its tokens from this
 * one stays signed out for as long (about 42 hours for one account on the lab Host, 2026-11-20).
 */
export const CLAUDE_IDLE_RENEWAL_AFTER_MS = 60_000;

/**
 * One idle renewal is attempted per account in this long. It must not be shorter than the reuse
 * of a discovery answer above, or a renewal's own answer would delay the next attempt past it.
 */
export const CLAUDE_IDLE_RENEWAL_RETRY_MS = 10 * 60_000;
/** After an attempt that did not renew, the next waits this long, so a stuck account stays quiet. */
export const CLAUDE_IDLE_RENEWAL_FAILED_RETRY_MS = 60 * 60_000;

/** How long an idle renewal waits for its CLI to answer, and then for the grant to read renewed. */
const CLAUDE_IDLE_RENEWAL_START_MS = 30_000;
const CLAUDE_IDLE_RENEWAL_SAVE_MS = 10_000;
/** How long the renewing CLI gets to exit by itself once its input ends. */
const CLAUDE_IDLE_RENEWAL_EXIT_MS = 5_000;
/** Longest the renewing CLI is left alone while it holds the renewal lock, as a session would be. */
const CLAUDE_IDLE_RENEWAL_LOCK_MS = 90_000;

const recentDiscoveries = new Map<string, { models: ModelInfo[]; at: number }>();
const recentFailures = new Map<string, { error: unknown; at: number }>();
const idleRenewals = new Map<string, { at: number; holdMs: number; done: Promise<void> }>();

/** Forgets every remembered answer, failure and idle renewal. For tests, which share this module. */
export function forgetClaudeModelDiscoveries(): void {
  recentDiscoveries.clear();
  recentFailures.clear();
  idleRenewals.clear();
}

/** Resolves once every idle renewal started so far has ended its CLI. */
export async function settleClaudeIdleRenewals(): Promise<void> {
  await Promise.allSettled([...idleRenewals.values()].map((renewal) => renewal.done));
}

/**
 * `signed-out` means the stored sign-in was gone afterwards: the sign-in server rejected its
 * refresh token and Claude Code erased it, as the account's next session would have found.
 */
export type ClaudeIdleRenewalOutcome = "renewed" | "signed-out" | "not-renewed" | "failed";

interface ClaudeModelDiscoveryOptions {
  resolveBinary: () => Promise<string>;
  runtimeSettings?: ProviderRuntimeSettings;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** An explicit refresh skips the reuse of a recent answer, never the expiry guard. */
  force?: boolean;
  readGrant?: typeof readClaudeOAuthGrant;
  now?: () => number;
  /** Ends an idle renewal early, as at shutdown. A canceled refresh (`signal`) does not. */
  lifetime?: AbortSignal;
  /** Told how each idle renewal ended, for the provider's log. */
  onIdleRenewal?: (outcome: ClaudeIdleRenewalOutcome, error?: unknown) => void;
}

/**
 * Where a full sign-in grant stands: `due` while a session may be renewing it or is about to,
 * `idle-expired` once it has sat expired long enough that none did, otherwise `none`.
 */
export type ClaudeRenewalState = "none" | "due" | "idle-expired";

export async function claudeRenewalState(
  env: NodeJS.ProcessEnv,
  options: { readGrant?: typeof readClaudeOAuthGrant; now?: number } = {},
): Promise<ClaudeRenewalState> {
  const now = options.now ?? Date.now();
  if (claudeSignInMode(env) !== "full") return "none";
  let grant;
  try {
    grant = await (options.readGrant ?? readClaudeOAuthGrant)(claudeConfigDir(env));
  } catch {
    // Unreadable storage keeps the earlier behavior; the guard needs a grant it can date.
    return "none";
  }
  if (!grant?.hasRefreshToken) return "none";
  if (grant.expiresAt === null) return "due";
  if (now - grant.expiresAt >= CLAUDE_IDLE_RENEWAL_AFTER_MS) return "idle-expired";
  return grant.expiresAt - now < CLAUDE_DISCOVERY_EXPIRY_GUARD_MS ? "due" : "none";
}

/**
 * Whether starting a Claude CLI for this account now could begin a sign-in renewal. Callers that
 * start a CLI they will stop on a short limit must not start it while this holds.
 */
export async function claudeRenewalDue(
  env: NodeJS.ProcessEnv,
  options: { readGrant?: typeof readClaudeOAuthGrant; now?: number } = {},
): Promise<boolean> {
  return (await claudeRenewalState(env, options)) !== "none";
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
  const reuseMs = options.force ? CLAUDE_DISCOVERY_MIN_INTERVAL_MS : CLAUDE_DISCOVERY_REUSE_MS;
  if (recent && now() - recent.at < reuseMs) return recent.models;
  // The last answer, however old, stands in until the grant has renewed. With none, as after a
  // daemon restart this close to expiry, the catalog omits discovery-gated models until then.
  if (await renewalStandsIn(account, options, openQuery)) return recent?.models ?? [];
  const failed = recentFailures.get(account);
  if (failed && now() - failed.at < CLAUDE_DISCOVERY_MIN_INTERVAL_MS) throw failed.error;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error("Claude model discovery timed out")),
    5_000,
  );
  // The SDK ends the CLI as soon as its controller aborts. It gets its own, aborted only after
  // the wait for a renewal, so the five second limit above cannot stop a renewing probe.
  const sdkAbort = new AbortController();
  const held = holdProbeInput();
  let probe: OpenProbe | undefined;
  try {
    signal.throwIfAborted();
    const binary = await raceProviderRefreshAbort(signal, options.resolveBinary());
    signal.throwIfAborted();
    probe = await openProbe(options, openQuery, binary, held.input, sdkAbort, () =>
      signal.throwIfAborted(),
    );
    const models = await raceProviderRefreshAbort(signal, probe.query.supportedModels());
    recentDiscoveries.set(account, { models, at: now() });
    recentFailures.delete(account);
    return models;
  } catch (error) {
    // A canceled refresh says nothing about the account; only a real failure is held back.
    if (!options.signal?.aborted) recentFailures.set(account, { error, at: now() });
    throw error;
  } finally {
    clearTimeout(timer);
    await endDiscoveryProbe(options.env, probe?.query, probe?.child(), sdkAbort, held.end);
  }
}

/**
 * True while no probe may start for the account because its grant is due for renewal. For a
 * grant nothing renewed, this also starts the idle renewal.
 */
async function renewalStandsIn(
  account: string,
  options: ClaudeModelDiscoveryOptions,
  openQuery: OpenDiscoveryQuery,
): Promise<boolean> {
  const renewal = await claudeRenewalState(options.env, {
    readGrant: options.readGrant,
    now: (options.now ?? Date.now)(),
  });
  // Nothing is using the account, so nothing will renew it. Do that here, apart from the
  // refresh, which may be canceled and must not take the renewing CLI with it.
  if (renewal === "idle-expired") renewIdleClaudeAccount(account, options, openQuery);
  return renewal !== "none";
}

interface OpenProbe {
  query: ReturnType<OpenDiscoveryQuery>;
  child: () => ChildProcess | undefined;
}

/** Input that stays open, so the CLI waits without a prompt until `end` is called. */
function holdProbeInput(): { input: AsyncIterable<SDKUserMessage>; end: () => void } {
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    input: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            await ended;
            return { done: true, value: undefined };
          },
        };
      },
    },
    end,
  };
}

/** Starts a CLI that receives no prompt, persists no session and launches no user hooks. */
async function openProbe(
  options: ClaudeModelDiscoveryOptions,
  openQuery: OpenDiscoveryQuery,
  binary: string,
  input: AsyncIterable<SDKUserMessage>,
  sdkAbort: AbortController,
  assertCanSpawn: () => void,
): Promise<OpenProbe> {
  let child: ChildProcess | undefined;
  const query = openQuery(
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
        abortController: sdkAbort,
      },
    },
    {
      runtimeSettings: options.runtimeSettings,
      assertCanSpawn,
      onChildProcess: (process) => {
        child = process;
      },
    },
  );
  return { query, child: () => child };
}

/**
 * Renews the sign-in of an account nothing is using, by starting one CLI the way a session would
 * and letting it finish. Claude Code 2.1.321 renewed an expired grant as it started, before any
 * request to a model, so this sends no prompt. Unlike the discovery probe it runs on no short
 * limit: it takes the account's start slot like a session, waits for the grant to read renewed,
 * leaves the CLI alone for as long as it holds the renewal lock, then ends its input and lets it
 * exit by itself. Only provider shutdown bounds that. One attempt per account in ten minutes,
 * and in an hour after one that did not renew.
 */
function renewIdleClaudeAccount(
  account: string,
  options: ClaudeModelDiscoveryOptions,
  openQuery: OpenDiscoveryQuery,
): void {
  const now = options.now ?? Date.now;
  const last = idleRenewals.get(account);
  if (last && now() - last.at < last.holdMs) return;
  if (options.lifetime?.aborted) return;
  const entry = { at: now(), holdMs: CLAUDE_IDLE_RENEWAL_RETRY_MS, done: Promise.resolve() };
  const report = (outcome: ClaudeIdleRenewalOutcome, error?: unknown) => {
    if (outcome !== "renewed") entry.holdMs = CLAUDE_IDLE_RENEWAL_FAILED_RETRY_MS;
    options.onIdleRenewal?.(outcome, error);
  };
  entry.done = runIdleClaudeRenewal(account, options, openQuery)
    .then(
      (outcome) => report(outcome),
      (error) => report("failed", error),
    )
    // Nothing awaits this until shutdown; a reporting error must not become an unhandled one.
    .catch(() => undefined);
  idleRenewals.set(account, entry);
}

async function runIdleClaudeRenewal(
  account: string,
  options: ClaudeModelDiscoveryOptions,
  openQuery: OpenDiscoveryQuery,
): Promise<ClaudeIdleRenewalOutcome> {
  const now = options.now ?? Date.now;
  const lifetime = options.lifetime;
  const sdkAbort = new AbortController();
  const held = holdProbeInput();
  // A session start waits in the same slot, so this never starts beside one in this process.
  const slot = await acquireClaudeStartSlot(claudeConfigDir(options.env));
  let probe: OpenProbe | undefined;
  try {
    const stillIdle =
      (await claudeRenewalState(options.env, { readGrant: options.readGrant, now: now() })) ===
      "idle-expired";
    // A session that held the slot may have renewed the grant meanwhile.
    if (!stillIdle) return "renewed";
    const binary = await options.resolveBinary();
    lifetime?.throwIfAborted();
    probe = await openProbe(options, openQuery, binary, held.input, sdkAbort, () =>
      lifetime?.throwIfAborted(),
    );
    const started = probe.query.supportedModels();
    slot.releaseWhen(started);
    // The CLI's answer shows it started; its models are a discovery answer like any other.
    const models = await withinLimit(started, CLAUDE_IDLE_RENEWAL_START_MS, lifetime);
    if (models) recentDiscoveries.set(account, { models, at: now() });
    const deadline = Date.now() + CLAUDE_IDLE_RENEWAL_SAVE_MS;
    for (;;) {
      const outcome = await readIdleRenewalOutcome(options, now());
      if (outcome !== "not-renewed") return outcome;
      if (Date.now() >= deadline || lifetime?.aborted) return outcome;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    slot.release();
    await endIdleRenewalProbe(options.env, probe, sdkAbort, held.end, lifetime);
  }
}

/** Reads the stored grant itself: a sign-in that is gone must not pass for a renewed one. */
async function readIdleRenewalOutcome(
  options: ClaudeModelDiscoveryOptions,
  now: number,
): Promise<"renewed" | "signed-out" | "not-renewed"> {
  let grant;
  try {
    grant = await (options.readGrant ?? readClaudeOAuthGrant)(claudeConfigDir(options.env));
  } catch {
    // Storage that cannot be read just now says nothing either way.
    return "not-renewed";
  }
  if (!grant?.hasRefreshToken) return "signed-out";
  return grant.expiresAt !== null && grant.expiresAt > now ? "renewed" : "not-renewed";
}

/** The value, or undefined once the limit passes or the lifetime ends. Never rejects late. */
async function withinLimit<T>(
  work: Promise<T>,
  limitMs: number,
  lifetime: AbortSignal | undefined,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), limitMs);
    onAbort = () => resolve(undefined);
    lifetime?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort) lifetime?.removeEventListener("abort", onAbort);
    work.catch(() => undefined);
  }
}

/**
 * Waits for the account's renewal lock to clear. While the provider lives, a CLI holding it is
 * left alone as a session's would be, up to a cap; at shutdown only the ordinary stop wait applies.
 */
async function waitOutClaudeRenewal(
  env: NodeJS.ProcessEnv,
  lifetime: AbortSignal | undefined,
): Promise<void> {
  const deadline = Date.now() + CLAUDE_IDLE_RENEWAL_LOCK_MS;
  for (;;) {
    if (await waitForClaudeRenewal(env)) return;
    if (lifetime?.aborted || Date.now() >= deadline) return;
  }
}

/**
 * Ends the renewing CLI the gentle way: after any renewal in progress, by ending its input and
 * giving it time to exit by itself. Only a CLI that has not exited by then is stopped. At
 * shutdown each step is short, so the provider's own stop stays inside the daemon's limit.
 */
async function endIdleRenewalProbe(
  env: NodeJS.ProcessEnv,
  probe: OpenProbe | undefined,
  sdkAbort: AbortController,
  endInput: () => void,
  lifetime: AbortSignal | undefined,
): Promise<void> {
  const child = probe?.child();
  const running = () => child !== undefined && child.exitCode === null && child.signalCode === null;
  if (child) await waitOutClaudeRenewal(env, lifetime);
  endInput();
  if (child && running()) {
    const exitMs = lifetime?.aborted ? 1_000 : CLAUDE_IDLE_RENEWAL_EXIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, exitMs);
      }),
    ]);
    clearTimeout(timer);
  }
  // A renewal this CLI began late is still waited for before anything stops it.
  if (child && running() && !lifetime?.aborted) await waitOutClaudeRenewal(env, lifetime);
  sdkAbort.abort();
  try {
    probe?.query.close();
  } finally {
    if (child && running()) {
      const stopMs = lifetime?.aborted ? 500 : 2_000;
      await terminateWithTreeKill(child, { gracefulTimeoutMs: stopMs, forceTimeoutMs: stopMs });
    }
  }
}

/**
 * Ends the probe's CLI. The expiry guard keeps the probe out of renewals it can predict; should
 * the account be renewing anyway, that finishes first, within the stop wait.
 */
async function endDiscoveryProbe(
  env: NodeJS.ProcessEnv,
  query: { close(): void } | undefined,
  child: ChildProcess | undefined,
  sdkAbort: AbortController,
  endInput: () => void,
): Promise<void> {
  if (child) await waitForClaudeRenewal(env);
  endInput();
  sdkAbort.abort();
  try {
    query?.close();
  } finally {
    if (child) await terminateWithTreeKill(child, { gracefulTimeoutMs: 200, forceTimeoutMs: 200 });
  }
}
