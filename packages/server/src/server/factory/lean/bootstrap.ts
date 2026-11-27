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
const configSchema = FactoryConfigV1Schema.extend({
  version: z.literal(1),
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
});

type Config = z.infer<typeof configSchema>;
type Options = Omit<LeanRuntimeOptions, "issue">;
type Runtime = ReturnType<typeof createLeanRuntime>;
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
    return configSchema.parse(JSON.parse(Buffer.from(data.content, "base64").toString("utf8")));
  }

  async function projectOptions(projectId: string, wake: () => void): Promise<Options> {
    const record = await projectRecord(projectId);
    const { repository } = record;
    const config = await readConfig(repository);
    const scratchProvider = await verifiedScratchProvider(deps, config);
    const configuredRoles = async (role: RunnerRole) => {
      const saved = await projectRecord(projectId);
      const latest = await readConfig(repository);
      const allowed = await verifiedScratchProvider(deps, latest);
      if (allowed !== scratchProvider)
        throw new Error("Factory provider authority changed. Restart the project mode.");
      return roleAccounts(role, saved, latest, deps.factoryAccounts, allowed);
    };
    async function holds(lane: Lane): Promise<boolean> {
      if (closing || (lane !== "intake" && lane !== "merge")) return false;
      if (!scratchProvider && !deps.runner.accountPolicy) return false;
      const file = await projects.read();
      const current: ProjectRecord | undefined = file.projects[projectId];
      return (
        current?.enabled === true &&
        current.mode === "lean" &&
        !current.paused &&
        current.repository === repository
      );
    }
    return {
      projectId,
      repository,
      github,
      now,
      state,
      paseoHome: deps.paseoHome,
      here: `${deps.serverId}/${projectId}`,
      leaseTtlMs: (config?.lease?.ttlMinutes ?? 120) * 60_000,
      requiredChecks: config?.checks,
      releaseRecipeFiles: async () => [
        configFile,
        ...((await readConfig(repository))?.releaseRecipeFiles ?? []),
      ],
      runner: {
        ...deps.runner,
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
        allowSameAccountReview: () => sameAccountAllowed(repository),
        requiredProviderTypes: { "foreman-op": scratchProvider ? "codex" : "claude" },
      },
      workspace: deps.workspace,
      operations: {
        ...deps.operations,
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
          config: await readConfig(repository),
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
      enqueue: deps.enqueue,
      allowSameAccount: () => sameAccountAllowed(repository),
    };
  }

  async function sameAccountAllowed(repository: string): Promise<boolean> {
    return (await readConfig(repository))?.review?.allowSameAccount === true;
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

    async function reconcile() {
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
      inspectDeadlines: () => group.tickWatchdog(),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async stop(reason: Parameters<LeanModePort["stop"]>[1]) {
        groups.delete(projectId);
        for (const child of children.values()) {
          child.unsubscribe();
          if (closing || reason === "switch") child.runtime.detach();
          else await child.runtime.stop(reason);
        }
        children.clear();
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
  const ready = (await deps.factoryAccounts.readyProviders()).filter(
    (provider) => deps.factoryAccounts.providerType({ provider }) === "codex",
  );
  if (ready.length !== 1 || ready[0] !== builder) {
    throw new Error("Scratch Factory needs the configured provider as its only ready account.");
  }
  return builder;
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
