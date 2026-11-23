import { randomUUID } from "node:crypto";
import { QuotaReserveAdmissionError } from "../quota-reserve/admission.js";
import { assertInstallationProviderLaunch } from "../../execution-installation/settings/provider-admission.js";
import {
  assertProjectLaunch,
  readProjectPolicy,
} from "../../execution-installation/settings/project-policies.js";
import {
  readInstallationSettingsForLaunch,
  type InstallationSettingsReader,
} from "../../execution-installation/settings/admission.js";
import { captureSkillPolicy } from "../../orchestration-skills/internal/policy.js";
import {
  profilePolicyIdentity,
  resolveProviderType,
} from "@getpaseo/protocol/provider-preferences";
import { setAgentGoalWithContext } from "../agent-goal.js";
import type { FinishSubscriptions } from "../finish-subscriptions/index.js";
import type { AgentPromptSource } from "../agent-messages/index.js";
import type { Logger } from "pino";

import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { CreatePaseoWorktreeInput } from "../../paseo-worktree-service.js";
import { expandUserPath, resolvePathFromBase } from "../../path-utils.js";
import { toWorktreeRequestError } from "../../worktree-errors.js";
import type {
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../../worktree-session.js";
import type { AgentAttachment, FirstAgentContext } from "../../messages.js";
import {
  ProfileSwitchError,
  WorkerLaunchRefusal,
  type AgentManager,
  type CreateAgentOptions,
  type ManagedAgent,
} from "../agent-manager.js";
import type {
  AgentPromptInput,
  AgentRunOptions,
  AgentSessionConfig,
  DraftSkillCatalog,
} from "../agent-sdk-types.js";
import type { AgentStorage } from "../agent-storage.js";
import type { AgentOwner } from "../agent-owner.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { startCreatedAgentInitialPrompt } from "../agent-prompt.js";
import { resolveCreateAgentTitles } from "../create-agent-title.js";
import { buildAgentPrompt } from "../prompt-attachments.js";
import { normalizeClientMessageId, resolveClientMessageId } from "../../client-message-id.js";
import { resolveRequiredProviderModel, type ResolvedProviderModel } from "../mcp-shared.js";
import { resolveCreateAgentIntent } from "./intent.js";
import { ProfileLaunchError, resolveProfileLaunch } from "./profile.js";
import { checkPresetFence } from "../lead-launch/fence.js";
import {
  LEAD_LAUNCH_ID_LABEL,
  LEAD_LAUNCH_REQUESTED_BY_LABEL,
  launchBinding,
  sameBinding,
  type ConfirmedLeadLaunch,
  type LeadLaunchBinding,
  type LeadLaunchRecord,
} from "../lead-launch/model.js";
import {
  readInstallationProfileConfig,
  type InstallationProfileReader,
} from "../../execution-installation/profiles/admission.js";
import type { AgentProfile, MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";

export interface CreateAgentCommandDependencies {
  getAgentProfiles?: () => readonly AgentProfile[];
  getSharedProviderConfig?: () => MutableDaemonConfig;
  installationProfileReader?: InstallationProfileReader;
  installationSettingsReader?: InstallationSettingsReader;
  validateSharedConfiguration?: ProviderSnapshotManager["validateAgentConfiguration"];
  finishSubscriptions?: FinishSubscriptions;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  paseoHome?: string;
  worktreesRoot?: string;
  terminalManager?: TerminalManager | null;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: EnsureWorkspaceForCreate;
  /** This daemon's server ID, so the preset fence can tell a remote parent from a missing one. */
  serverId?: string;
}

export type EnsureWorkspaceForCreate = (
  cwd: string,
  firstAgentContext?: FirstAgentContext,
  context?: { callerWorkspaceId?: string; background?: boolean },
) => Promise<string>;

export interface CreateAgentFromSessionInput {
  onCreated?: CreateAgentFromMcpInput["onCreated"];
  kind: "session";
  origin?: AgentRunOptions["origin"];
  onAgentReady?: (agent: ManagedAgent) => Promise<void>;
  agentId?: string;
  config: AgentSessionConfig;
  workspaceId: string;
  initialPrompt?: string;
  initialGoal?: import("@getpaseo/protocol/agent-goals").AgentGoalSetInput;
  source?: AgentPromptSource;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  labels: Record<string, string>;
  env?: Record<string, string>;
  provisionalTitle: string | null;
  firstAgentContext: FirstAgentContext;
}

export interface CreateAgentFromMcpInput {
  /** Placement intent for a newly created workspace; never reclassifies a selected workspace. */
  background?: boolean;
  kind: "mcp";
  profileId?: string;
  provider: string;
  title: string;
  initialPrompt?: string;
  config?: Partial<AgentSessionConfig>;
  cwd?: string;
  workspaceId?: string;
  thinking?: string;
  features?: Record<string, unknown>;
  labels?: Record<string, string>;
  mode?: string;
  unattended?: boolean;
  promptFailure?: CreateAgentPromptFailureMode;
  notifyOnFinish: boolean;
  internal?: boolean;
  detached?: boolean;
  owner?: AgentOwner;
  env?: Record<string, string>;
  onCreated?: (created: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => void | Promise<void>;
  onWorktreeCreated?: (createdWorktree: CreatePaseoWorktreeWorkflowResult) => void;
  callerAgentId?: string;
  /**
   * Set only by daemon code for an owner-confirmed lead launch (#360); no tool or wire schema
   * carries it. `prepare` resolves the binding the owner will be shown without creating anything.
   * `launch` creates the thread only if the claimed record and the fresh resolution both match.
   */
  leadLaunch?: { phase: "prepare" } | { phase: "launch"; confirmed: ConfirmedLeadLaunch };
  callerContext?: {
    lockedCwd?: string;
    allowCustomCwd?: boolean;
    childAgentDefaultLabels?: Record<string, string>;
  } | null;

  worktree?: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

export type CreateAgentCommandInput = CreateAgentFromSessionInput | CreateAgentFromMcpInput;
export type CreateAgentPromptFailureMode = "throw" | "log" | "return-error";

export interface CreateAgentCommandResult {
  snapshot: ManagedAgent;
  liveSnapshot: ManagedAgent;
  initialPromptStarted: boolean;
  initialPromptError: unknown | null;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}

export type BoundCreateAgentCommand = (
  input: CreateAgentCommandInput,
) => Promise<CreateAgentCommandResult>;

function requireResolvedWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new Error("createAgentCommand requires a resolved workspaceId");
  }
  return workspaceId;
}

export function formatProviderModel(provider: string, model: string | null | undefined): string {
  if (!model || provider.includes("/")) {
    return provider;
  }
  return `${provider}/${model}`;
}

function resolveProviderModel(providerValue: string): ResolvedProviderModel {
  const providerInput = providerValue.trim();
  if (providerInput.includes("/")) {
    return resolveRequiredProviderModel(providerInput);
  }
  if (!providerInput) {
    throw new Error("provider is required");
  }
  return { provider: providerInput, model: undefined };
}

interface ResolvedCreateAgent {
  config: AgentSessionConfig;
  createOptions: CreateAgentOptions;
  prompt?: AgentPromptInput;
  source?: AgentPromptSource;
  runOptions?: AgentRunOptions;
  promptFailure: CreateAgentPromptFailureMode;
  promptLogger?: Logger;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}

/** Resolves a profile switch target through the same admission as a new task. */
export async function resolveProfileSwitchConfig(
  dependencies: CreateAgentCommandDependencies,
  config: AgentSessionConfig,
  preservation?: {
    sourceProvider: AgentSessionConfig["provider"];
    sourceModel?: string | null;
    settings: Pick<AgentSessionConfig, "modeId" | "thinkingOptionId" | "featureValues">;
  },
): Promise<AgentSessionConfig> {
  const bindings = observeLaunchBindings(dependencies);
  dependencies = await admitProfileDependencies(bindings.dependencies, config.profileId);
  const resolved = resolveProfileLaunch(
    config,
    dependencies.getAgentProfiles?.() ?? [],
    Date.now(),
    dependencies.getSharedProviderConfig?.(),
  );
  // Profile defaults must not replace the source settings before validation or policy capture.
  if (preservation) {
    if (resolved.provider !== config.provider)
      throw new Error("The selected profile belongs to a different target account.");
    // Account moves continue the selected execution model, even when it was previously unset.
    // Keep this precedence local: ordinary creation and app switches retain profile defaults.
    resolved.model = config.model ?? resolved.model ?? preservation.sourceModel ?? undefined;
    if (!resolved.model) {
      throw new ProfileSwitchError(
        "Cannot establish the source model. Load the source thread to record its runtime model, or select an explicit model or a profile with a model before switching accounts.",
        "incompatible-target",
      );
    }
    Object.assign(resolved, structuredClone(preservation.settings));
    await dependencies.agentManager.validateProfileSwitchSettings(
      preservation.sourceProvider,
      preservation.settings,
      resolved,
    );
  }
  const created = await dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: resolved.cwd,
    provider: resolved.provider,
    requestedMode: resolved.modeId,
    featureValues: resolved.featureValues,
    parent: null,
    unattended: false,
  });
  const sessionConfig: AgentSessionConfig = {
    ...resolved,
    modeId: created.modeId,
    featureValues: created.featureValues,
  };
  await validateSharedLaunch(dependencies, sessionConfig);
  await captureLaunchPolicy(dependencies, sessionConfig, { requestedProfileId: config.profileId });
  bindings.assertCurrent();
  return sessionConfig;
}

async function validateSharedLaunch(
  dependencies: CreateAgentCommandDependencies,
  config: AgentSessionConfig,
): Promise<void> {
  if (config.profileLaunch?.configurationRevision === undefined) return;
  if (!dependencies.validateSharedConfiguration)
    throw new Error("Shared configuration validation is unavailable.");
  const issues = await dependencies.validateSharedConfiguration(config);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join(" "));
}

async function admitProfileDependencies(
  dependencies: CreateAgentCommandDependencies,
  profileId: string | undefined,
): Promise<CreateAgentCommandDependencies> {
  if (profileId && dependencies.getSharedProviderConfig) {
    const settings = await readInstallationProfileConfig(
      dependencies.getSharedProviderConfig(),
      dependencies.installationProfileReader,
    );
    dependencies = { ...dependencies, getSharedProviderConfig: () => settings };
  }
  return dependencies;
}

function observeLaunchBindings(dependencies: CreateAgentCommandDependencies) {
  const readLocalConfig = dependencies.getSharedProviderConfig;
  let admittedLocalConfig: MutableDaemonConfig | undefined;
  if (readLocalConfig) {
    dependencies = {
      ...dependencies,
      getSharedProviderConfig: () => {
        const current = readLocalConfig();
        admittedLocalConfig ??= current;
        return current;
      },
    };
  }
  return {
    dependencies,
    assertCurrent() {
      if (
        admittedLocalConfig?.sharedProviderPreferences?.installation &&
        readLocalConfig?.() !== admittedLocalConfig
      ) {
        throw new Error(
          "Local account or settings bindings changed during launch. Retry with the current configuration.",
        );
      }
    },
  };
}

export async function createAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
): Promise<CreateAgentCommandResult> {
  const admitted = await admitAndCreateAgent(dependencies, input).catch((error: unknown) => {
    logRefusedWorkerLaunch(dependencies, input, error);
    throw error;
  });
  const { resolved, snapshot } = admitted;
  dependencies = admitted.dependencies;
  await input.onCreated?.({
    agentId: snapshot.id,
    createdWorktree: resolved.createdWorktree ?? null,
  });

  if (input.kind === "mcp") resolved.createdWorktree?.startSetup?.();

  if (input.kind === "session") await input.onAgentReady?.(snapshot);

  let liveSnapshot = snapshot;
  let initialPromptStarted = false;
  let initialPromptError: unknown | null = null;
  const notificationRequest = initialPromptNotificationRequest(input, resolved, snapshot);
  const notification = notificationRequest
    ? await requireFinishSubscriptions(dependencies).register(notificationRequest, true)
    : undefined;

  if (input.kind === "session" && input.initialGoal) {
    liveSnapshot = await startInitialGoal(dependencies, input, resolved, snapshot);
    initialPromptStarted = true;
  } else if (resolved.prompt !== undefined) {
    const sendResult = await sendInitialPrompt(dependencies, resolved, snapshot).catch(
      async (error) => {
        await notification?.reject();
        throw error;
      },
    );
    notification?.accept();
    initialPromptStarted = sendResult.started;
    liveSnapshot = sendResult.liveSnapshot;
    initialPromptError = sendResult.error ?? null;
  }

  return {
    snapshot,
    liveSnapshot,
    initialPromptStarted,
    initialPromptError,
    ...(resolved.createdWorktree ? { createdWorktree: resolved.createdWorktree } : {}),
  };
}

/** Everything that can refuse a launch: admission, preset resolution, policy and registration. */
async function admitAndCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
) {
  if (input.kind === "mcp" && input.leadLaunch?.phase === "prepare")
    throw new Error("A lead launch preview never creates a thread.");
  await fenceInheritedWorkerLaunch(dependencies, input);
  const admitted = await admitAgent(dependencies, input);
  if (input.kind === "mcp" && input.leadLaunch?.phase === "launch") {
    await assertConfirmedLeadLaunch(
      admitted.dependencies,
      input,
      input.leadLaunch.confirmed,
      admitted.resolved,
    );
  }
  const { resolved } = admitted;
  dependencies = admitted.dependencies;
  const snapshot = await dependencies.agentManager.createAgent(
    resolved.config,
    input.kind === "session" ? input.agentId : undefined,
    resolved.createOptions,
  );
  return { dependencies, resolved, snapshot };
}

/** The input both the preview and the launch of a confirmed lead resolve, so their bindings agree. */
export function leadLaunchCreateInput(params: {
  callerAgentId: string;
  launchId: string;
  profileId: string;
  provider: string;
  title: string;
  initialPrompt: string;
  cwd: string;
  workspaceId: string;
  leadLaunch: NonNullable<CreateAgentFromMcpInput["leadLaunch"]>;
}): CreateAgentFromMcpInput {
  return {
    kind: "mcp",
    profileId: params.profileId,
    provider: params.provider,
    title: params.title,
    initialPrompt: params.initialPrompt,
    cwd: params.cwd,
    workspaceId: params.workspaceId,
    // A lead is a peer, not the coordinator's worker. The labels keep its provenance.
    detached: true,
    labels: {
      [LEAD_LAUNCH_REQUESTED_BY_LABEL]: params.callerAgentId,
      [LEAD_LAUNCH_ID_LABEL]: params.launchId,
    },
    notifyOnFinish: false,
    promptFailure: "log",
    callerAgentId: params.callerAgentId,
    leadLaunch: params.leadLaunch,
  };
}

/** Starts a launch the owner confirmed. The create path re-checks the record and binding. */
export async function startConfirmedLeadLaunch(
  dependencies: CreateAgentCommandDependencies,
  confirmed: ConfirmedLeadLaunch,
  record: LeadLaunchRecord,
): Promise<{ agentId: string }> {
  const { binding } = confirmed.option;
  const created = await createAgentCommand(
    dependencies,
    leadLaunchCreateInput({
      callerAgentId: confirmed.callerAgentId,
      launchId: confirmed.launchId,
      profileId: confirmed.option.profileId,
      provider: binding.provider,
      title: record.title,
      initialPrompt: record.initialPrompt,
      cwd: binding.cwd,
      workspaceId: binding.workspaceId,
      leadLaunch: { phase: "launch", confirmed },
    }),
  );
  return { agentId: created.snapshot.id };
}

/**
 * Resolves and admits a lead launch exactly as the confirmed launch will, and returns its binding
 * without creating a thread or workspace. Refusals surface now, before the owner is asked.
 */
export async function prepareLeadLaunch(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
): Promise<LeadLaunchBinding> {
  if (input.leadLaunch?.phase !== "prepare" || !input.workspaceId || input.worktree)
    throw new Error("A lead launch preview needs an existing workspace and no new worktree.");
  const { resolved } = await admitAgent(dependencies, input);
  return resolvedBinding(input, resolved);
}

function resolvedBinding(input: CreateAgentFromMcpInput, resolved: ResolvedCreateAgent) {
  return launchBinding({
    config: resolved.config,
    workspaceId: requireResolvedWorkspaceId(resolved.createOptions.workspaceId),
    prompt: input.initialPrompt ?? "",
  });
}

/**
 * The gate for a confirmed launch, checked on the create path itself: the stored record must be
 * claimed for this exact option by the owner's answer, and the launch must resolve to the same
 * binding the owner saw. A preset, account or setting that changed since then refuses the launch.
 */
async function assertConfirmedLeadLaunch(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
  confirmed: ConfirmedLeadLaunch,
  resolved: ResolvedCreateAgent,
): Promise<void> {
  if (input.callerAgentId !== confirmed.callerAgentId)
    throw new WorkerLaunchRefusal("The confirmed launch belongs to another thread.", "lead-caller");
  const record = await dependencies.agentManager.readLeadLaunch(
    confirmed.callerAgentId,
    confirmed.launchId,
  );
  const stored = record?.options.find((option) => option.optionId === confirmed.option.optionId);
  if (
    !record ||
    record.status !== "starting" ||
    record.chosenOptionId !== confirmed.option.optionId ||
    !record.approvedBy ||
    !stored ||
    !sameBinding(stored.binding, confirmed.option.binding)
  )
    throw new WorkerLaunchRefusal(
      "This launch has not been confirmed by the owner.",
      "lead-unconfirmed",
    );
  if (!sameBinding(resolvedBinding(input, resolved), stored.binding))
    throw new WorkerLaunchRefusal(
      "The preset or its settings changed after the owner confirmed this launch, so nothing was started. Ask again with request_lead_launch.",
      "lead-binding-changed",
    );
}

/**
 * A caller beneath a supervisor with a worker preset has no worker preset of its own, so the
 * refusal in resolveMcpProfileInput does not reach it. The preset fence reports it instead
 * (#360, log-only until slice C). The supervisor's own launches are refused there and skipped here.
 */
async function fenceInheritedWorkerLaunch(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
): Promise<void> {
  if (input.kind !== "mcp" || !input.callerAgentId || input.leadLaunch) return;
  if (dependencies.agentManager.getAgent(input.callerAgentId)?.config.profileLaunch?.worker) return;
  await checkPresetFence(
    {
      logger: dependencies.logger,
      getAgent: (id) => dependencies.agentManager.getAgent(id),
      getStored: (id) => dependencies.agentStorage.get(id),
      serverId: dependencies.serverId,
    },
    "create_agent",
    input.callerAgentId,
    { kind: "launch", profileId: input.profileId ?? null, detached: input.detached ?? false },
  );
}

/** Admission, preset resolution and policy, without registering the agent. */
async function admitAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
) {
  const bindings = observeLaunchBindings(dependencies);
  dependencies = await admitProfileDependencies(
    bindings.dependencies,
    input.kind === "session" ? input.config.profileId : input.profileId,
  );
  const resolved =
    input.kind === "session"
      ? await resolveSessionCreateAgent(dependencies, input)
      : await resolveMcpCreateAgent(dependencies, input);

  await validateSharedLaunch(dependencies, resolved.config);
  await captureLaunchPolicy(dependencies, resolved.config, {
    requestedProfileId: input.kind === "session" ? input.config.profileId : input.profileId,
  });

  if (resolved.config.quotaReserve) {
    await dependencies.agentManager.checkQuotaReserveLaunch(resolved.config);
  }

  bindings.assertCurrent();
  return { dependencies, resolved };
}

const LOG_STRING_LIMIT = 200;

function boundLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, LOG_STRING_LIMIT);
  if (value === null || typeof value !== "object") return value;
  if (depth > 1) return "[omitted]";
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, boundLogValue(entry, depth + 1)]),
  );
}

/**
 * Records a refusal without ever replacing it: strings are cut to a fixed length and a failing
 * logger is ignored. Callers pass codes, never error messages, which can carry paths or URLs.
 */
export function logRefusal(logger: Logger, message: string, fields: Record<string, unknown>): void {
  try {
    logger.warn(boundLogValue(fields), message);
  } catch {
    // The caller's own error matters more than this record.
  }
}

/** A refusal's loggable code; null for any other failure. */
function workerRefusalCode(error: unknown): string | null {
  if (error instanceof WorkerLaunchRefusal || error instanceof ProfileLaunchError) {
    return error.code;
  }
  return null;
}

/** A supervisor only sees the refusal text; the log keeps who asked for what. */
function logRefusedWorkerLaunch(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
  error: unknown,
): void {
  const code = workerRefusalCode(error);
  // Other failures, such as a provider that will not start, are reported where they occur.
  if (!code || input.kind !== "mcp" || !input.callerAgentId) return;
  try {
    const caller = dependencies.agentManager.getAgent(input.callerAgentId);
    const worker = caller?.config.profileLaunch?.worker;
    if (!caller || !worker) return;
    logRefusal(dependencies.logger, "Managed worker launch refused", {
      callerAgentId: caller.id,
      callerProvider: caller.provider,
      requestedProvider: input.provider,
      requestedProfileId: input.profileId ?? null,
      workerProfileId: worker.id,
      workerProvider: worker.provider,
      refusalCode: code,
    });
  } catch {
    // Never let the record replace the refusal.
  }
}

function initialPromptNotificationRequest(
  input: CreateAgentCommandInput,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
) {
  return input.kind === "mcp" &&
    input.notifyOnFinish &&
    input.callerAgentId &&
    resolved.prompt !== undefined
    ? {
        childAgentId: snapshot.id,
        callerAgentId: input.callerAgentId,
        requireParentOwnership: !(input.detached ?? false),
      }
    : undefined;
}

async function startInitialGoal(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
): Promise<ManagedAgent> {
  const initialGoal = input.initialGoal;
  if (!initialGoal) return snapshot;
  const hasAttachments = (input.images?.length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0;
  await setAgentGoalWithContext({
    manager: dependencies.agentManager,
    agentId: snapshot.id,
    goal: initialGoal,
    clientMessageId: input.clientMessageId,
    sendContext: hasAttachments
      ? async () => {
          const sent = await sendInitialPrompt(
            dependencies,
            { ...resolved, runOptions: { ...resolved.runOptions, intent: "goal" } },
            snapshot,
          );
          if (sent.error || !sent.started)
            throw sent.error ?? new Error("Goal context was not accepted");
        }
      : undefined,
  });
  return dependencies.agentManager.getAgent(snapshot.id) ?? snapshot;
}

async function resolveSessionCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
): Promise<ResolvedCreateAgent> {
  const trimmedPrompt = (input.initialGoal?.objective ?? input.initialPrompt)?.trim();
  if (input.initialGoal && !input.initialGoal.objective?.trim())
    throw new Error("A new goal requires an objective");
  const builtSessionConfig = resolveProfileLaunch(
    input.config,
    dependencies.getAgentProfiles?.() ?? [],
    Date.now(),
    dependencies.getSharedProviderConfig?.(),
  );
  const resolvedCreateConfig = await dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: builtSessionConfig.cwd,
    provider: builtSessionConfig.provider,
    requestedMode: builtSessionConfig.modeId,
    featureValues: builtSessionConfig.featureValues,
    parent: null,
    unattended: false,
  });
  const sessionConfig: AgentSessionConfig = {
    ...builtSessionConfig,
    modeId: resolvedCreateConfig.modeId,
    featureValues: resolvedCreateConfig.featureValues,
  };
  const prompt = buildAgentPrompt(trimmedPrompt ?? "", input.images, input.attachments);
  const hasPromptContent = Array.isArray(prompt) ? prompt.length > 0 : prompt.length > 0;
  const clientMessageId = input.origin
    ? resolveClientMessageId(input.clientMessageId)
    : normalizeClientMessageId(input.clientMessageId);
  const runOptions: AgentRunOptions | undefined =
    input.outputSchema || clientMessageId
      ? { outputSchema: input.outputSchema, clientMessageId, origin: input.origin }
      : undefined;
  const workspaceId = input.workspaceId;

  return {
    config: sessionConfig,
    createOptions: {
      labels: input.labels,
      initialPrompt: trimmedPrompt,
      env: input.env,
      initialTitle: input.provisionalTitle,
      // Paseo never persists an internal agent, so nothing could resume its
      // provider session either. Same as the daemon's own ephemeral helpers.
      ...(sessionConfig.internal ? { persistSession: false } : {}),
      workspaceId: requireResolvedWorkspaceId(workspaceId),
    },
    prompt: hasPromptContent ? prompt : undefined,
    source: input.source,
    runOptions,
    // Registration commits creation. First-turn failures belong to the created agent.
    promptFailure: "return-error",
    promptLogger: dependencies.logger.child({
      clientMessageId: resolveClientMessageId(input.clientMessageId),
    }),
  };
}

function inheritWorkerRevision(config: AgentSessionConfig, caller: ManagedAgent | null): void {
  if (config.profileLaunch) {
    config.profileLaunch.configurationRevision =
      caller?.config.profileLaunch?.configurationRevision;
  }
}

interface McpProfileSelection {
  dependencies: CreateAgentCommandDependencies;
  input: CreateAgentFromMcpInput;
  worker: AgentProfile | undefined;
  caller: ManagedAgent | null;
}

/**
 * The account in a frozen worker preset is a default. A launch may instead ask for the account
 * the supervisor currently runs on, when both have one provider type, and runs the same preset
 * there; whether the supervisor ever moved is not checked. Any other account keeps the preset's
 * own, so the caller's request is refused by the checks that follow.
 */
function workerOnSupervisorAccount(
  worker: AgentProfile,
  caller: ManagedAgent | null,
  input: CreateAgentFromMcpInput,
  settings: MutableDaemonConfig | undefined,
): AgentProfile {
  const current = caller?.provider;
  const providers = settings?.providers;
  if (!current || !providers || current === worker.provider) return worker;
  if (resolveProviderModel(input.provider).provider !== current) return worker;
  if (resolveProviderType(current, providers) !== resolveProviderType(worker.provider, providers)) {
    return worker;
  }
  return { ...worker, provider: current };
}

function resolveMcpProfileSelection({
  dependencies,
  input,
  worker: frozen,
  caller,
}: McpProfileSelection): AgentSessionConfig {
  const settings = dependencies.getSharedProviderConfig?.();
  const worker = frozen && workerOnSupervisorAccount(frozen, caller, input, settings);
  if (frozen && worker && settings?.sharedProviderPreferences?.installation) {
    // Frozen workers keep their values, but every new dispatch checks current exclusions.
    // Canonical presets check the account in use; older references stay bound to their account.
    const account = worker.id.startsWith("shared-profile/") ? worker.provider : frozen.provider;
    resolveProfileLaunch(
      { provider: account, cwd: input.cwd ?? "", profileId: worker.id },
      [],
      Date.now(),
      settings,
    );
  }
  const profiles = worker ? [worker] : (dependencies.getAgentProfiles?.() ?? []);
  const resolved = resolveProfileLaunch(
    {
      ...input.config,
      provider: resolveProviderModel(input.provider).provider,
      cwd: input.cwd ?? "",
      profileId: input.profileId,
    },
    profiles,
    Date.now(),
    worker ? undefined : dependencies.getSharedProviderConfig?.(),
    settings?.sharedProviderPreferences?.installation?.environment,
  );
  if (worker) inheritWorkerRevision(resolved, caller);
  return resolved;
}

function resolveMcpProfileInput(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
): CreateAgentFromMcpInput {
  const caller = input.callerAgentId
    ? requireParentAgent(dependencies.agentManager, input.callerAgentId)
    : null;
  // An owner-confirmed lead is checked against its stored record instead; see
  // assertConfirmedLeadLaunch. It resolves against every preset, not only the worker's.
  const confirmedLead = Boolean(caller && input.leadLaunch);
  const worker = confirmedLead ? undefined : caller?.config.profileLaunch?.worker;
  if (worker && input.profileId !== worker.id) {
    throw new WorkerLaunchRefusal(
      `This supervisor must launch its configured worker preset: ${worker.id}. To start a lead thread on another preset, use request_lead_launch; the owner confirms it.`,
      "preset-required",
    );
  }
  if (confirmedLead && !input.profileId)
    throw new WorkerLaunchRefusal("A lead launch needs a preset.", "lead-preset-required");
  if (worker && input.detached)
    throw new WorkerLaunchRefusal(
      "Managed workers cannot be detached from their supervisor.",
      "detached",
    );
  if (input.profileId) {
    const resolved = resolveMcpProfileSelection({ dependencies, input, worker, caller });
    if (!resolved.model) throw new Error("MCP launches require a preset with an explicit model.");
    if (resolveProviderModel(input.provider).provider !== resolved.provider) {
      throw new WorkerLaunchRefusal(
        "The requested provider must match the preset provider.",
        "provider-mismatch",
      );
    }
    input = {
      ...input,
      provider: `${resolved.provider}/${resolved.model}`,
      config: resolved,
      thinking: resolved.thinkingOptionId,
      features: resolved.featureValues,
    };
  }
  return input;
}

async function resolveMcpCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  requestedInput: CreateAgentFromMcpInput,
): Promise<ResolvedCreateAgent> {
  const input = resolveMcpProfileInput(dependencies, requestedInput);
  const resolvedProviderModel = resolveProviderModel(input.provider);
  const provider = resolvedProviderModel.provider;
  const parentAgent = input.callerAgentId
    ? requireParentAgent(dependencies.agentManager, input.callerAgentId)
    : null;
  const cwd = resolveMcpInitialCwd(input, parentAgent);
  const { resolvedCwd, createdWorkspaceId, createdWorktree } = await resolveMcpCwd({
    dependencies,
    cwd,
    worktree: input.worktree,
    background: input.background,
    initialPrompt: input.initialPrompt ?? "",
    callerWorkspaceId: parentAgent?.workspaceId,
  });
  if (createdWorktree) input.onWorktreeCreated?.(createdWorktree);
  const intent = await resolveCreateAgentIntent({
    explicitWorkspaceId: createdWorkspaceId ?? input.workspaceId,
    caller: parentAgent
      ? { id: parentAgent.id, cwd: parentAgent.cwd, workspaceId: parentAgent.workspaceId }
      : null,
    labels: input.labels,
    childAgentDefaultLabels: input.callerContext?.childAgentDefaultLabels,
    legacyDetached: input.detached ?? false,
    resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: resolvedCwd }),
    createWorkspace: async () => ({
      workspaceId: requireResolvedWorkspaceId(
        await ensureWorkspaceForMcpCreate(
          dependencies,
          resolvedCwd,
          input.initialPrompt ?? "",
          parentAgent?.workspaceId,
          input.background,
        ),
      ),
      cwd: resolvedCwd,
    }),
  });
  const resolvedCreateConfig = await resolveMcpProviderCreateConfig({
    dependencies,
    input,
    provider,
    resolvedCwd,
    parentAgent,
  });

  const trimmedPrompt = input.initialPrompt?.trim() ?? "";
  return {
    config: buildMcpSessionConfig({
      input,
      resolvedProviderModel,
      provider,
      resolvedCwd: intent.cwd,
      trimmedPrompt,
      resolvedMode: resolvedCreateConfig.modeId,
      resolvedFeatures: resolvedCreateConfig.featureValues,
    }),
    createOptions: {
      ...(Object.keys(intent.labels).length > 0 ? { labels: intent.labels } : {}),
      workspaceId: intent.workspaceId,
      owner: input.owner,
      env: input.env,
    },
    prompt: trimmedPrompt ? trimmedPrompt : undefined,
    // MCP provenance does not depend on having a parent agent.
    runOptions: { origin: "agent", clientMessageId: randomUUID() },
    source: input.callerAgentId
      ? { kind: "agent-message", agentId: input.callerAgentId }
      : undefined,
    createdWorktree,
    promptFailure: input.promptFailure ?? "log",
  };
}

function resolveMcpInitialCwd(
  input: CreateAgentFromMcpInput,
  parentAgent: ManagedAgent | null,
): string {
  if (!parentAgent) {
    return expandUserPath(input.cwd ?? process.cwd());
  }
  return resolveChildAgentCwd({
    parentCwd: parentAgent.cwd,
    requestedCwd: input.cwd,
    lockedCwd: input.callerContext?.lockedCwd,
    allowCustomCwd: input.callerContext?.allowCustomCwd ?? true,
  });
}

async function resolveMcpProviderCreateConfig(params: {
  dependencies: CreateAgentCommandDependencies;
  input: CreateAgentFromMcpInput;
  provider: string;
  resolvedCwd: string;
  parentAgent: ManagedAgent | null;
}): Promise<{ modeId?: string; featureValues?: Record<string, unknown> }> {
  const passthroughConfig = params.input.config;
  return params.dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: params.resolvedCwd,
    provider: params.provider,
    requestedMode: params.input.mode ?? passthroughConfig?.modeId,
    featureValues: params.input.features ?? passthroughConfig?.featureValues,
    parent: params.parentAgent,
    unattended: params.input.unattended ?? false,
  });
}

function buildMcpSessionConfig(params: {
  input: CreateAgentFromMcpInput;
  resolvedProviderModel: ResolvedProviderModel;
  provider: string;
  resolvedCwd: string;
  trimmedPrompt: string;
  resolvedMode?: string;
  resolvedFeatures?: Record<string, unknown>;
}): AgentSessionConfig {
  const passthroughConfig = params.input.config;
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: passthroughConfig?.title ?? params.input.title,
    initialPrompt: params.trimmedPrompt,
  });
  const featureValues = params.resolvedFeatures ?? passthroughConfig?.featureValues;
  const config: AgentSessionConfig = {
    ...passthroughConfig,
    provider: params.provider,
    cwd: params.resolvedCwd,
    modeId: params.resolvedMode ?? passthroughConfig?.modeId,
    model: params.resolvedProviderModel.model ?? passthroughConfig?.model,
    thinkingOptionId: params.input.thinking ?? passthroughConfig?.thinkingOptionId,
    internal: params.input.internal ?? passthroughConfig?.internal,
  };
  if (provisionalTitle) {
    config.title = provisionalTitle;
  }
  if (featureValues) {
    config.featureValues = featureValues;
  }
  return config;
}

async function ensureWorkspaceForMcpCreate(
  dependencies: CreateAgentCommandDependencies,
  cwd: string,
  initialPrompt: string,
  callerWorkspaceId?: string,
  background?: boolean,
): Promise<string | undefined> {
  if (!dependencies.ensureWorkspaceForCreate) {
    return undefined;
  }
  return dependencies.ensureWorkspaceForCreate(
    cwd,
    { prompt: initialPrompt },
    { callerWorkspaceId, ...(background !== undefined ? { background } : {}) },
  );
}

async function sendInitialPrompt(
  dependencies: CreateAgentCommandDependencies,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
): Promise<{ started: boolean; liveSnapshot: ManagedAgent; error?: unknown }> {
  try {
    const prompt = resolved.prompt;
    if (prompt === undefined) {
      return { started: false, liveSnapshot: snapshot };
    }
    if (resolved.config.quotaReserve) {
      await dependencies.agentManager.prepareQuotaReserveAdmission(snapshot.id);
    }
    const liveSnapshot = await startCreatedAgentInitialPrompt({
      agentStorage: dependencies.agentStorage,
      agentManager: dependencies.agentManager,
      agentId: snapshot.id,
      snapshot,
      prompt,
      source: resolved.source,
      runOptions: resolved.runOptions,
      logger: resolved.promptLogger ?? dependencies.logger,
    });
    return { started: true, liveSnapshot };
  } catch (error) {
    if (resolved.promptFailure === "throw") {
      throw error;
    }
    if (resolved.promptFailure === "return-error") {
      // Admission refusal must reach the caller's creation cleanup.
      if (error instanceof QuotaReserveAdmissionError) throw error;
      return {
        started: false,
        liveSnapshot: dependencies.agentManager.getAgent(snapshot.id) ?? snapshot,
        error,
      };
    }
    dependencies.logger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
    return { started: false, liveSnapshot: snapshot };
  }
}

function requireParentAgent(agentManager: AgentManager, parentAgentId: string): ManagedAgent {
  const parentAgent = agentManager.getAgent(parentAgentId);
  if (!parentAgent) {
    throw new Error(`Parent agent ${parentAgentId} not found`);
  }
  return parentAgent;
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

interface CreateMcpWorktreeOptions {
  input: CreatePaseoWorktreeInput;
  createPaseoWorktree: CreatePaseoWorktreeWorkflowFn | undefined;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
}

async function createMcpWorktree(
  options: CreateMcpWorktreeOptions,
): Promise<CreatePaseoWorktreeWorkflowResult> {
  try {
    if (!options.createPaseoWorktree) {
      throw new Error("Vorteo worktree service is not configured");
    }
    return await options.createPaseoWorktree(options.input, {
      deferSetup: true,
      ...(options.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
    });
  } catch (error) {
    throw toWorktreeRequestError(error);
  }
}

async function resolveMcpCwd(params: {
  dependencies: CreateAgentCommandDependencies;
  cwd: string;
  initialPrompt: string;
  callerWorkspaceId?: string;
  worktree: CreateAgentFromMcpInput["worktree"];
  background?: boolean;
}): Promise<{
  resolvedCwd: string;
  createdWorkspaceId?: string;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}> {
  const { dependencies, worktree } = params;
  if (!worktree) {
    return { resolvedCwd: params.cwd };
  }
  const shouldCreateWorktree = Boolean(
    worktree.worktreeName || worktree.refName || worktree.action || worktree.githubPrNumber,
  );
  if (!shouldCreateWorktree) {
    return { resolvedCwd: params.cwd };
  }
  if (
    worktree.worktreeName &&
    !worktree.baseBranch &&
    !worktree.refName &&
    !worktree.action &&
    worktree.githubPrNumber === undefined
  ) {
    throw new Error("baseBranch is required when creating a worktree");
  }
  const baseBranch = worktree.baseBranch;
  const createdWorktree = await createMcpWorktree({
    input: {
      cwd: params.cwd,
      callerWorkspaceId: params.callerWorkspaceId,
      background: params.background,
      worktreeSlug: worktree.worktreeName,
      branchName: worktree.branchName,
      refName: worktree.refName,
      action: worktree.action,
      githubPrNumber: worktree.githubPrNumber,
      firstAgentContext: { prompt: params.initialPrompt },

      paseoHome: dependencies.paseoHome,
      worktreesRoot: dependencies.worktreesRoot,
    },
    createPaseoWorktree: dependencies.createPaseoWorktree,
    resolveDefaultBranch: baseBranch ? async () => baseBranch : undefined,
  });
  return {
    resolvedCwd: createdWorktree.workspace.cwd,
    createdWorkspaceId: createdWorktree.workspace.workspaceId,
    createdWorktree,
  };
}

function requireFinishSubscriptions(
  dependencies: CreateAgentCommandDependencies,
): FinishSubscriptions {
  if (!dependencies.finishSubscriptions) throw new Error("Finish subscriptions are not configured");
  return dependencies.finishSubscriptions;
}

async function captureLaunchPolicy(
  dependencies: CreateAgentCommandDependencies,
  config: AgentSessionConfig,
  request: { requestedProfileId: string | undefined },
): Promise<void> {
  const settings = dependencies.getSharedProviderConfig?.();
  const provider = resolveProviderType(config.provider, settings?.providers ?? {});
  const authority = settings
    ? await readInstallationSettingsForLaunch(settings, dependencies.installationSettingsReader)
    : null;
  if (authority && settings) assertInstallationProviderLaunch(settings, config.provider, authority);
  const projectPolicy = authority ? await readProjectPolicy(authority, config.cwd) : null;
  if (authority && projectPolicy) {
    const profile = config.profileLaunch;
    const profileIds = [request.requestedProfileId, profile?.profile.id]
      .filter((id): id is string => Boolean(id))
      .map(profilePolicyIdentity);
    if (profile?.workflowId) profileIds.push(`workflow/${profile.workflowId}`);
    assertProjectLaunch({
      policy: projectPolicy,
      admission: authority,
      providerId: config.provider,
      profileIds,
    });
  }
  const installation = authority
    ? {
        definitions: authority.settings.skillLibrary ?? [],
        // Project exclusions add to the environment's.
        excludedIdentities: [
          ...(authority.settings.resourceExclusions[authority.serverId]?.skillIdentities ?? []),
          ...(projectPolicy?.skillIdentities ?? []),
        ],
      }
    : undefined;
  let catalog: Promise<DraftSkillCatalog> | undefined;
  const readCatalog = () =>
    (catalog ??= dependencies.agentManager.listDraftSkillCatalog({
      ...config,
      profileLaunch: undefined,
      skillSnapshot: undefined,
    }));
  await captureSkillPolicy(config, provider, {
    installation,
    codexHome: launchCodexHome(provider, settings, config.provider),
    nativeDefaults: async () => (await readCatalog()).skills,
    providerBuiltins: async () => (await readCatalog()).builtinSkills,
  });
}

/**
 * The CODEX_HOME a Codex session's app-server inherits. The provider registry merges each
 * provider's env over the one it extends, so the nearest CODEX_HOME along that chain wins,
 * then the daemon's own. Account sessions list skills from that folder, so the skill
 * snapshot must read the same one. Codex treats an explicit empty value as its default
 * ~/.codex, so it stops inheritance too; undefined selects that default in the inventory.
 */
export function launchCodexHome(
  provider: string,
  settings: Pick<MutableDaemonConfig, "providers"> | undefined,
  providerId: string,
  daemonEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (provider !== "codex") return undefined;
  const visited = new Set<string>();
  for (let current: string | undefined = providerId; current && !visited.has(current); ) {
    visited.add(current);
    const parsed = ProviderOverrideSchema.safeParse(settings?.providers?.[current]);
    if (!parsed.success) break;
    const home = parsed.data.env?.CODEX_HOME;
    if (home !== undefined) return home || undefined;
    current = parsed.data.extends;
  }
  return daemonEnv.CODEX_HOME || undefined;
}
