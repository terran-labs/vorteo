import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "pino";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import { createProviderEnv } from "../agent/provider-launch-config.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import { SessionHostClientError, type HostedSession, type SessionHostClient } from "./client.js";
import type { SessionHostConnector } from "./connector.js";
import {
  DEFAULT_REATTACH_POLICY,
  HostedAgentSession,
  HostedReattachPendingError,
  type HostedReattachment,
  type HostedReattachPolicy,
  type HostedSessionLoss,
  type HostedSessionLossReason,
} from "./hosted-agent-session.js";
import type { FactoryManagedCodexAccount } from "../agent/providers/codex/factory-boundary.js";
import type { ResolveFactoryManagedCodexAccount } from "../agent/provider-registry.js";
import { FactoryManagedCodexBindingSchema, type FactoryManagedCodexBinding } from "./protocol.js";
import type { HostedOpenRequest } from "./session-contract.js";
import type { AppliedSeqStore } from "./applied-store.js";
import { withPaseoMcpAuthToken } from "../agent/runtime-mcp-config.js";

/** What a provider client needs to route eligible sessions through the session host. */
export interface HostedSessionRouting {
  connector: SessionHostConnector;
  /** Read for every new session, so the setting can be turned off without a restart. */
  isEnabled(): boolean;
  resolveFactoryManagedCodexAccount?: ResolveFactoryManagedCodexAccount;
  logger: Logger;
  /** How long and how often a hosted session keeps trying to reattach. Defaults suit production. */
  reattach?: HostedReattachPolicy;
  /** Records the last event each hosted agent applied, for the next worker's rebuild. */
  applied?: AppliedSeqStore;
  /** Sessions attached at startup and waiting for their agent to load. */
  adoptions?: Map<string, HostedAdoption>;
  /**
   * Called when the host no longer runs an agent's session, with what its end interrupted, so an
   * agent with work in progress continues elsewhere and an idle one is released.
   */
  onSessionLost?(agentId: string, loss: HostedSessionLoss, reason: HostedSessionLossReason): void;
}

/**
 * A running hosted session this worker attached at startup. Loading its agent adopts it instead of
 * starting a provider: the attachment was made after the events this worker's predecessor applied.
 */
export interface HostedAdoption {
  channel: HostedSession;
  hostId: string;
  factoryManagedCodex?: FactoryManagedCodexBinding;
  throughSeq: number;
  lossy: boolean;
  /** Receives the adopted session, so startup can release its held events. */
  onAdopted?(session: HostedAgentSession): void;
}

/**
 * The host still holds this agent's session but did not answer within the reattach window.
 * Starting the agent in the worker would put a second provider on its conversation.
 */
export class SessionHostUnresponsiveError extends Error {
  constructor(readonly agentId: string) {
    super(
      "The session host still runs this agent's session but is not answering. Try again shortly.",
    );
    this.name = "SessionHostUnresponsiveError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

interface EligibilityInput {
  config: AgentSessionConfig;
  launchContext?: AgentLaunchContext;
  persistSession?: boolean;
}

/**
 * Only real, persistent agent sessions are hosted. Throwaway sessions (command discovery passes no
 * agent id), internal helpers and non-persistent runs stay in the worker, where they already end
 * with the operation that started them.
 */
function isHostable(input: EligibilityInput): input is EligibilityInput & {
  launchContext: AgentLaunchContext & { agentId: string };
} {
  return (
    typeof input.launchContext?.agentId === "string" &&
    input.launchContext.agentId.length > 0 &&
    input.persistSession !== false &&
    input.config.internal !== true &&
    // A session host built before tool access existed would launch with default tools.
    (input.config.toolAccess !== "none" || input.config.factoryCodexBoundary !== undefined)
  );
}

function toJson<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function resumeConfig(handle: AgentPersistenceHandle, overrides?: Partial<AgentSessionConfig>) {
  const saved = handle.metadata as Partial<AgentSessionConfig> | undefined;
  const savedBoundary = saved?.factoryCodexBoundary;
  if (
    savedBoundary !== undefined &&
    overrides?.factoryCodexBoundary !== undefined &&
    savedBoundary !== overrides.factoryCodexBoundary
  ) {
    throw new Error("The saved Factory Codex boundary changed before resume.");
  }
  const config = { ...saved, ...overrides } as AgentSessionConfig;
  const boundary = savedBoundary ?? config.factoryCodexBoundary;
  if (boundary !== undefined) {
    config.factoryCodexBoundary = boundary;
    overrides = { ...overrides, factoryCodexBoundary: boundary };
  }
  return { config, overrides };
}

/**
 * Wraps a provider client so eligible sessions run in the session host when durable sessions are
 * enabled and the host answers. Everything else, including catalog discovery and every session the
 * host cannot take, uses the wrapped client unchanged.
 */
export function createHostedAgentClient(input: {
  inner: AgentClient;
  runtimeSettings?: ProviderRuntimeSettings;
  routing: HostedSessionRouting;
  /** The derived provider this client was built for, so the host builds the same one. */
  customProvider?: { id: string; label: string; extends: string };
  factoryManagedAccount?(): Promise<FactoryManagedCodexAccount | null>;
}): AgentClient {
  const { inner, routing } = input;
  const logger = routing.logger.child({ module: "session-host", provider: inner.provider });

  async function managedBinding(
    config: AgentSessionConfig,
    client?: SessionHostClient,
  ): Promise<FactoryManagedCodexBinding | undefined> {
    if (config.factoryCodexBoundary === undefined) return undefined;
    if (client && client.factoryManagedCodex !== true)
      throw new Error("The session host does not support confined Codex accounts.");
    const account = await input.factoryManagedAccount?.();
    const parsed = FactoryManagedCodexBindingSchema.safeParse({
      ...account,
      boundary: config.factoryCodexBoundary,
    });
    const env = input.runtimeSettings?.env;
    if (
      !parsed.success ||
      inner.provider !== "codex" ||
      parsed.data.providerId !== (input.customProvider?.id ?? inner.provider) ||
      !env?.CODEX_HOME ||
      env.OPENAI_BASE_URL?.trim()
    ) {
      throw new Error("The selected Factory Codex account is unavailable.");
    }
    if (
      env.CODEX_HOME !== parsed.data.codexHome &&
      (await realpath(env.CODEX_HOME).catch(() => null)) !== parsed.data.codexHome
    ) {
      throw new Error("The selected Factory Codex home differs from its provider binding.");
    }
    return parsed.data;
  }

  function managedRuntimeSettings() {
    const command = input.runtimeSettings?.command;
    if (
      command &&
      command.mode !== "default" &&
      !(command.mode === "append" && !command.args?.length) &&
      !(command.mode === "replace" && command.argv.length === 1)
    ) {
      throw new Error("The selected Factory Codex provider has an unverified native command.");
    }
    return toJson<HostedOpenRequest["runtimeSettings"]>({
      env: { CODEX_HOME: input.runtimeSettings?.env?.CODEX_HOME },
      command,
    });
  }

  /**
   * Null means the host no longer runs the session. Anything short of that, such as a host that is
   * slow to answer or at its connection limit, throws HostedReattachPendingError so the session
   * tries again instead of failing a turn the provider is still running.
   */
  function reattacher(agentId: string, config: AgentSessionConfig) {
    return async (afterSeq: number): Promise<HostedReattachment | null> => {
      const client = await routing.connector.connect({ force: true });
      if (!client) throw new HostedReattachPendingError("The session host is not answering yet.");
      const factoryManagedCodex = await managedBinding(config, client);
      const attach = (seq: number | null) =>
        client.attach({
          sessionId: agentId,
          afterSeq: seq,
          ...(factoryManagedCodex ? { factoryManagedCodex } : {}),
        });
      try {
        return { channel: await attach(afterSeq), lossy: false };
      } catch (error) {
        if (error instanceof SessionHostClientError && error.code === "not_found") return null;
        if (!(error instanceof SessionHostClientError) || error.code !== "replay_unavailable")
          throw new HostedReattachPendingError("Reattaching did not finish.", { cause: error });
      }
      // Keep the turn running and mark what was missed rather than ending the session.
      return { channel: await attach(null), lossy: true };
    };
  }

  function hostedSession(params: {
    channel: HostedSession;
    agentId: string;
    hostId: string;
    config: AgentSessionConfig;
    launchEnv: Record<string, string> | undefined;
    rebuild?: { throughSeq: number; lossy: boolean };
  }): HostedAgentSession {
    return new HostedAgentSession({
      provider: inner.provider,
      capabilities: inner.capabilities,
      channel: params.channel,
      reattach: reattacher(params.agentId, params.config),
      reattachPolicy: routing.reattach,
      hostState: () => routing.connector.hostState(),
      usage: {
        model: params.config.model,
        env: createProviderEnv({
          baseEnv: process.env,
          runtimeSettings: input.runtimeSettings,
          overlays: [params.launchEnv],
        }) as Record<string, string>,
      },
      applied: routing.applied
        ? { store: routing.applied, agentId: params.agentId, hostId: params.hostId }
        : undefined,
      rebuild: params.rebuild,
      onLost: (loss, reason) => routing.onSessionLost?.(params.agentId, loss, reason),
      logger,
    });
  }

  /**
   * Attaches to a session the host already runs for this agent and rebuilds it like a startup
   * takeover. Null when the host does not run it after all.
   */
  async function attachExisting(params: {
    client: SessionHostClient;
    agentId: string;
    config: AgentSessionConfig;
    launchEnv: Record<string, string> | undefined;
  }): Promise<HostedAgentSession | null> {
    const { client, agentId } = params;
    const factoryManagedCodex = await managedBinding(params.config, client);
    const attach = (afterSeq: number | null) =>
      client.attach({
        sessionId: agentId,
        afterSeq,
        ...(factoryManagedCodex ? { factoryManagedCodex } : {}),
      });
    const record = await routing.applied?.read(agentId);
    const afterSeq = record && record.hostId === client.host.id ? record.lastAppliedSeq : 0;
    let channel: HostedSession;
    let throughSeq = afterSeq;
    let lossy = false;
    try {
      channel = await attach(afterSeq);
    } catch (error) {
      if (!(error instanceof SessionHostClientError)) throw error;
      if (error.code === "not_found") return null;
      if (error.code !== "replay_unavailable") throw error;
      channel = await attach(null);
      throughSeq = channel.attach.lastSeq;
      lossy = true;
    }
    logger.info({ agentId, throughSeq }, "Took over a running hosted session on demand");
    return hostedSession({
      channel,
      agentId,
      hostId: client.host.id,
      config: params.config,
      launchEnv: params.launchEnv,
      rebuild: { throughSeq, lossy },
    });
  }

  /**
   * Connects before a decision that would otherwise start the provider in the worker. A host that
   * is alive but slow gets the reattach window to answer; a host that is gone answers null at once.
   * Unlike a running session, a load does not wait out the longer alive window: the caller sees an
   * error after the reattach window and can try again, and a continuation retried in the meantime
   * repeats the wait until the watchdog has replaced the host.
   */
  async function connectWhileHostLives(agentId: string): Promise<SessionHostClient | null> {
    const policy = routing.reattach ?? DEFAULT_REATTACH_POLICY;
    const deadline = Date.now() + policy.windowMs;
    let delay = policy.initialDelayMs;
    for (;;) {
      const client = await routing.connector.connect({ force: true });
      if (client) return client;
      if ((await routing.connector.hostState()) === "gone") return null;
      if (Date.now() + delay > deadline) throw new SessionHostUnresponsiveError(agentId);
      await sleep(delay);
      delay = Math.min(delay * 2, policy.maxDelayMs);
    }
  }

  /**
   * An agent with an applied record may still have its session in the host, even after the
   * setting was turned off. Starting it in the worker would run two providers on one
   * conversation, so the host is asked first. A record the host no longer backs is dropped, and
   * so is one whose host is gone, since the agent now runs in the worker.
   */
  async function remnant(
    agentId: string | undefined,
    config: AgentSessionConfig,
    launchEnv: Record<string, string> | undefined,
  ): Promise<HostedAgentSession | null> {
    if (!agentId || !routing.applied || !(await routing.applied.read(agentId))) return null;
    const client = await connectWhileHostLives(agentId);
    const session = client ? await attachExisting({ client, agentId, config, launchEnv }) : null;
    if (!session) await routing.applied.remove(agentId);
    return session;
  }

  /** Hosted providers outlive this worker, so their tool server uses the host's token. */
  function withHostToken(request: HostedOpenRequest, token: string): HostedOpenRequest {
    const config = withPaseoMcpAuthToken(request.config as unknown as AgentSessionConfig, token);
    const overrides = request.overrides
      ? withPaseoMcpAuthToken(request.overrides as Partial<AgentSessionConfig>, token)
      : undefined;
    return {
      ...request,
      config: config as unknown as HostedOpenRequest["config"],
      ...(overrides ? { overrides: overrides as HostedOpenRequest["overrides"] } : {}),
    };
  }

  /**
   * Connects before opening a session. A host that was stopped removed its socket and answers null
   * at once, so the session runs in the worker. A host whose socket is still there but whose lock
   * holder is dead was killed, and launchd is bringing it back within seconds; a session started in
   * the worker meanwhile, such as the continuation of a turn the dead host was running, would lose
   * its durability for nothing. That host gets the return window. A host that lives but does not
   * answer is the watchdog's problem, not a reason to wait: it gets one more attempt, in case it
   * only just took the lock and is about to listen, and then the worker runs the session itself.
   */
  async function connectForOpen(agentId: string): Promise<SessionHostClient | null> {
    const client = await routing.connector.connect();
    if (client) return client;
    const policy = routing.reattach ?? DEFAULT_REATTACH_POLICY;
    const deadline = Date.now() + (policy.returnWindowMs ?? DEFAULT_REATTACH_POLICY.returnWindowMs);
    let delay = policy.initialDelayMs;
    let waiting = false;
    for (;;) {
      const state = await routing.connector.hostState();
      // No socket and no lock holder: the host was stopped, unless the coordinator marked it as
      // restarting. A live holder without a socket is a host between taking its lock and
      // listening, which the attempt below gives a moment.
      const restarting = (await routing.connector.restarting?.()) ?? false;
      const expected = restarting || (await routing.connector.present());
      if (!expected && state !== "alive") return null;
      // A marked restart's new host may spend a while between its lock and its listen, so the
      // marker keeps the wait going; without it a live holder gets the one attempt.
      const lastAttempt = (state === "alive" && !restarting) || Date.now() + delay > deadline;
      if (!waiting && !lastAttempt) {
        waiting = true;
        logger.info({ agentId }, "The session host was killed; waiting for its restart");
      }
      await sleep(delay);
      delay = Math.min(delay * 2, policy.maxDelayMs);
      const returned = await routing.connector.connect({ force: true });
      if (returned) return returned;
      if (lastAttempt) {
        if (waiting)
          logger.warn(
            { agentId },
            "The session host did not return; the session runs in the worker",
          );
        return null;
      }
    }
  }

  async function open(
    params: {
      request: HostedOpenRequest;
      agentId: string;
      config: AgentSessionConfig;
      launchContext: AgentLaunchContext;
    },
    retried = false,
  ): Promise<AgentSession | null> {
    const client: SessionHostClient | null = await connectForOpen(params.agentId);
    if (!client) {
      if (
        params.config.factoryCodexBoundary !== undefined &&
        (await routing.connector.hostState()) !== "gone"
      ) {
        throw new SessionHostUnresponsiveError(params.agentId);
      }
      return null;
    }
    const factoryManagedCodex = await managedBinding(params.config, client);
    const request = factoryManagedCodex
      ? {
          ...params.request,
          launchEnv: undefined,
          runtimeSettings: managedRuntimeSettings(),
        }
      : withHostToken(params.request, client.mcpToken);
    let channel: HostedSession;
    try {
      channel = await client.open({
        sessionId: params.agentId,
        provider: inner.provider,
        config: request as unknown as JsonValue,
        ...(factoryManagedCodex ? { factoryManagedCodex } : {}),
      });
    } catch (error) {
      // The host already runs this agent's session: take it over rather than start another.
      if (error instanceof SessionHostClientError && error.code === "conflict") {
        const existing = await attachExisting({
          client,
          agentId: params.agentId,
          config: params.config,
          launchEnv: params.launchContext.env,
        });
        if (existing) return existing;
        // It ended between the open and the attach: open once more, never loop.
        if (!retried) return open(params, true);
        if (factoryManagedCodex) throw error;
        return null;
      }
      if (factoryManagedCodex) throw error;
      logger.warn(
        { err: error, agentId: params.agentId },
        "The session host could not open a session; it runs in the worker",
      );
      return null;
    }
    logger.info({ agentId: params.agentId, kind: params.request.kind }, "Opened a hosted session");
    return hostedSession({
      channel,
      agentId: params.agentId,
      hostId: client.host.id,
      config: params.config,
      launchEnv: params.launchContext.env,
    });
  }

  /**
   * A session attached at startup is adopted whichever way its agent loads, and even if the
   * setting was turned off since, so the turn it is running can finish.
   */
  async function adopt(
    config: AgentSessionConfig,
    launchContext: AgentLaunchContext | undefined,
  ): Promise<HostedAgentSession | null> {
    const agentId = launchContext?.agentId;
    const adoption = agentId ? routing.adoptions?.get(agentId) : undefined;
    if (!agentId || !adoption) return null;
    // A hosted session was launched with whatever tools its host gave it; a tool-less
    // agent never adopts one and launches locally instead.
    if (config.toolAccess === "none" && config.factoryCodexBoundary === undefined) return null;
    const factoryManagedCodex = await managedBinding(config);
    if (!isDeepStrictEqual(adoption.factoryManagedCodex, factoryManagedCodex))
      throw new Error("The hosted Factory account binding changed before adoption.");
    routing.adoptions?.delete(agentId);
    const session = hostedSession({
      channel: adoption.channel,
      agentId,
      hostId: adoption.hostId,
      config,
      launchEnv: launchContext?.env,
      rebuild: { throughSeq: adoption.throughSeq, lossy: adoption.lossy },
    });
    adoption.onAdopted?.(session);
    logger.info({ agentId, throughSeq: adoption.throughSeq }, "Adopted a hosted session");
    return session;
  }

  async function createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const adopted = await adopt(config, launchContext);
    if (adopted) return adopted;
    const eligibility = { config, launchContext, persistSession: options?.persistSession };
    if (routing.isEnabled() && isHostable(eligibility)) {
      const hosted = await open({
        agentId: eligibility.launchContext.agentId,
        config,
        launchContext: eligibility.launchContext,
        request: {
          kind: "create",
          agentId: eligibility.launchContext.agentId,
          config: toJson(config),
          launchEnv: launchContext?.env,
          runtimeSettings: input.runtimeSettings ? toJson(input.runtimeSettings) : undefined,
          persistSession: options?.persistSession,
          ...(input.customProvider ? { customProvider: input.customProvider } : {}),
        },
      });
      if (hosted) return hosted;
    }
    const existing = await remnant(launchContext?.agentId, config, launchContext?.env);
    if (existing) return existing;
    return inner.createSession(config, launchContext, options);
  }

  async function resumeSession(
    handle: AgentPersistenceHandle,
    requestedOverrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: Parameters<AgentClient["resumeSession"]>[3],
  ): Promise<AgentSession> {
    const { config, overrides } = resumeConfig(handle, requestedOverrides);
    const eligibility = { config, launchContext };
    const adopted = options?.purpose === "history" ? null : await adopt(config, launchContext);
    if (adopted) return adopted;
    // Reading saved history needs no running provider, so it stays in the worker.
    if (options?.purpose !== "history" && routing.isEnabled() && isHostable(eligibility)) {
      const hosted = await open({
        agentId: eligibility.launchContext.agentId,
        config,
        launchContext: eligibility.launchContext,
        request: {
          kind: "resume",
          agentId: eligibility.launchContext.agentId,
          config: toJson({ ...config, provider: inner.provider, cwd: config.cwd ?? "" }),
          launchEnv: launchContext?.env,
          runtimeSettings: input.runtimeSettings ? toJson(input.runtimeSettings) : undefined,
          handle: toJson(handle),
          overrides: overrides ? toJson(overrides) : undefined,
          ...(input.customProvider ? { customProvider: input.customProvider } : {}),
        },
      });
      if (hosted) return hosted;
    }
    if (options?.purpose !== "history") {
      const existing = await remnant(launchContext?.agentId, config, launchContext?.env);
      if (existing) return existing;
    }
    return inner.resumeSession(handle, overrides, launchContext, options);
  }

  // Every member forwards unless the host changes it, so new client capabilities are not lost.
  return {
    provider: inner.provider,
    get capabilities() {
      return inner.capabilities;
    },
    createSession,
    resumeSession,
    getCatalogCacheKey: inner.getCatalogCacheKey?.bind(inner),
    fetchCatalog: (options, context) => inner.fetchCatalog(options, context),
    resolveConfiguredModel: inner.resolveConfiguredModel?.bind(inner),
    resolveDefaultModeId: inner.resolveDefaultModeId?.bind(inner),
    resolveCreateConfig: inner.resolveCreateConfig?.bind(inner),
    isCreateConfigUnattended: inner.isCreateConfigUnattended?.bind(inner),
    listCommands: inner.listCommands?.bind(inner),
    listFeatures: inner.listFeatures?.bind(inner),
    listImportableSessions: inner.listImportableSessions?.bind(inner),
    importSession: inner.importSession?.bind(inner),
    isAvailable: (signal, options) => inner.isAvailable(signal, options),
    getDiagnostic: inner.getDiagnostic?.bind(inner),
    openResetCreditSession: inner.openResetCreditSession?.bind(inner),
    openQuotaObservationSession: inner.openQuotaObservationSession?.bind(inner),
    // Quota-governed sessions need trusted in-process callbacks; they never run in the host.
    openQuotaGovernedSession: inner.openQuotaGovernedSession?.bind(inner),
    openAccountLoginSession: inner.openAccountLoginSession?.bind(inner),
    archiveNativeSession: inner.archiveNativeSession?.bind(inner),
    unarchiveNativeSession: inner.unarchiveNativeSession?.bind(inner),
    shutdown: inner.shutdown?.bind(inner),
  } satisfies { [K in keyof Required<AgentClient>]: AgentClient[K] };
}
