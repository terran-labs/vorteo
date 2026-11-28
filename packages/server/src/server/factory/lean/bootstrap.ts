import { FactoryConfigV1Schema } from "@getpaseo/server/factory-lean";
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
import { createGitClaimStore } from "./machines/claim-git.js";
import { createClosedClaimCleanup } from "./machines/claim-cleanup.js";
import { resolveMachineRoles, holdsMachineLane } from "./machines/roles.js";
import { readPinnedFactoryConfig } from "./machines/pinned-factory-config.js";
import {
  configuredLocalHeavyBatches,
  createLocalHostBatches,
} from "./machines/host-batch-runtime.js";
import { createPausedMachineCleanup } from "./machines/paused-cleanup.js";
import { createLeanGateBootstrap, type LeanGateBootstrapOptions } from "./gate-bootstrap.js";
import { createGateCommandRunner } from "./gate-command-runner.js";
import { verifyHostBuilderWorktreeCustody } from "./machines/host-worktree-custody.js";
import { verifyMachinePayload } from "./machines/host-key.js";
import { isRunnerRepository, openMachineRepository } from "./runner-workspaces.js";
import type { Lane, LeanLedger, LeanModePort, LeanStateStore, RunnerRole } from "./types.js";

const configFile = ".github/vorteo-factory.json";
const INITIALIZE_TIMEOUT_MS = 8_000;
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
const commitSha = z.string().regex(/^[a-f0-9]{40}$/u);
const lanes: Lane[] = ["intake", "merge", "delivery", "releaseBuild", "mechanic"];
const configSchema = FactoryConfigV1Schema.extend({
  version: z.literal(1),
  builder: z.looseObject({ provider: z.string().min(1).optional() }).optional(),
  scratch: z.boolean().optional(),
  runners: z.looseObject({ placement: z.enum(["host", "dev"]).optional() }).optional(),
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

type Config = z.infer<typeof configSchema> & { configCommit: string };
type Options = Omit<LeanRuntimeOptions, "issue">;
type BootstrapOptions = Options & {
  isOwnerPaused(): Promise<boolean>;
  refreshAuthority(): Promise<Config | null>;
  cleanClosedClaims?(): Promise<void>;
  coordinationRefusal(): Promise<string | null>;
  pausedMachineCleanupForIssue?(issue: number): NonNullable<Options["pausedMachineCleanup"]>;
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
  | "requiredProviderTypes"
  | "allowSameAccountReview"
>;

export interface LeanBootstrapDependencies {
  machineSigner?: (projectId: string, payload: Uint8Array) => Promise<string>;
  /** Explicit isolated-fixture custody. Installed runtimes cannot use this path. */
  allowStandalonePausedWorkspaceInspection?(
    projectId: string,
    repository: string,
  ): Promise<boolean>;
  localEnvironment?: "host" | "container";
  /** Supplied only from complete verified Host topology. An empty list means Host-only. */
  verifiedGuestRoots?: readonly string[];
  delivery?(input: {
    projectId: string;
    repository: string;
    state: LeanStateStore;
    now(): Date;
    fence(): Promise<number | null>;
  }): Options["delivery"];
  gateDocker?: LeanGateBootstrapOptions["docker"];
  /** Shared owner-account mutation budget. Coordinated projects require this authority. */
  chargeGitWrite?(repository: string): Promise<void>;
  /** Existing delivery policy's current primary epoch. */
  deliveryEpoch?(projectId: string, repository: string): Promise<number | null>;
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
  const pinnedConfigs = new Map<string, { sha: string; config: Config | null }>();
  const now = () => new Date();
  const usage = cachedUsage(deps, now);
  let closing = false;
  let activate: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    activate = resolve;
  });

  async function projectRecord(projectId: string): Promise<ProjectRecord> {
    const record: ProjectRecord | undefined = (await projects.read()).projects[projectId];
    if (!activeLeanProject(record)) {
      throw new InactiveProjectError("Lean Factory requires an enabled project in Lean mode.");
    }
    return record;
  }

  async function readConfig(repository: string): Promise<Config | null> {
    if (!isRunnerRepository(repository))
      throw new Error("The Factory project repository is invalid.");
    async function readDefaultCommit() {
      const repo = await github.rest("GET", `repos/${repository}`);
      if (repo.status !== 200) throw new Error("Factory could not read the repository.");
      const identity = z
        .object({ full_name: z.string(), default_branch: z.string().min(1) })
        .parse(repo.body);
      if (identity.full_name.toLowerCase() !== repository.toLowerCase()) {
        throw new Error("Factory could not verify the configuration repository.");
      }
      const branch = identity.default_branch.split("/").map(encodeURIComponent).join("/");
      const ref = await github.rest("GET", `repos/${repository}/git/ref/heads/${branch}`);
      if (ref.status !== 200) throw new Error("Factory could not resolve the default branch.");
      return z
        .object({
          ref: z.literal(`refs/heads/${identity.default_branch}`),
          object: z.object({ type: z.literal("commit"), sha: commitSha }),
        })
        .parse(ref.body).object.sha;
    }
    const sha = await readDefaultCommit();
    const previous = pinnedConfigs.get(repository);
    if (previous?.sha === sha) return previous.config;
    const raw = await readPinnedFactoryConfig(github, repository, sha);
    if ((await readDefaultCommit()) !== sha) {
      throw new Error("The owner configuration changed while Factory was reading it.");
    }
    if (raw === null) {
      pinnedConfigs.set(repository, { sha, config: null });
      return null;
    }
    const config = configSchema.parse(raw);
    configuredPrimary(config);
    if (config.builder?.provider) {
      if (config.providers?.builder && config.providers.builder !== config.builder.provider) {
        throw new Error("Factory configuration names two different Builder providers.");
      }
      config.providers = { ...config.providers, builder: config.builder.provider };
    }
    const pinned = { ...config, configCommit: sha };
    pinnedConfigs.set(repository, { sha, config: pinned });
    return pinned;
  }

  async function projectOptions(projectId: string, wake: () => void): Promise<BootstrapOptions> {
    const record = await projectRecord(projectId);
    const { repository } = record;
    const config = await readConfig(repository);
    const here = `${deps.serverId}/${projectId}`;
    const initialPrimary = configuredPrimary(config);
    const coordination = coordinationMode(config);
    const usesHostDispatch = coordination === "host";
    const usesMachineClaims = coordination === "signed-dev";
    const usesCoordination = coordination !== "local";
    const signer = deps.machineSigner;
    const sharedCharge = deps.chargeGitWrite;
    function chargeMachineMutation() {
      if (!sharedCharge)
        throw new Error("The shared Factory GitHub mutation budget is unavailable.");
      return sharedCharge(repository);
    }
    function pinnedReviewerType(latest: Config | null): string | null {
      const provider = latest?.providers?.reviewer;
      return provider ? deps.factoryAccounts.providerType({ provider }) : null;
    }
    function nativeHost(current: ProjectRecord) {
      return (
        deps.localEnvironment === "host" &&
        !process.env.PASEO_NETWORK_MODE &&
        current.home?.environment !== "container" &&
        deps.settings().sharedProviderPreferences?.installation?.environment !== "container"
      );
    }
    async function coordinationRefusal(): Promise<string | null> {
      if (currentConfig?.shadow === "dry-run") return null;
      const placement = currentConfig?.runners?.placement;
      if (placement === "dev") {
        return "Dev runner placement is paused. Set runners.placement to host for unsigned Host dispatch. Signed Dev dispatch requires an isolated signing service and remains unavailable.";
      }
      if (placement !== "host") {
        return "Choose runner placement. To allow repository code on the Host, set runners.placement to host.";
      }
      if (coordinationMode(currentConfig) !== coordination) {
        return "Restart Factory after changing its runner placement or machine roster.";
      }
      const current = (await projects.read()).projects[projectId];
      if (!current || !nativeHost(current)) {
        return "Host placement is configured. Run this Factory project on a verified native Host.";
      }
      if (usesHostDispatch) {
        if (!sharedCharge) {
          return "Coordinated Factory needs the shared GitHub mutation budget. Connect the installation-wide account budget before running this project.";
        }
        if (!roles(currentConfig)?.listsMachine(here)) {
          return "Add this installation to the owner configuration's Host machine roster.";
        }
        if (!pinnedReviewerType(currentConfig)) {
          return "Set providers.reviewer in the owner configuration to a supported provider type or a trusted Host account.";
        }
      }
      return null;
    }
    async function initialScratchProvider() {
      if (
        config?.runners?.placement !== "host" ||
        !nativeHost(record) ||
        config.shadow === "dry-run"
      ) {
        return null;
      }
      const canUseProvider = usesHostDispatch
        ? Boolean(sharedCharge)
        : initialPrimary === null || initialPrimary === here;
      return canUseProvider ? verifiedScratchProvider(deps, config) : null;
    }
    function configuredReviewerType() {
      const reviewer = config?.providers?.reviewer ?? "claude";
      return deps.factoryAccounts.providerType({ provider: reviewer }) ?? reviewer;
    }
    const scratchProvider = await initialScratchProvider();
    const reviewerType = configuredReviewerType();
    let currentConfig = config;
    function roles(latest: Config | null) {
      if (!usesCoordination) return null;
      const result = resolveMachineRoles(latest, here);
      if (!result.roles) throw new Error(result.error);
      return result.roles;
    }
    roles(currentConfig);
    let refreshing: Promise<Config | null> | null = null;
    function refreshAuthority(): Promise<Config | null> {
      if (refreshing) return refreshing;
      refreshing = readConfig(repository)
        .then((latest) => {
          if (coordinationMode(latest) === coordination) roles(latest);
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
    function permitsExecutionPlacement(
      current: ProjectRecord,
      latest: Config,
      primary: string | null,
    ) {
      if (latest.runners?.placement !== "host" || !nativeHost(current)) return false;
      if (usesHostDispatch) return Boolean(sharedCharge && roles(latest)?.listsMachine(here));
      return primary ? primary === here : Boolean(scratchProvider);
    }

    async function executionMode(): Promise<ExecutionMode> {
      if (closing) return "fenced";
      const current = (await projects.read()).projects[projectId];
      if (!activeLeanProject(current) || current.repository !== repository) return "fenced";
      const latest = currentConfig;
      if (!latest || coordinationMode(latest) !== coordination) return "fenced";
      const primary = configuredPrimary(latest);
      if (primary !== initialPrimary) return "fenced";
      if (latest.shadow === "dry-run") return "dry-run";
      if (!permitsExecutionPlacement(current, latest, primary)) return "fenced";
      if (Boolean(latest.scratch) !== Boolean(scratchProvider)) return "fenced";
      if (!scratchProvider && !deps.runner.accountPolicy) return "fenced";
      return latest.shadow ?? "live";
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
      if (usesHostDispatch && role === "reviewer" && !pinnedReviewerType(latest)) {
        throw new Error("The owner configuration needs a supported providers.reviewer.");
      }
      if (usesCoordination) {
        const activeRoles = roles(latest);
        const authorized = role === "lead" ? activeRoles?.canClaim : activeRoles?.primary === here;
        if (!authorized)
          throw new Error("This installation cannot launch the requested Factory role.");
      }
      const saved = await projectRecord(projectId);
      const allowed = await verifiedScratchProvider(deps, latest);
      if (allowed !== scratchProvider)
        throw new Error("Factory provider authority changed. Restart the project mode.");
      return roleAccounts(role, saved, latest, deps.factoryAccounts, allowed);
    };
    async function holds(lane: Lane): Promise<boolean> {
      const mode = await executionMode();
      if (
        !allowsIssueEffects(mode) ||
        (usesCoordination && !holdsMachineLane(roles(currentConfig), lane))
      ) {
        return false;
      }
      if (lane === "intake") return true;
      return (
        mode === "live" && (lane === "merge" || (lane === "delivery" && initialPrimary === here))
      );
    }

    async function isPrimary() {
      const latest = await refreshAuthority();
      return allowsIssueEffects(await executionMode()) && roles(latest)?.primary === here;
    }

    async function openCoordinationGit() {
      if (!sharedCharge) return null;
      const authorized = usesHostDispatch ? nativeHost(record) : usesMachineClaims && signer;
      if (!authorized) return null;
      return {
        repository,
        cwd: await openMachineRepository(deps.paseoHome, projectId, repository),
        async chargeMutation() {
          await refreshAuthority();
          await requireIssueEffects();
          await chargeMachineMutation();
        },
      };
    }
    const machineGit = await openCoordinationGit();
    function createClosedCleanup() {
      if (!machineGit || initialPrimary !== here) return undefined;
      const cleanupRefs = createGitClaimStore({
        ...machineGit,
        async chargeMutation() {
          await machineGit.chargeMutation();
          if (roles(currentConfig)?.primary !== here || (await executionMode()) !== "live")
            throw new Error("Only the active primary can clean closed Factory claims.");
        },
      });
      return createClosedClaimCleanup({
        now,
        async holdsPrimary() {
          const latest = await refreshAuthority();
          return roles(latest)?.primary === here && (await executionMode()) === "live";
        },
        listIssues: cleanupRefs.listIssues,
        async isClosedIssue(issue) {
          const result = await github.rest("GET", `repos/${repository}/issues/${issue}`);
          if (result.status !== 200) return false;
          const parsed = z
            .object({
              number: z.literal(issue),
              state: z.literal("closed"),
              pull_request: z.undefined().optional(),
            })
            .safeParse(result.body);
          return parsed.success;
        },
        async remove(issue, revision) {
          const current = await cleanupRefs.read(issue);
          if (current?.revision !== revision) return false;
          const envelope = z
            .object({ kind: z.string().optional() })
            .safeParse(JSON.parse(current.body));
          if (!envelope.success || (envelope.data.kind === "unsigned-host") !== usesHostDispatch) {
            return false;
          }
          return cleanupRefs.compareAndSwap(issue, revision, null);
        },
      });
    }
    const projectState: Options["state"] = {
      read: (id) => state.read(id),
      async mutate(id, change, revision) {
        await requireIssueEffects();
        return state.mutate(id, change, revision);
      },
    };
    async function isOwnerPaused(): Promise<boolean> {
      if (closing || !usesCoordination) return false;
      const current = (await projects.read()).projects[projectId];
      const project = await deps.workspace.projects.get(projectId);
      return Boolean(
        project?.kind === "git" &&
        project.archivedAt === null &&
        current?.enabled &&
        current.mode === "lean" &&
        current.paused &&
        current.repository === repository,
      );
    }
    async function machineRunnerPlacement(): Promise<{
      configCommit: string;
      placement: "host";
    } | null> {
      if (!usesHostDispatch || !machineGit || closing) return null;
      const latest = await refreshAuthority();
      const [registry, project] = await Promise.all([
        projects.read(),
        deps.workspace.projects.get(projectId),
      ]);
      const current = registry.projects[projectId];
      if (
        project?.kind !== "git" ||
        project.archivedAt !== null ||
        !current?.enabled ||
        current.mode !== "lean" ||
        current.repository !== repository ||
        !nativeHost(current) ||
        latest?.runners?.placement !== "host" ||
        currentConfig?.configCommit !== latest.configCommit
      )
        return null;
      const authorized = roles(latest);
      if (!authorized || authorized.primary !== initialPrimary || !authorized.listsMachine(here))
        return null;
      return { configCommit: latest.configCommit, placement: "host" };
    }

    async function verifyPausedHostWorkspace(issue: number): Promise<boolean> {
      const guestRoots = deps.verifiedGuestRoots;
      if (!guestRoots || !(await machineRunnerPlacement())) return false;
      const ledger: LeanLedger & {
        hostBuilderAssignments?: Record<
          string,
          { issue: number; workspaceId: string; account: string }
        >;
      } = await state.read(projectId);
      const builders = Object.values(ledger.runners).filter(
        (runner) =>
          runner.issue === issue &&
          runner.role === "lead" &&
          runner.serverId === null &&
          runner.installation === here &&
          runner.closedAt === null,
      );
      if (builders.length !== 1) return false;
      const runner = builders[0];
      const launch = ledger.hostBuilderAssignments?.[runner.agentId];
      if (!launch || launch.issue !== issue || launch.account !== runner.account) return false;
      const [session, workspace] = await Promise.all([
        deps.runner.agentStorage.get(runner.agentId),
        deps.workspace.workspaces.get(launch.workspaceId),
      ]);
      if (!session?.provider || session.workspaceId !== launch.workspaceId || !workspace)
        return false;
      return verifyHostBuilderWorktreeCustody({
        host: {
          paseoHome: deps.paseoHome,
          guestRoots,
          topology: guestRoots.length === 0 ? "host-only" : "paired",
        },
        projectId,
        installation: here,
        issue,
        runner: { ...runner, installation: here },
        workspace,
        session: {
          agentId: runner.agentId,
          provider: session.provider,
          workspaceId: session.workspaceId,
        },
      });
    }

    function createPausedCleanupForIssue(issue: number) {
      if (!machineGit || !initialPrimary) throw new Error("Factory claim cleanup is unavailable.");
      const scope = {
        issue,
        git: { cwd: machineGit.cwd, repository },
        projectId,
        installation: here,
        primary: initialPrimary,
        state,
        now,
        isOwnerPaused,
        async canVerifySavedWork() {
          if (usesHostDispatch) return verifyPausedHostWorkspace(issue);
          if (
            process.env.VORTEO_INSTALLATION_CLIENT_CONFIG ||
            process.env.PASEO_NETWORK_MODE ||
            deps.settings().sharedProviderPreferences?.installation ||
            (await projects.read()).projects[projectId]?.home?.environment === "container"
          )
            return false;
          return (
            (await deps.allowStandalonePausedWorkspaceInspection?.(projectId, repository)) === true
          );
        },
        async refreshPinnedRoles() {
          const latest = await refreshAuthority();
          return latest && latest.shadow !== "dry-run" ? roles(latest) : null;
        },
        chargeMutation: chargeMachineMutation,
        async readWorkHead(number: number) {
          if (number !== issue) return null;
          const ref = `refs/heads/factory/issue-${issue}`;
          const result = await github.rest(
            "GET",
            `repos/${repository}/git/ref/heads/factory/issue-${issue}`,
          );
          if (result.status !== 200) return null;
          return z
            .object({
              ref: z.literal(ref),
              object: z.object({ type: z.literal("commit"), sha: commitSha }),
            })
            .parse(result.body).object.sha;
        },
      };
      if (usesHostDispatch) return createPausedMachineCleanup({ ...scope, mode: "unsigned-host" });
      if (!signer) throw new Error("Signed Factory cleanup needs isolated signing authority.");
      return createPausedMachineCleanup({
        ...scope,
        sign: (payload) => signer(projectId, payload),
      });
    }

    async function holdsPrimaryEvidence() {
      if (usesHostDispatch) {
        return (await machineRunnerPlacement()) !== null && (await isPrimary());
      }
      if (usesMachineClaims) return isPrimary();
      await refreshAuthority();
      return holds("intake");
    }
    const primaryEvidence = initialPrimary
      ? createLeanGateBootstrap({
          github,
          projectId,
          repository,
          paseoHome: deps.paseoHome,
          here,
          primary: initialPrimary,
          docker: deps.gateDocker,
          holdsPrimary: holdsPrimaryEvidence,
        })
      : undefined;

    function batchRuntime(readInputs: Parameters<NonNullable<Options["machineBatches"]>>[0]) {
      if (!usesHostDispatch || !initialPrimary) {
        // The old offload transport needs independent key isolation. Fail closed on configured batches.
        return {
          async readyForAcceptance() {
            const latest = await refreshAuthority();
            return latest !== null && configuredLocalHeavyBatches(latest)?.length === 0;
          },
          async reconcileSecondary() {
            return false;
          },
        };
      }
      const execution = primaryEvidence?.primaryGates.execution;
      const execute = execution
        ? createGateCommandRunner({ ...execution, primary: initialPrimary, now })
        : async () => null;
      return createLocalHostBatches({
        projectId,
        repository,
        primary: initialPrimary,
        state: projectState,
        now,
        readInputs,
        execute,
        holdsPrimary: holdsPrimaryEvidence,
        readConfig: (commit) => readPinnedFactoryConfig(github, repository, commit),
      });
    }
    function createPrimaryDelivery() {
      const readEpoch = deps.deliveryEpoch;
      if (!readEpoch || !deps.delivery || initialPrimary !== here) return undefined;
      async function primaryMayDeliver() {
        await refreshAuthority();
        return (await holds("delivery")) && (await holdsPrimaryEvidence());
      }
      return deps.delivery({
        projectId,
        repository,
        state: projectState,
        now,
        async fence() {
          if (!(await primaryMayDeliver())) return null;
          const epoch = await readEpoch(projectId, repository);
          if (epoch === null || !Number.isSafeInteger(epoch) || epoch <= 0) return null;
          return (await primaryMayDeliver()) ? epoch : null;
        },
      });
    }
    function coordinationOptions(): Pick<
      BootstrapOptions,
      | "pausedMachineCleanupForIssue"
      | "cleanClosedClaims"
      | "hostDispatch"
      | "machineClaims"
      | "machineBatches"
      | "machineRunnerPlacement"
      | "hostSourceForHead"
    > {
      return {
        pausedMachineCleanupForIssue:
          machineGit && initialPrimary ? createPausedCleanupForIssue : undefined,
        cleanClosedClaims: createClosedCleanup(),
        hostSourceForHead: usesHostDispatch ? primaryEvidence?.sourceForHead : undefined,
        machineRunnerPlacement,
        hostDispatch:
          usesHostDispatch && machineGit
            ? { refs: createGitClaimStore(machineGit), isPrimary }
            : undefined,
        machineClaims:
          usesMachineClaims && machineGit && signer
            ? {
                refs: createGitClaimStore(machineGit),
                sign: (payload) => signer(projectId, payload),
                async verify(installation, payload, signature) {
                  const keys = roles(currentConfig)?.publicKeysFor(installation) ?? [];
                  return keys.some((key) => verifyMachinePayload(key, payload, signature));
                },
                isPrimary,
              }
            : undefined,
        machineBatches: usesCoordination ? batchRuntime : undefined,
      };
    }

    return {
      projectId,
      repository,
      github: projectGitHub(
        github,
        repository,
        async () => {
          await refreshAuthority();
          return executionMode();
        },
        usesCoordination ? chargeMachineMutation : undefined,
      ),
      now,
      state: projectState,
      paseoHome: deps.paseoHome,
      here,
      executionMode,
      isOwnerPaused,
      refreshAuthority,
      ...coordinationOptions(),
      ...(primaryEvidence
        ? {
            primaryGates: primaryEvidence.primaryGates,
            reviewObjects: primaryEvidence.reviewObjects,
          }
        : {}),
      coordinationRefusal,
      delivery: createPrimaryDelivery(),
      async machineReviewPolicy() {
        const latest = await refreshAuthority();
        if (!usesCoordination || !latest || roles(latest)?.primary !== here) return null;
        const providerType = pinnedReviewerType(latest);
        if (!providerType) return null;
        return {
          configCommit: latest.configCommit,
          providerType,
          allowForeignSameProvider: latest.review?.allowSameAccount ?? true,
        };
      },
      leaseTtlMs: (usesCoordination ? 120 : (config?.lease?.ttlMinutes ?? 120)) * 60_000,
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
        if (usesCoordination) await refreshAuthority();
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
    groups.set(projectId, {
      ...group,
      rpc: {
        ...group.rpc,
        async status() {
          const [status, refusal] = await Promise.all([
            group.rpc.status(),
            options.coordinationRefusal(),
          ]);
          return refusal
            ? { ...status, alerts: [...new Set([...status.alerts, refusal])] }
            : status;
        },
      },
    });
    const children = new Map<number, { runtime: Runtime; unsubscribe: () => void }>();
    async function stopChildren(reason?: Parameters<LeanModePort["stop"]>[1]) {
      for (const [issue, child] of children) {
        if (!reason) child.runtime.detach();
        else await child.runtime.stop(reason);
        child.unsubscribe();
        children.delete(issue);
      }
    }

    async function reconcile() {
      if (options.pausedMachineCleanupForIssue && (await options.isOwnerPaused())) return;
      await options.refreshAuthority();
      const mode = await options.executionMode();
      if (!allowsIssueEffects(mode)) {
        if (options.pausedMachineCleanupForIssue && (await options.isOwnerPaused())) return;
        await stopChildren();
        if (mode === "dry-run") await discoverLeanIssues(options);
        return;
      }
      const discovered = await discoverLeanIssues(options);
      await options
        .cleanClosedClaims?.()
        .catch((error) =>
          deps.logger.warn(
            { err: error, projectId },
            "Factory could not finish cleaning closed issue claims",
          ),
        );
      const slots = Math.max(1, (await state.read(projectId)).local.runners);
      for (const issue of discovered) {
        if (children.has(issue)) continue;
        if (children.size >= slots) break;
        const runtime = createLeanRuntime(
          {
            ...options,
            issue,
            pausedMachineCleanup: options.pausedMachineCleanupForIssue?.(issue),
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
        if (reason === "pause" && options.pausedMachineCleanupForIssue) {
          await stopChildren("pause");
          groups.delete(projectId);
          return;
        }
        const active =
          !closing && reason !== "switch" && allowsIssueEffects(await options.executionMode());
        await stopChildren(active ? reason : undefined);
        groups.delete(projectId);
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

function activeLeanProject(record: ProjectRecord | undefined): record is ProjectRecord {
  return Boolean(record?.enabled && record.mode === "lean" && !record.paused);
}

function coordinationMode(config: Config | null): "host" | "signed-dev" | "local" {
  if (config?.machines === undefined) return "local";
  return config.runners?.placement === "host" ? "host" : "signed-dev";
}

function configuredPrimary(config: Pick<Config, "order" | "lanes"> | null): string | null {
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
  chargeMutation?: () => Promise<void>,
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
        await chargeMutation?.();
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
