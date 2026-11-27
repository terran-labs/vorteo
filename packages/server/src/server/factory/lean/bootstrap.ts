import { FactoryConfigV1Schema } from "@getpaseo/server/factory-project";
import { z } from "zod";
import type { Logger } from "pino";

import type {
  InstallationAccountsAuthority,
  FactoryAccounts,
  UsageList,
} from "../project/account-choice.js";
import { ACCOUNT_READING_MAX_AGE_MS } from "../project/account-choice.js";
import {
  ProjectFactoryStateStore,
  projectFactoryStatePath,
  type ProjectState,
} from "../project/state.js";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { createLeanGitHubClient } from "./github-client.js";
import { createLeanMode } from "./mode.js";
import {
  createLeanOperationGroup,
  createLeanRuntime,
  discoverLeanIssues,
  type LeanRuntimeOptions,
} from "./runtime.js";
import { createLeanStateStore } from "./state.js";
import { isRunnerRepository } from "./runner-workspaces.js";
import type { Lane, LeanModePort, RunnerRole } from "./types.js";

const configFile = ".github/vorteo-factory.json";
const INITIALIZE_TIMEOUT_MS = 8_000;
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
const lanes: Lane[] = ["intake", "merge", "delivery", "releaseBuild", "mechanic"];
const configSchema = FactoryConfigV1Schema.extend({
  version: z.literal(1),
  builder: z.looseObject({ provider: z.string().min(1).optional() }).optional(),
  scratch: z.boolean().optional(),
  providers: z
    .object({
      builder: z.string().min(1).optional(),
      reviewer: z.string().min(1).optional(),
      acceptance: z.string().min(1).optional(),
    })
    .optional(),
  review: z.object({ allowSameAccount: z.boolean().optional() }).optional(),
  checks: z.array(z.string().min(1)).optional(),
  releaseRecipeFiles: z.array(z.string().min(1)).optional(),
  shadow: z.enum(["dry-run", "review-rehearsal"]).optional(),
});

type Config = z.infer<typeof configSchema>;
type Options = Omit<LeanRuntimeOptions, "issue">;
type BootstrapOptions = Options & { refreshAuthority(): Promise<Config | null> };
type Runtime = ReturnType<typeof createLeanRuntime>;
type ExecutionMode = "live" | "dry-run" | "review-rehearsal" | "fenced";
type ProjectRecord = ProjectState & { mode?: "crew" | "lean" };
type RuntimeServices = Pick<Options, "operations" | "enqueue">;
type RunnerServices = Omit<
  Options["runner"],
  | "accounts"
  | "roleAccounts"
  | "accountDefinitions"
  | "requiredProviderTypes"
  | "allowSameAccountReview"
>;

export interface LeanBootstrapDependencies {
  paseoHome: string;
  serverId: string;
  logger: Logger;
  settings(): MutableDaemonConfig;
  readAuthority(): Promise<InstallationAccountsAuthority | null>;
  factoryAccounts: FactoryAccounts;
  readUsage(options?: { forceRefresh?: boolean }): Promise<UsageList>;
  runner: RunnerServices;
  workspace: Options["workspace"];
  operations: Omit<RuntimeServices["operations"], "ownerThread">;
  enqueue: RuntimeServices["enqueue"];
}

interface StartupAttempt {
  pending: Promise<void> | null;
  retry: ReturnType<typeof setTimeout> | null;
  delay: number;
  announced: boolean;
  active: boolean;
}

class InactiveProjectError extends Error {}

export function createLeanBootstrap(deps: LeanBootstrapDependencies) {
  const github = createLeanGitHubClient();
  const state = createLeanStateStore(deps.paseoHome);
  const projects = new ProjectFactoryStateStore(projectFactoryStatePath(deps.paseoHome));
  const groups = new Map<string, ReturnType<typeof createLeanOperationGroup>>();
  const startups = new Map<string, StartupAttempt>();
  const now = () => new Date();
  const usage = cachedUsage(deps, now);
  let closing = false;
  let activate: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    activate = resolve;
  });

  async function projectRecord(projectId: string): Promise<ProjectRecord> {
    const record: ProjectRecord | undefined = (await projects.read()).projects[projectId];
    if (!record || !record.enabled || record.mode !== "lean" || record.paused) {
      throw new InactiveProjectError("Lean Factory requires an enabled project in Lean mode.");
    }
    return record;
  }

  async function readConfig(repository: string): Promise<Config | null> {
    if (!isRunnerRepository(repository))
      throw new Error("The Factory project repository is invalid.");
    const result = await github.rest("GET", `repos/${repository}/contents/${configFile}`);
    if (result.status === 404) return null;
    if (result.status !== 200)
      throw new Error("Factory could not read the repository configuration.");
    const data = z
      .object({ encoding: z.literal("base64"), content: z.string() })
      .parse(result.body);
    const config = configSchema.parse(
      JSON.parse(Buffer.from(data.content, "base64").toString("utf8")),
    );
    configuredPrimary(config);
    if (config.builder?.provider) {
      if (config.providers?.builder && config.providers.builder !== config.builder.provider) {
        throw new Error("Factory configuration names two different Builder providers.");
      }
      config.providers = { ...config.providers, builder: config.builder.provider };
    }
    return config;
  }

  async function projectOptions(projectId: string, wake: () => void): Promise<BootstrapOptions> {
    const record = await projectRecord(projectId);
    const { repository } = record;
    const config = await readConfig(repository);
    const here = `${deps.serverId}/${projectId}`;
    const initialPrimary = configuredPrimary(config);
    const checkProviderNow =
      config?.shadow !== "dry-run" && (initialPrimary === null || initialPrimary === here);
    const scratchProvider = await verifiedScratchProvider(deps, config, checkProviderNow);
    const reviewer = config?.providers?.reviewer ?? "claude";
    const reviewerType = deps.factoryAccounts.providerType({ provider: reviewer }) ?? reviewer;
    let currentConfig = config;
    let refreshing: Promise<Config | null> | null = null;
    function refreshAuthority(): Promise<Config | null> {
      if (refreshing) return refreshing;
      refreshing = readConfig(repository)
        .then((latest) => {
          currentConfig = latest;
          return latest;
        })
        .finally(() => {
          refreshing = null;
        });
      return refreshing;
    }
    async function executionMode(): Promise<ExecutionMode> {
      if (closing) return "fenced";
      const current: ProjectRecord | undefined = (await projects.read()).projects[projectId];
      if (
        !current?.enabled ||
        current.mode !== "lean" ||
        current.paused ||
        current.repository !== repository
      ) {
        return "fenced";
      }
      const primary = configuredPrimary(currentConfig);
      if (primary && primary !== here) return "fenced";
      if (currentConfig?.shadow === "dry-run") return "dry-run";
      if (!scratchProvider && !deps.runner.accountPolicy) return "fenced";
      return currentConfig?.shadow ?? "live";
    }
    async function requireIssueEffects(): Promise<void> {
      if (!allowsIssueEffects(await executionMode())) {
        throw new Error("Factory issue effects are disabled by project configuration.");
      }
    }
    const configuredRoles = async (role: RunnerRole) => {
      const latest = await refreshAuthority();
      const mode = await executionMode();
      if (!allowsIssueEffects(mode) || (mode === "review-rehearsal" && role === "delivery")) {
        throw new Error(
          "Factory cannot launch this runner under the current project configuration.",
        );
      }
      const saved = await projectRecord(projectId);
      const allowed = await verifiedScratchProvider(deps, latest);
      if (allowed !== scratchProvider)
        throw new Error("Factory provider authority changed. Restart the project mode.");
      return roleAccounts(role, saved, latest, deps.factoryAccounts, allowed);
    };
    async function holds(lane: Lane): Promise<boolean> {
      const mode = await executionMode();
      return (
        (lane === "intake" && allowsIssueEffects(mode)) || (lane === "merge" && mode === "live")
      );
    }
    const projectState: Options["state"] = {
      read: (id) => state.read(id),
      async mutate(id, change, revision) {
        await requireIssueEffects();
        return state.mutate(id, change, revision);
      },
    };
    return {
      projectId,
      repository,
      github: projectGitHub(github, repository, async () => {
        await refreshAuthority();
        return executionMode();
      }),
      now,
      state: projectState,
      paseoHome: deps.paseoHome,
      here,
      executionMode,
      refreshAuthority,
      leaseTtlMs: (config?.lease?.ttlMinutes ?? 120) * 60_000,
      requiredChecks: config?.checks,
      releaseRecipeFiles: async () => [
        configFile,
        ...((await refreshAuthority())?.releaseRecipeFiles ?? []),
      ],
      runner: {
        ...deps.runner,
        async createAgent(input) {
          await refreshAuthority();
          await requireIssueEffects();
          return deps.runner.createAgent(input);
        },
        roleAccounts: configuredRoles,
        accounts: {
          ...deps.factoryAccounts,
          readUsage: usage,
          async readyProviders() {
            const available = await deps.factoryAccounts.readyProviders();
            return scratchProvider ? available.filter((id) => id === scratchProvider) : available;
          },
        },
        accountDefinitions: () => accountDefinitions(deps, scratchProvider),
        allowSameAccountReview: async () =>
          (await refreshAuthority())?.review?.allowSameAccount === true,
        requiredProviderTypes: {
          "foreman-op": scratchProvider ? "codex" : "claude",
          reviewer: scratchProvider ? "codex" : reviewerType,
        },
      },
      workspace: deps.workspace,
      operations: {
        ...deps.operations,
        ...(deps.operations.push
          ? {
              push: {
                async send(payload) {
                  await requireIssueEffects();
                  await deps.operations.push?.send(payload);
                },
              },
            }
          : {}),
        questions: {
          readQuestions: (agentId) => deps.operations.questions.readQuestions(agentId),
          async mutateQuestions(agentId, mutation) {
            await requireIssueEffects();
            return deps.operations.questions.mutateQuestions(agentId, mutation);
          },
        },
        async ownerThread() {
          return (await projectRecord(projectId)).roles["factory-intake"]?.agentId ?? null;
        },
      },
      operationActions: {
        async applyDecision() {
          throw new Error("This Factory decision needs a configured issue action.");
        },
        async applyAnswer() {
          throw new Error("This Factory answer needs a configured issue action.");
        },
        async describeWait(key) {
          const match = /^issue:(\d+):/.exec(key);
          return match ? { issue: Number(match[1]), stage: "loop" } : null;
        },
        async retryWait() {
          wake();
        },
      },
      async laneEpoch(lane) {
        return (await holds(lane)) ? 1 : null;
      },
      async fenceLane(lane, epoch) {
        return epoch === 1 && (await holds(lane));
      },
      async context() {
        const ledger = await state.read(projectId);
        return {
          config: currentConfig,
          capacity: {
            runners: {
              open: Object.values(ledger.runners).filter((entry) => entry.closedAt === null).length,
              max: ledger.local.runners,
            },
            heavy: { running: false, waiting: 0, queueLimit: 0 },
            memory: { ok: true, reason: null },
          },
        };
      },
      async enqueue(runner, message, id) {
        await requireIssueEffects();
        return deps.enqueue(runner, message, id);
      },
      allowSameAccount: async () => (await refreshAuthority())?.review?.allowSameAccount === true,
    };
  }

  async function projectRuntime(projectId: string) {
    const listeners = new Set<() => void>();
    const wake = () => {
      for (const listener of listeners) listener();
    };
    const options = await boundInitialization(projectOptions(projectId, wake));
    const group = createLeanOperationGroup(options);
    groups.set(projectId, group);
    const children = new Map<number, { runtime: Runtime; unsubscribe: () => void }>();
    async function stopChildren(reason?: Parameters<LeanModePort["stop"]>[1]) {
      for (const child of children.values()) {
        child.unsubscribe();
        if (!reason) child.runtime.detach();
        else await child.runtime.stop(reason);
      }
      children.clear();
    }

    async function reconcile() {
      await options.refreshAuthority();
      const mode = await options.executionMode();
      if (!allowsIssueEffects(mode)) {
        await stopChildren();
        if (mode === "dry-run") await discoverLeanIssues(options);
        return;
      }
      const discovered = await discoverLeanIssues(options);
      const slots = Math.max(1, (await state.read(projectId)).local.runners);
      for (const issue of discovered) {
        if (children.has(issue)) continue;
        if (children.size >= slots) break;
        const runtime = createLeanRuntime({ ...options, issue }, group);
        try {
          await runtime.recover();
          children.set(issue, { runtime, unsubscribe: runtime.subscribe(wake) });
        } catch (error) {
          runtime.detach();
          throw error;
        }
      }
      if (children.size === 0) {
        await group.noteIdlePoll();
        return;
      }
      await Promise.all(
        [...children].map(async ([issue, child]) => {
          try {
            await child.runtime.reconcile();
            if (await child.runtime.isTerminal()) {
              child.unsubscribe();
              child.runtime.detach();
              children.delete(issue);
            }
          } catch (error) {
            deps.logger.warn(
              { err: error, projectId, issue },
              "Lean Factory issue reconcile failed",
            );
          }
        }),
      );
    }

    return {
      async recover() {
        // The first watched reconcile recovers outstanding issues before admitting new work.
        await boundInitialization(state.read(projectId));
      },
      reconcile,
      async inspectDeadlines() {
        if (allowsIssueEffects(await options.executionMode())) await group.tickWatchdog();
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async stop(reason: Parameters<LeanModePort["stop"]>[1]) {
        groups.delete(projectId);
        const active =
          !closing && reason !== "switch" && allowsIssueEffects(await options.executionMode());
        await stopChildren(active ? reason : undefined);
      },
    };
  }

  const engine = createLeanMode(projectRuntime, (projectId, err) => {
    deps.logger.warn({ err, projectId }, "Lean Factory project loop failed");
  });

  function alert(projectId: string, entry: StartupAttempt, error: unknown): void {
    if (entry.announced || startups.get(projectId) !== entry) return;
    entry.announced = true;
    deps.logger.warn({ err: error, projectId }, "Lean Factory startup needs attention");
    void deps.operations.push
      ?.send({
        title: "Factory startup needs attention",
        body: "Factory could not finish initializing this project. The daemon will retry automatically.",
        data: { projectId },
      })
      .catch((err) => {
        deps.logger.warn({ err, projectId }, "Factory startup alert could not be delivered");
      });
  }

  function startAttempt(projectId: string, entry: StartupAttempt): Promise<void> {
    if (entry.pending) return entry.pending;
    if (entry.active || startups.get(projectId) !== entry) return Promise.resolve();
    const watchdog = setTimeout(() => {
      alert(
        projectId,
        entry,
        new Error("Lean Factory initialization is taking longer than expected."),
      );
    }, INITIALIZE_TIMEOUT_MS);
    watchdog.unref();
    const pending = engine
      .start(projectId)
      .then(
        () => {
          entry.active = true;
          if (entry.announced) deps.logger.info({ projectId }, "Lean Factory startup recovered");
          return undefined;
        },
        (error: unknown) => {
          groups.delete(projectId);
          if (startups.get(projectId) !== entry) return undefined;
          if (error instanceof InactiveProjectError) {
            startups.delete(projectId);
            return undefined;
          }
          alert(projectId, entry, error);
          entry.retry = setTimeout(() => {
            entry.retry = null;
            void startAttempt(projectId, entry);
          }, entry.delay);
          entry.retry.unref();
          entry.delay = Math.min(entry.delay * 2, MAX_RETRY_MS);
          return undefined;
        },
      )
      .finally(() => {
        clearTimeout(watchdog);
        entry.pending = null;
      });
    entry.pending = pending;
    return pending;
  }

  const mode: LeanModePort = {
    async start(projectId) {
      await ready;
      if (closing) return;
      const entry = startups.get(projectId) ?? {
        pending: null,
        retry: null,
        delay: FIRST_RETRY_MS,
        announced: false,
        active: false,
      };
      startups.set(projectId, entry);
      if (!entry.retry) await startAttempt(projectId, entry);
    },
    async stop(projectId, reason) {
      const entry = startups.get(projectId);
      startups.delete(projectId);
      if (entry?.retry) clearTimeout(entry.retry);
      await entry?.pending;
      await engine.stop(projectId, reason);
    },
  };
  return {
    mode,
    runtime: (id: string) => groups.get(id)?.rpc ?? null,
    activate,
    async shutdown() {
      closing = true;
      activate();
      await Promise.allSettled([...startups.keys()].map((id) => mode.stop(id, "switch")));
    },
  };
}

async function boundInitialization<T>(action: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Factory project or provider initialization timed out.")),
      INITIALIZE_TIMEOUT_MS,
    );
    timer.unref();
  });
  try {
    return await Promise.race([action, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function verifiedScratchProvider(
  deps: LeanBootstrapDependencies,
  config: Config | null,
  requireReady = true,
): Promise<string | null> {
  if (!config?.scratch) return null;
  if (deps.settings().sharedProviderPreferences?.installation) {
    throw new Error("The single-account scratch binding requires a standalone daemon.");
  }
  const { builder, reviewer, acceptance } = config.providers ?? {};
  if (!builder || builder !== reviewer || builder !== acceptance) {
    throw new Error("Scratch Factory needs the same explicit provider for all three roles.");
  }
  if (deps.factoryAccounts.providerType({ provider: builder }) !== "codex") {
    throw new Error("Scratch Factory needs an actual configured Codex provider.");
  }
  if (!requireReady) return builder;
  const ready = (await deps.factoryAccounts.readyProviders()).filter(
    (provider) => deps.factoryAccounts.providerType({ provider }) === "codex",
  );
  if (ready.length !== 1 || ready[0] !== builder) {
    throw new Error("Scratch Factory needs the configured provider as its only ready account.");
  }
  return builder;
}

function configuredPrimary(config: Config | null): string | null {
  if (!config) return null;
  let primary = singleHolder(config.order);
  for (const lane of lanes) {
    const configured = config.lanes?.[lane];
    if (configured === undefined) continue;
    const holder = laneHolder(configured);
    if (primary !== null && primary !== holder) {
      throw new Error("Factory V1 lanes must all name the same fixed primary.");
    }
    primary = holder;
  }
  return primary;
}

type ConfiguredLane = NonNullable<NonNullable<Config["lanes"]>[Lane]>;

function laneHolder(configured: ConfiguredLane): string | null {
  if (typeof configured === "string") return configured;
  const candidates = Array.isArray(configured) ? configured : configured.holders;
  return singleHolder(candidates);
}

function singleHolder(candidates: readonly string[] | undefined): string | null {
  if (!candidates) return null;
  if (candidates.length !== 1) throw new Error("Factory V1 requires exactly one fixed primary.");
  return candidates[0];
}

function allowsIssueEffects(mode: ExecutionMode | undefined): boolean {
  return mode === "live" || mode === "review-rehearsal";
}

function projectGitHub(
  backend: Options["github"],
  repository: string,
  mode: () => Promise<ExecutionMode>,
): Options["github"] {
  return {
    async rest(method, route, body) {
      const query = graphQLText(method, route, body);
      if (method === "GET" || (query && /^\s*query\b/.test(query) && !/\bmutation\b/.test(query))) {
        return backend.rest(method, route, body);
      }
      const current = await mode();
      if (
        current === "live" ||
        (current === "review-rehearsal" && rehearsalIssueWrite(method, route, repository, query))
      ) {
        return backend.rest(method, route, body);
      }
      throw new Error("Factory GitHub write is disabled by project configuration.");
    },
  };
}

function graphQLText(method: string, route: string, body: unknown): string | null {
  if (method !== "POST" || route !== "graphql" || !body || typeof body !== "object") return null;
  return "query" in body && typeof body.query === "string" ? body.query : null;
}

function rehearsalIssueWrite(
  method: string,
  route: string,
  repository: string,
  query: string | null,
): boolean {
  if (method !== "POST") return false;
  const prefix = `repos/${repository}/`;
  if (route.startsWith(prefix)) {
    const pathname = route.slice(prefix.length);
    return pathname === "git/refs" || /^issues\/\d+\/comments$/.test(pathname);
  }
  // The lease renewal operation is the only GraphQL mutation needed in rehearsal.
  const leaseComment =
    "mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}}";
  return query?.replace(/\s+/g, "") === leaseComment;
}

function roleAccounts(
  role: RunnerRole,
  record: ProjectRecord,
  config: Config | null,
  accounts: FactoryAccounts,
  scratchProvider: string | null,
) {
  if (scratchProvider) {
    return { providerType: "codex", profileId: null, allowedDefinitions: null };
  }
  const configured = config?.providers;
  const selection = {
    lead: [configured?.builder, record.workers.workerProfileId],
    reviewer: [configured?.reviewer, record.workers.reviewerProfileId],
    "foreman-op": [configured?.acceptance, record.roles["factory-intake"]?.launch.profileId],
    delivery: [undefined, record.roles["factory-releases"]?.launch.profileId],
    mechanic: [undefined, record.roles["factory-mechanic"]?.launch.profileId],
  }[role];
  const [provider, profileId] = selection;
  const fromProvider = provider ? accounts.providerType({ provider }) : null;
  const fromProfile = profileId ? accounts.providerType({ profileId }) : null;
  if (fromProvider && fromProfile && fromProvider !== fromProfile) {
    throw new Error("The configured Factory account and profile use different providers.");
  }
  const providerType = fromProvider ?? fromProfile ?? (role === "foreman-op" ? "claude" : null);
  if (!providerType) throw new Error("Configure a provider or profile for this Factory role.");
  return { providerType, profileId: profileId ?? null, allowedDefinitions: null };
}

async function accountDefinitions(deps: LeanBootstrapDependencies, scratch: string | null) {
  const definitions = new Map<string, string>();
  if (scratch) {
    definitions.set(scratch, `standalone/${deps.serverId}/${scratch}`);
    return definitions;
  }
  const authority = await deps.readAuthority();
  if (authority) {
    if (authority.serverId !== deps.serverId)
      throw new Error("Account authority names a different daemon.");
    const excluded = authority.settings.resourceExclusions[deps.serverId]?.providerIds ?? [];
    for (const definition of authority.settings.providerDefinitions ?? []) {
      const local = definition.bindings[deps.serverId];
      if (
        local &&
        !definition.removed &&
        definition.policy.enabled !== false &&
        !excluded.includes(definition.id)
      )
        definitions.set(local, definition.id);
    }
    return definitions;
  }
  for (const [local, entry] of Object.entries(deps.settings().providers ?? {})) {
    if (entry.installationAccountId && !entry.removed && entry.enabled !== false) {
      definitions.set(local, entry.installationAccountId);
    }
  }
  return definitions;
}

function cachedUsage(deps: LeanBootstrapDependencies, now: () => Date) {
  let lastForced = -Infinity;
  return async () => {
    const [cached, ready] = await Promise.all([
      deps.readUsage(),
      deps.factoryAccounts.readyProviders(),
    ]);
    const at = now().getTime();
    const stale = ready.some((id) => {
      const row = cached.providers.find((item) => item.providerId === id);
      const observed = row ? Date.parse(row.fetchedAt ?? cached.fetchedAt) : NaN;
      const age = at - observed;
      return !Number.isFinite(age) || age < 0 || age > ACCOUNT_READING_MAX_AGE_MS;
    });
    if (!stale || at - lastForced <= ACCOUNT_READING_MAX_AGE_MS) return cached;
    lastForced = at;
    return deps.readUsage({ forceRefresh: true });
  };
}
