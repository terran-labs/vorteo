import { createHash } from "node:crypto";
import { FactoryConfigV1Schema } from "@getpaseo/server/factory-lean";
import { z } from "zod";
import type { Logger } from "pino";

import type {
  InstallationAccountsAuthority,
  FactoryAccounts,
  UsageList,
} from "../project/account-choice.js";
import { ACCOUNT_READING_MAX_AGE_MS } from "../project/account-choice.js";
import { createFactoryAccountPolicy, type FactoryAccountSnapshot } from "./account-policy.js";
import {
  ProjectFactoryStateStore,
  projectFactoryStatePath,
  type ProjectState,
} from "../project/state.js";
import { PROJECT_FACTORY_ROLE_LABEL } from "../project/roles.js";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { readLeanConversation, type LeanConversationKind } from "./conversation.js";
import { createLeanGateBootstrap } from "./gate-bootstrap.js";
import {
  createDeliveryRuntimeRegistry,
  deliveryReleaseSchema,
  pauseProjectDelivery,
  type DeliveryRuntimeProvider,
} from "./delivery-runtime.js";
import { createLeanGitHubClient } from "./github-client.js";
import { createLeanMode } from "./mode.js";
import {
  createLeanOperationGroup,
  createLeanRuntime,
  discoverLeanIssues,
  type LeanRuntimeOptions,
} from "./runtime.js";
import { createSecurityRuntime, readExactReviewEvidence } from "./security-runtime.js";
import { createLeanStateStore } from "./state.js";
import type { LaunchLedger } from "./runners.js";
import { isRunnerRepository } from "./runner-workspaces.js";
import type { Lane, LeanModePort, RunnerRole } from "./types.js";

const configFile = ".github/vorteo-factory.json";
const INITIALIZE_TIMEOUT_MS = 8_000;
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
const lanes: Lane[] = ["intake", "merge", "delivery", "releaseBuild", "mechanic"];
const gitSha = z.string().regex(/^[a-f0-9]{40}$/u);
const gitTree = z.object({
  sha: gitSha,
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: gitSha })),
});
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
  release: deliveryReleaseSchema.optional(),
  releaseRecipeFiles: z.array(z.string().min(1)).optional(),
  shadow: z.enum(["dry-run", "review-rehearsal"]).optional(),
});

type Config = z.infer<typeof configSchema>;
type Options = Omit<LeanRuntimeOptions, "issue">;
type BootstrapOptions = Options & {
  refreshAuthority(): Promise<Config | null>;
  deliveryEpoch(): Promise<number | null>;
  deliveryBaseline(): Promise<string | null>;
  resolveBuilderPublisher(): Promise<Options["builderPublication"]>;
  canOpenConversation(repository: string): Promise<boolean>;
};
type Runtime = ReturnType<typeof createLeanRuntime>;
type ExecutionMode = "live" | "dry-run" | "review-rehearsal" | "fenced";
type ProjectRecord = ProjectState & { mode?: "crew" | "lean" };
type RuntimeServices = Pick<Options, "operations" | "enqueue">;
type RunnerServices = Omit<
  Options["runner"],
  | "accounts"
  | "roleAccounts"
  | "accountDefinitions"
  | "accountPolicy"
  | "requiredProviderTypes"
  | "allowSameAccountReview"
>;

export interface LeanBootstrapDependencies {
  builderPublication?(projectId: string, repository: string): Options["builderPublication"];
  managedBuilderPublication?(
    projectId: string,
    repository: string,
    provider: string,
    placement: string | undefined,
  ): Promise<Options["builderPublication"]>;
  paseoHome: string;
  serverId: string;
  logger: Logger;
  settings(): MutableDaemonConfig;
  readAuthority(): Promise<InstallationAccountsAuthority | null>;
  factoryAccounts: FactoryAccounts;
  providerSnapshot(): Promise<FactoryAccountSnapshot["ready"]>;
  readUsage(options?: { forceRefresh?: boolean }): Promise<UsageList>;
  runner: RunnerServices;
  workspace: Options["workspace"];
  /** Trusted native provisioner. Construction only; return null for an unconfigured project. */
  delivery?: DeliveryRuntimeProvider;
  operations: Omit<RuntimeServices["operations"], "ownerThread">;
  enqueue: RuntimeServices["enqueue"];
  localEnvironment?: NonNullable<ProjectRecord["home"]>["environment"];
  ensureConversation(projectId: string, kind: LeanConversationKind): Promise<unknown>;
  enqueueConversation(agentId: string, message: string, id: string): Promise<boolean>;
}

interface StartupAttempt {
  pending: Promise<void> | null;
  retry: ReturnType<typeof setTimeout> | null;
  delay: number;
  announced: boolean;
  active: boolean;
}

class InactiveProjectError extends Error {}
class RunnerPlacementError extends Error {}

function placementRefusal(config: Config | null): string | null {
  if (config?.runners?.placement === "host") return null;
  if (config?.runners?.placement === "dev")
    return "Factory is waiting for Dev runner placement, which this version does not support.";
  return "Factory is waiting for runner placement. To allow repository code on the Host, set runners.placement to host in the project settings.";
}

export function createLeanBootstrap(deps: LeanBootstrapDependencies) {
  const github = createLeanGitHubClient();
  const state = createLeanStateStore(deps.paseoHome);
  const projects = new ProjectFactoryStateStore(projectFactoryStatePath(deps.paseoHome));
  deps.runner.agentManager.setFactoryHostRunnerLookup(async (agentId, workspaceId) => {
    const workspace = await deps.workspace.workspaces.get(workspaceId);
    if (!workspace?.projectId || !(await projects.read()).projects[workspace.projectId])
      return null;
    const ledger = (await state.read(workspace.projectId)) as LaunchLedger;
    const saved = ledger.runners[agentId];
    if (saved && saved.serverId === null) {
      return {
        role: saved.role,
        account: saved.account,
        head: saved.reviewAccountSelection?.headSha,
      };
    }
    const pending = ledger.pendingRunnerLaunches?.[agentId];
    if (pending?.workspaceId !== workspaceId || pending.runner.serverId !== null) return null;
    return {
      role: pending.runner.role,
      account: pending.runner.account,
      head: pending.review?.headSha,
    };
  });
  const createDelivery = createDeliveryRuntimeRegistry();
  const deliveries = new Map<string, ReturnType<typeof createDelivery>>();
  const groups = new Map<string, ReturnType<typeof createLeanOperationGroup>>();
  const startups = new Map<string, StartupAttempt>();
  const pinnedConfigs = new Map<string, { commit: string; config: Config | null }>();
  const conversationAuthorities = new Map<string, BootstrapOptions["canOpenConversation"]>();
  const now = () => new Date();
  const usage = cachedUsage(deps, now);
  let closing = false;
  let activate: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    activate = resolve;
  });

  async function projectRecord(projectId: string): Promise<ProjectRecord> {
    const record: ProjectRecord | undefined = (await projects.read()).projects[projectId];
    const project = await deps.workspace.projects.get(projectId);
    if (
      closing ||
      !project ||
      project.kind !== "git" ||
      project.archivedAt !== null ||
      !record?.enabled ||
      record.mode !== "lean" ||
      record.paused ||
      record.drain ||
      (deps.localEnvironment && record.home?.environment !== deps.localEnvironment)
    ) {
      throw new InactiveProjectError("Lean Factory requires an enabled project in Lean mode.");
    }
    return record;
  }

  async function readConfig(repository: string): Promise<Config | null> {
    if (!isRunnerRepository(repository))
      throw new Error("The Factory project repository is invalid.");
    async function get<T>(route: string, schema: z.ZodType<T>): Promise<T> {
      const result = await github.rest("GET", `repos/${repository}${route}`);
      if (result.status !== 200) throw new Error("Factory could not read the owner configuration.");
      return schema.parse(result.body);
    }
    async function defaultCommit() {
      const info = await get(
        "",
        z.object({ full_name: z.string(), default_branch: z.string().min(1) }),
      );
      if (info.full_name.toLowerCase() !== repository.toLowerCase()) {
        throw new Error("Factory could not verify the configuration repository.");
      }
      const branch = info.default_branch.split("/").map(encodeURIComponent).join("/");
      const ref = await get(
        `/git/ref/heads/${branch}`,
        z.object({
          ref: z.literal(`refs/heads/${info.default_branch}`),
          object: z.object({ type: z.literal("commit"), sha: gitSha }),
        }),
      );
      return ref.object.sha;
    }
    const commit = await defaultCommit();
    const cached = pinnedConfigs.get(repository);
    if (cached?.commit === commit) return cached.config;
    const pointer = await get(
      `/git/commits/${commit}`,
      z.object({ sha: z.literal(commit), tree: z.object({ sha: gitSha }) }),
    );
    async function treeEntry(sha: string, path: string, type: string, mode: string) {
      const tree = await get(`/git/trees/${sha}`, gitTree);
      const matches = tree.tree.filter((entry) => entry.path === path);
      const entry = matches[0];
      if (
        tree.sha !== sha ||
        matches.length > 1 ||
        (entry && (entry.type !== type || entry.mode !== mode))
      ) {
        throw new Error("Factory could not verify the owner configuration tree.");
      }
      return entry?.sha;
    }
    const directory = await treeEntry(pointer.tree.sha, ".github", "tree", "040000");
    const blob = directory && (await treeEntry(directory, "vorteo-factory.json", "blob", "100644"));
    if (!blob) {
      pinnedConfigs.set(repository, { commit, config: null });
      return null;
    }
    const data = await get(
      `/git/blobs/${blob}`,
      z.object({ sha: z.literal(blob), encoding: z.literal("base64"), content: z.string() }),
    );
    const bytes = Buffer.from(data.content, "base64");
    if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob) {
      throw new Error("Factory could not verify the owner configuration bytes.");
    }
    const config = configSchema.parse(JSON.parse(bytes.toString("utf8")));
    configuredPrimary(config);
    if (config.builder?.provider) {
      if (config.providers?.builder && config.providers.builder !== config.builder.provider) {
        throw new Error("Factory configuration names two different Builder providers.");
      }
      config.providers = { ...config.providers, builder: config.builder.provider };
    }
    if (config.reviewer?.provider) {
      if (config.providers?.reviewer && config.providers.reviewer !== config.reviewer.provider) {
        throw new Error("Factory configuration names two different Reviewer providers.");
      }
      config.providers = { ...config.providers, reviewer: config.reviewer.provider };
    }
    if ((await defaultCommit()) !== commit) {
      throw new Error("The owner configuration changed while Factory was reading it.");
    }
    pinnedConfigs.set(repository, { commit, config });
    return config;
  }

  async function projectOptions(projectId: string, wake: () => void): Promise<BootstrapOptions> {
    const record = await projectRecord(projectId);
    const { repository } = record;
    const config = await readConfig(repository);
    const here = `${deps.serverId}/${projectId}`;
    const initialPrimary = configuredPrimary(config);
    const refusal = placementRefusal(config);
    if (refusal && config?.shadow !== "dry-run") throw new RunnerPlacementError(refusal);
    const scratchProvider =
      config?.shadow !== "dry-run" && (initialPrimary === null || initialPrimary === here)
        ? await verifiedScratchProvider(deps, config)
        : null;
    const reviewerType = configuredReviewerType(deps.factoryAccounts, config);
    const accountPolicy = localAccountPolicy(deps, projectId, scratchProvider, usage, reviewerType);
    let currentConfig = config;
    let refreshing: Promise<Config | null> | null = null;
    function refreshAuthority(): Promise<Config | null> {
      if (refreshing) return refreshing;
      refreshing = readConfig(repository)
        .then((latest) => {
          currentConfig = latest;
          return latest;
        })
        .catch((error: unknown) => {
          currentConfig = null;
          throw error;
        })
        .finally(() => {
          refreshing = null;
        });
      return refreshing;
    }
    const publisherPorts = new WeakMap<
      NonNullable<Options["builderPublication"]>,
      NonNullable<Options["builderPublication"]>
    >();
    async function currentPublisher(
      current: ProjectRecord,
    ): Promise<Options["builderPublication"]> {
      if (scratchProvider) return deps.builderPublication?.(projectId, repository);
      if (
        deps.localEnvironment !== "host" ||
        current.home?.environment !== "host" ||
        currentConfig?.runners?.placement !== "host" ||
        !deps.managedBuilderPublication
      )
        return undefined;
      const builder = roleAccounts("lead", current, currentConfig, deps.factoryAccounts, null);
      const publisher = await deps.managedBuilderPublication(
        projectId,
        repository,
        builder.providerType,
        "host",
      );
      if (!publisher) return undefined;
      const existing = publisherPorts.get(publisher);
      if (existing) return existing;
      const bound: NonNullable<Options["builderPublication"]> = {
        ...publisher,
        github: {
          async rest(method, route, body) {
            const prefix = `repos/${repository}/`;
            if (method === "GET" && route.startsWith(prefix))
              return github.rest(method, route, body);
            if (method === "POST" && route === `${prefix}pulls`) {
              await refreshAuthority();
              if (
                allowsIssueEffects(await executionMode()) &&
                (await resolveBuilderPublisher()) === bound
              ) {
                return github.rest(method, route, body);
              }
            }
            throw new Error(
              "Factory Builder publication has no authority for this GitHub request.",
            );
          },
        },
      };
      publisherPorts.set(publisher, bound);
      return bound;
    }
    async function resolveBuilderPublisher(): Promise<Options["builderPublication"]> {
      const current = await projectRecord(projectId).catch((error: unknown) => {
        if (error instanceof InactiveProjectError) return null;
        throw error;
      });
      return current?.repository === repository ? currentPublisher(current) : undefined;
    }
    async function executionMode(): Promise<ExecutionMode> {
      const current = await projectRecord(projectId).catch((error: unknown) => {
        if (error instanceof InactiveProjectError) return null;
        throw error;
      });
      if (!current || current.repository !== repository || !currentConfig) return "fenced";
      const primary = configuredPrimary(currentConfig);
      if (primary !== initialPrimary || (primary && primary !== here)) return "fenced";
      if (currentConfig?.shadow === "dry-run") return "dry-run";
      if (placementRefusal(currentConfig)) return "fenced";
      if (Boolean(currentConfig.scratch) !== Boolean(scratchProvider)) return "fenced";
      if (!primary && !scratchProvider) return "fenced";
      if (!scratchProvider && !(await currentPublisher(current))) return "fenced";
      return currentConfig?.shadow ?? "live";
    }
    async function requireIssueEffects(): Promise<void> {
      if (!allowsIssueEffects(await executionMode())) {
        throw new Error("Factory issue effects are disabled by project configuration.");
      }
    }
    async function canOpenConversation(requestedRepository: string): Promise<boolean> {
      if (requestedRepository !== repository || !startups.get(projectId)?.active) return false;
      try {
        await refreshAuthority();
        return allowsIssueEffects(await executionMode());
      } catch {
        return false;
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
      await refreshAuthority();
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
    function gitEvidence(primary: string | null) {
      if (!primary) return null;
      return createLeanGateBootstrap({
        paseoHome: deps.paseoHome,
        projectId,
        repository,
        primary,
        here,
        github,
        holdsPrimary: () => holds("intake"),
      });
    }
    function scratchEvidence() {
      return !initialPrimary && scratchProvider ? gitEvidence(here) : null;
    }
    const scratchReviewEvidence = scratchEvidence();
    const localRunner: Options["runner"] = {
      ...deps.runner,
      accountPolicy,
      async createAgent(input) {
        await refreshAuthority();
        await requireIssueEffects();
        return deps.runner.createAgent(input);
      },
      allowHostCodexDiffOnly: scratchProvider !== null,
      async hostReviewEvidence(issue, headSha) {
        const pool = evidence || scratchReviewEvidence;
        if (!pool) return null;
        const source = await pool.sourceForHead({ issue, headSha });
        return source?.repository === repository && source.head === headSha
          ? readExactReviewEvidence(source)
          : null;
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
    };
    const evidence = gitEvidence(initialPrimary);
    const securityReview =
      evidence && !scratchProvider
        ? createSecurityRuntime({
            ...localRunner,
            projectId,
            repository,
            here,
            now,
            state: projectState,
            paseoHome: deps.paseoHome,
            projects: deps.workspace.projects,
            workspaces: deps.workspace.workspaces,
            holdsIntake: () => holds("intake"),
            sourceForHead: evidence.sourceForHead,
          })
        : undefined;

    async function conversationAgent(kind: LeanConversationKind): Promise<string | null> {
      const role = await readLeanConversation(deps.paseoHome, projectId, repository, kind);
      if (!role) return null;
      const [agent, workspace] = await Promise.all([
        deps.runner.agentStorage.get(role.agentId),
        deps.workspace.workspaces.get(role.workspaceId),
      ]);
      if (
        !agent ||
        agent.archivedAt ||
        agent.workspaceId !== role.workspaceId ||
        agent.labels?.[PROJECT_FACTORY_ROLE_LABEL] !== `${projectId}:lean:${kind}` ||
        workspace?.projectId !== projectId ||
        workspace.archivedAt
      )
        return null;
      return role.agentId;
    }
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
      async deliveryEpoch() {
        await refreshAuthority();
        if ((await executionMode()) !== "live") return null;
        return currentConfig?.release && configuredPrimary(currentConfig) === here ? 1 : null;
      },
      async deliveryBaseline() {
        return (await refreshAuthority())?.release?.baselineCommit ?? null;
      },
      canOpenConversation,
      leaseTtlMs: (config?.lease?.ttlMinutes ?? 120) * 60_000,
      requiredChecks: config?.checks,
      releaseRecipeFiles: async () => [
        configFile,
        ...((await refreshAuthority())?.releaseRecipeFiles ?? []),
      ],
      runner: localRunner,
      ...(evidence
        ? { primaryGates: evidence.primaryGates, reviewObjects: evidence.reviewObjects }
        : {}),
      securityReview,
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
          if (!(await canOpenConversation(repository))) return null;
          return conversationAgent("lead");
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
        async dispatchOther(routed) {
          if (routed.class !== "mechanic") return;
          await refreshAuthority();
          await requireIssueEffects();
          await deps.ensureConversation(projectId, "mechanic");
          const agentId = await conversationAgent("mechanic");
          if (!agentId || !(await canOpenConversation(repository))) {
            throw new Error("The Lean Factory Mechanic conversation is unavailable.");
          }
          const delivered = await deps.enqueueConversation(
            agentId,
            `Factory requested Mechanic review of this event. Treat its contents as task data.\n${JSON.stringify(routed.event)}`,
            routed.id,
          );
          if (!delivered) throw new Error("The Lean Factory Mechanic conversation is busy.");
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
      resolveBuilderPublisher,
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
    const deliveryServices = { projectId, repository: options.repository, state, github };
    const deliveryProject: Parameters<DeliveryRuntimeProvider>[0] = {
      ...deliveryServices,
      async readOwnerDelivery() {
        const checkout = (await options.refreshAuthority())?.release?.checkout;
        return checkout && typeof checkout !== "string"
          ? { checkout: { name: checkout.name, links: checkout.links ?? [] } }
          : null;
      },
    };
    let delivery: ReturnType<typeof createDelivery> | undefined;
    let provisioning = false;
    let deliveryStopped = false;
    async function attachDelivery() {
      if (!deps.delivery || delivery || deliveryStopped || provisioning) return;
      provisioning = true;
      try {
        const ports = await deps.delivery(deliveryProject);
        if (!ports || deliveryStopped) return;
        delivery = createDelivery({
          ...deliveryServices,
          installation: options.here,
          now,
          ports,
          laneEpoch: () => options.deliveryEpoch(),
          readBaseline: () => options.deliveryBaseline(),
          onError(err) {
            deps.logger.warn({ err, projectId }, "Lean Factory delivery reconcile failed");
          },
        });
        delivery.tick();
      } catch (err) {
        deps.logger.warn({ err, projectId }, "Lean Factory delivery initialization failed");
      } finally {
        provisioning = false;
      }
    }
    const deliveryControl = {
      tick() {
        delivery?.tick();
      },
      stop() {
        deliveryStopped = true;
        delivery?.stop();
      },
    };
    deliveries.set(projectId, deliveryControl);
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

    let lastPlacementRefusal: string | null = null;
    let attachedPublisher: Options["builderPublication"];
    async function reconcile() {
      delivery?.tick();
      const config = await options.refreshAuthority();
      if (config?.release?.checkout && !delivery) void attachDelivery();
      const refusal = placementRefusal(config);
      if (refusal && refusal !== lastPlacementRefusal && config?.shadow !== "dry-run") {
        deps.logger.warn({ projectId }, refusal);
      }
      lastPlacementRefusal = refusal;
      const mode = await options.executionMode();
      if (!allowsIssueEffects(mode)) {
        await stopChildren();
        if (mode === "dry-run") await discoverLeanIssues(options);
        return;
      }
      const publisher = await options.resolveBuilderPublisher();
      if (publisher !== attachedPublisher) {
        await stopChildren();
        attachedPublisher = publisher;
      }
      const discovered = await discoverLeanIssues(options);
      const slots = Math.max(1, (await state.read(projectId)).local.runners);
      for (const issue of discovered) {
        if (children.has(issue)) continue;
        if (children.size >= slots) break;
        const runtime = createLeanRuntime(
          {
            ...options,
            issue,
            builderPublication: publisher,
            async executionMode() {
              const current = await options.executionMode();
              if (
                allowsIssueEffects(current) &&
                (await options.resolveBuilderPublisher()) !== publisher
              )
                return "fenced";
              return current;
            },
          },
          group,
        );
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
        conversationAuthorities.set(projectId, options.canOpenConversation);
      },
      reconcile,
      async inspectDeadlines() {
        delivery?.tick();
        if (allowsIssueEffects(await options.executionMode())) await group.tickWatchdog();
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async stop(reason: Parameters<LeanModePort["stop"]>[1]) {
        deliveryControl.stop();
        if (deliveries.get(projectId) === deliveryControl) deliveries.delete(projectId);
        groups.delete(projectId);
        conversationAuthorities.delete(projectId);
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
    void (async () => {
      const first = await projectRecord(projectId);
      const config = await readConfig(first.repository);
      const current = await projectRecord(projectId);
      if (
        !config ||
        config.shadow === "dry-run" ||
        first.repository !== current.repository ||
        startups.get(projectId) !== entry
      )
        return;
      const primary = configuredPrimary(config);
      const standaloneScratch =
        primary === null &&
        config.scratch &&
        !deps.settings().sharedProviderPreferences?.installation;
      if (primary !== `${deps.serverId}/${projectId}` && !standaloneScratch) return;
      await deps.operations.push?.send({
        title: "Factory startup needs attention",
        body:
          error instanceof RunnerPlacementError
            ? error.message
            : "Factory could not finish initializing this project. The daemon will retry automatically.",
        data: { projectId },
      });
    })().catch((err) => {
      deps.logger.debug(
        { err, projectId },
        "Factory startup push could not be authorized or delivered",
      );
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
          if (closing || startups.get(projectId) !== entry) return undefined;
          entry.active = true;
          if (entry.announced) {
            deps.logger.info({ projectId }, "Lean Factory startup recovered");
            // Service startup may already hold its project queue while awaiting mode.start.
            void deps.ensureConversation(projectId, "lead").catch((err) => {
              deps.logger.warn({ err, projectId }, "Lean Factory Lead recovery failed");
            });
          }
          return undefined;
        },
        (error: unknown) => {
          groups.delete(projectId);
          deliveries.get(projectId)?.stop();
          deliveries.delete(projectId);
          conversationAuthorities.delete(projectId);
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
      deliveries.get(projectId)?.stop();
      const entry = startups.get(projectId);
      startups.delete(projectId);
      if (entry?.retry) clearTimeout(entry.retry);
      try {
        if (reason === "pause" && deps.delivery) {
          const record = (await projects.read()).projects[projectId];
          if (record?.mode === "lean" && record.paused && !record.drain) {
            await pauseProjectDelivery(state, projectId, now);
          }
        }
      } finally {
        await entry?.pending;
        await engine.stop(projectId, reason);
      }
    },
  };
  return {
    mode,
    runtime: (id: string) => groups.get(id)?.rpc ?? null,
    activate,
    async canOpenConversation(projectId: string, repository: string) {
      return (await conversationAuthorities.get(projectId)?.(repository)) === true;
    },
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

function configuredReviewerType(accounts: FactoryAccounts, config: Config | null): string {
  const provider = config?.providers?.reviewer ?? "claude";
  return accounts.providerType({ provider }) ?? provider;
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

type AccountAuthority = Pick<LeanBootstrapDependencies, "serverId" | "settings" | "readAuthority">;

async function accountDefinitions(deps: AccountAuthority, scratch: string | null) {
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
  if (deps.settings().sharedProviderPreferences?.installation)
    throw new Error("Factory could not verify the installation account definitions.");
  return definitions;
}

export function localAccountPolicy(
  deps: AccountAuthority &
    Pick<LeanBootstrapDependencies, "providerSnapshot"> & {
      factoryAccounts: Pick<FactoryAccounts, "profileAccount">;
      runner: { agentManager: Pick<RunnerServices["agentManager"], "usageLimitsByProvider"> };
    },
  projectId: string,
  scratchProvider: string | null,
  usage: () => Promise<UsageList>,
  reviewerType = scratchProvider ? "codex" : "claude",
) {
  return createFactoryAccountPolicy(async (selection) => {
    if (selection.projectId !== projectId || selection.serverId !== null)
      throw new Error("Factory V1 selects accounts only on this project's local daemon.");
    if (selection.role === "reviewer" && selection.providerType !== reviewerType)
      throw new Error(`Factory reviews require a ${reviewerType} account.`);
    const [entries, readings, definitions, holds] = await Promise.all([
      deps.providerSnapshot(),
      usage().catch(() => ({ fetchedAt: "", providers: [] })),
      accountDefinitions(deps, scratchProvider),
      deps.runner.agentManager.usageLimitsByProvider(),
    ]);
    const settings = deps.settings();
    const ready = scratchProvider
      ? entries.filter((row) => row.provider === scratchProvider)
      : entries.map((row) => ({
          provider: row.provider,
          status: row.status,
          enabled:
            row.enabled &&
            (!settings.sharedProviderPreferences?.installation || definitions.has(row.provider)),
        }));
    const profileAccount = selection.profileId
      ? deps.factoryAccounts.profileAccount(selection.profileId)
      : null;
    return {
      serverId: null,
      settings,
      ready,
      usage: readings,
      installationDefinitionByProvider: Object.fromEntries(definitions),
      defaultProvider:
        scratchProvider ??
        profileAccount ??
        settings.sharedProviderPreferences?.defaultProvider ??
        null,
      usageLimitedUntilByProvider: Object.fromEntries(holds),
      // Keep ten additional percentage points for review when the Builder uses its provider type.
      reservedHeadroomPct:
        selection.role === "lead" && selection.providerType === reviewerType ? 10 : 0,
      priority: "normal",
    };
  });
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
    return deps.readUsage({ forceRefresh: true }).catch(() => cached);
  };
}
