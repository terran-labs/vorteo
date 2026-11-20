import type {
  AgentProfileSwitchRequestMessage,
  AgentProfileSwitchResult,
  MutableDaemonConfig,
} from "@getpaseo/protocol/messages";
import { ProfileSwitchError, type AgentProfileSwitchInput } from "../agent-manager.js";
import type { AgentSessionConfig, AgentRuntimeInfo } from "../agent-sdk-types.js";
import { buildConfigOverrides } from "../../persistence-hooks.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  logRefusal,
  resolveProfileSwitchConfig,
  type CreateAgentCommandDependencies,
} from "../create-agent/create.js";
import { ProfileLaunchError } from "../create-agent/profile.js";
import { formatSwitchInstructions } from "./context.js";
import type { StoredAgentRecord } from "../agent-storage.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";
import { randomUUID } from "node:crypto";

export interface ProfileSwitchBatchSelection {
  sourceProvider: string;
  workspaceId?: string;
  projectId?: string;
}

interface ProfileSwitchCandidatesInput {
  agents: Pick<StoredAgentRecord, "id" | "provider" | "workspaceId">[];
  workspaces: Pick<PersistedWorkspaceRecord, "workspaceId" | "projectId">[];
  selection: ProfileSwitchBatchSelection;
}

export function selectProfileSwitchCandidates(input: ProfileSwitchCandidatesInput): string[] {
  const { agents, workspaces, selection } = input;
  if (
    !selection.sourceProvider.trim() ||
    Boolean(selection.workspaceId) === Boolean(selection.projectId)
  ) {
    throw new ProfileSwitchError(
      "Select exactly one workspace or project and a source account.",
      "invalid-selection",
    );
  }
  const selectedWorkspaces = workspaces.filter((workspace) =>
    selection.workspaceId
      ? workspace.workspaceId === selection.workspaceId
      : workspace.projectId === selection.projectId,
  );
  const workspaceIds = new Set(selectedWorkspaces.map((workspace) => workspace.workspaceId));
  return agents
    .filter(
      (agent) =>
        agent.provider === selection.sourceProvider &&
        agent.workspaceId !== undefined &&
        workspaceIds.has(agent.workspaceId),
    )
    .map((agent) => agent.id);
}

export type ProfileSwitchTarget = Pick<
  AgentProfileSwitchRequestMessage,
  | "agentId"
  | "provider"
  | "profileId"
  | "model"
  | "thinkingOptionId"
  | "reason"
  | "dryRun"
  | "explanation"
>;

function describeAccount(
  settings: MutableDaemonConfig | undefined,
  provider: string,
  model: string | null | undefined,
): string {
  const label = settings?.providers?.[provider]?.label;
  const account = typeof label === "string" && label ? label : provider;
  return model ? `${account} (${model})` : account;
}

type ProfileSwitchDependencies = CreateAgentCommandDependencies & {
  providerSnapshotManager: Pick<
    ProviderSnapshotManager,
    "resolveCreateConfig" | "readSessionHistory"
  >;
};

interface ProfileSwitchOptions {
  /** Instructions retained ahead of the carried context, such as a daemon role charter. */
  standingInstructions?: string;
  actor?: { kind: "agent" | "principal"; id: string; label?: string };
  includeResult?: boolean;
  validateScope?: AgentProfileSwitchInput["validateScope"];
}

export function switchAgentProfileCommand(
  dependencies: ProfileSwitchDependencies,
  target: ProfileSwitchTarget,
  options: ProfileSwitchOptions & { includeResult: true },
): Promise<AgentProfileSwitchResult>;
export function switchAgentProfileCommand(
  dependencies: ProfileSwitchDependencies,
  target: ProfileSwitchTarget,
  options?: ProfileSwitchOptions & { includeResult?: false },
): Promise<void>;
export function switchAgentProfileCommand(
  dependencies: ProfileSwitchDependencies,
  target: ProfileSwitchTarget,
  options: ProfileSwitchOptions,
): Promise<AgentProfileSwitchResult | void>;
export async function switchAgentProfileCommand(
  dependencies: ProfileSwitchDependencies,
  target: ProfileSwitchTarget,
  options?: ProfileSwitchOptions,
): Promise<AgentProfileSwitchResult | void> {
  let refusal: AgentProfileSwitchResult = { agentId: target.agentId, outcome: "refused" };
  let eligibleDryRun = false;
  try {
    const result = await executeSwitchCommand(dependencies, target, options, (source) => {
      refusal = source;
    });
    if (options?.includeResult) return result;
    // Callers without structured results must not mistake an eligible dry run for a switch.
    if (target.dryRun) {
      eligibleDryRun = true;
      throw new ProfileSwitchError(result.error ?? DRY_RUN_TARGET_UNCHECKED);
    }
    return undefined;
  } catch (error) {
    if (eligibleDryRun) throw error;
    const failure = {
      error: error instanceof Error ? error.message : String(error),
      refusalCode: profileSwitchRefusalCode(error),
    };
    logRefusal(dependencies.logger, "Profile switch refused", {
      agentId: target.agentId,
      actor: options?.actor ? { kind: options.actor.kind, id: options.actor.id } : null,
      sourceProvider: refusal.provider ?? null,
      requestedProvider: target.provider,
      requestedModel: target.model ?? null,
      requestedProfileId: target.profileId ?? null,
      dryRun: target.dryRun ?? false,
      refusalCode: switchRefusalLogCode(error),
    });
    if (!options?.includeResult) throw error;
    // A dry run never reaches the target, so it reports no settings that could pass for the target's.
    return target.dryRun
      ? {
          agentId: target.agentId,
          outcome: "refused",
          ...failure,
          preview: { sourceEligible: false, targetChecked: false },
        }
      : { ...refusal, ...failure };
  }
}

const DRY_RUN_TARGET_UNCHECKED =
  "The thread is eligible to switch. The target account was not checked; a dry run never contacts providers.";

/** A code that is safe to log: the refusal code, a known class, or one fixed label. */
export function switchRefusalLogCode(error: unknown): string {
  if (error instanceof ProfileSwitchError || error instanceof ProfileLaunchError) return error.code;
  return "unclassified";
}

/** Machine-readable refusal reason; errors outside switch preparation report `error`. */
export function profileSwitchRefusalCode(error: unknown): string {
  return error instanceof ProfileSwitchError ? error.code : "error";
}

/**
 * Coordinator requests, from the agent tool or CLI, always carry an explanation for the journal.
 * Only they preserve settings or refuse; app switches keep their existing behaviour, including
 * switches between provider families.
 */
function isCoordinatorRequest(target: ProfileSwitchTarget): boolean {
  return target.explanation !== undefined;
}

async function executeSwitchCommand(
  dependencies: ProfileSwitchDependencies,
  target: ProfileSwitchTarget,
  options: ProfileSwitchOptions | undefined,
  captureSource: (result: AgentProfileSwitchResult) => void,
): Promise<AgentProfileSwitchResult> {
  const { agentManager } = dependencies;
  const prepared = await prepareCommand(dependencies, target, options ?? {}, captureSource);
  if (prepared.dryRun) {
    return {
      agentId: target.agentId,
      outcome: "refused",
      error: DRY_RUN_TARGET_UNCHECKED,
      preview: { sourceEligible: true, targetChecked: false },
    };
  }
  const { input, record, settings } = prepared;
  const switched = await agentManager.switchAgentProfile(target.agentId, input);
  const result = switchResult(
    target.agentId,
    "switched",
    switched.config,
    switched.lifecycle,
    switched.runtimeInfo,
  );
  if (options?.actor && target.explanation) {
    try {
      await agentManager.appendJournal(target.agentId, {
        entryId: randomUUID(),
        text: `${describeActor(dependencies, options.actor)} switched the account to ${describeAccount(settings, switched.provider, result.model)}. ${target.explanation}`,
        machineContext: JSON.stringify({
          actor: options.actor,
          reason: target.explanation,
          from: record.provider,
          to: switched.provider,
        }),
      });
    } catch (error) {
      result.auditError = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}

function switchResult(
  agentId: string,
  outcome: AgentProfileSwitchResult["outcome"],
  config: AgentSessionConfig,
  status: string,
  runtime?: AgentRuntimeInfo,
): AgentProfileSwitchResult {
  return {
    agentId,
    outcome,
    provider: config.provider,
    status,
    model: runtime?.model ?? config.model ?? null,
    modeId: runtime?.modeId ?? config.modeId ?? null,
    thinkingOptionId: runtime?.thinkingOptionId ?? config.thinkingOptionId ?? null,
    features: config.featureValues ?? {},
  };
}

/** Snapshots the source before any asynchronous work; coordinator and dry-run requests recheck it. */
function captureSwitchSource(
  agentManager: ProfileSwitchDependencies["agentManager"],
  target: ProfileSwitchTarget,
  record: StoredAgentRecord,
  coordinator: boolean,
) {
  const live = agentManager.getAgent(target.agentId);
  const expectedSource =
    live && (coordinator || target.dryRun)
      ? structuredClone({
          config: live.config,
          runtimeInfo: live.runtimeInfo,
          workspaceId: live.workspaceId,
          currentModeId: live.currentModeId,
          features: live.features,
        })
      : undefined;
  const sourceConfig = expectedSource?.config ??
    live?.config ?? {
      ...buildConfigOverrides(record),
      provider: record.provider,
      cwd: record.cwd,
      title: record.title ?? undefined,
    };
  const sourceResult = structuredClone(
    switchResult(
      target.agentId,
      "refused",
      sourceConfig,
      live ? live.lifecycle : "closed",
      live?.runtimeInfo,
    ),
  );
  return { live, expectedSource, sourceConfig, sourceResult };
}

async function prepareCommand(
  dependencies: ProfileSwitchDependencies,
  target: ProfileSwitchTarget,
  options: ProfileSwitchOptions,
  captureSource: (result: AgentProfileSwitchResult) => void,
) {
  const { agentManager, agentStorage, providerSnapshotManager } = dependencies;
  await agentManager.waitForAgentClose(target.agentId);
  const record = await agentStorage.get(target.agentId);
  if (!record) throw new ProfileSwitchError(`Agent not found: ${target.agentId}`, "not-found");
  const coordinator = isCoordinatorRequest(target);
  const { live, expectedSource, sourceConfig, sourceResult } = captureSwitchSource(
    agentManager,
    target,
    record,
    coordinator,
  );
  captureSource(sourceResult);
  if (record.archivedAt)
    throw new ProfileSwitchError("Restore this thread before switching accounts.", "archived");
  if (record.internal || record.config?.controllerExecutionId)
    throw new ProfileSwitchError(
      "This thread is managed by Vorteo and cannot switch accounts.",
      "managed",
    );
  if (target.dryRun) {
    await agentManager.previewAgentProfile(target.agentId, {
      expectedSource,
      validateScope: options.validateScope,
      storedSource: live ? undefined : { record },
    });
    return { dryRun: true as const };
  }
  const preservedSettings = coordinator
    ? effectiveSwitchSettings(sourceConfig, expectedSource, record)
    : undefined;
  if (preservedSettings) {
    captureSource({
      ...sourceResult,
      ...switchResult(
        target.agentId,
        "refused",
        { ...sourceConfig, ...preservedSettings },
        sourceResult.status ?? "closed",
      ),
    });
  }
  const history = (async function* () {
    if (record.persistence) {
      yield* providerSnapshotManager.readSessionHistory(record.persistence, sourceConfig);
    }
  })();
  const storedSource = live
    ? undefined
    : {
        record,
        rows: await agentManager.readStoredSwitchHistory(record, history),
      };
  const settings = dependencies.getSharedProviderConfig?.();
  const config: AgentSessionConfig = {
    provider: target.provider,
    cwd: record.cwd,
    title: sourceConfig.title,
    mcpServers: sourceConfig.mcpServers,
    systemPrompt: options.standingInstructions,
    ...(target.profileId ? { profileId: target.profileId } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(target.thinkingOptionId ? { thinkingOptionId: target.thinkingOptionId } : {}),
  };
  const input = {
    validateScope: options.validateScope,
    expectedSource,
    preservedSettings,
    storedSource,
    config: await resolveProfileSwitchConfig(
      dependencies,
      config,
      preservedSettings
        ? {
            sourceProvider: sourceConfig.provider,
            sourceModel: sourceSwitchModel(sourceConfig, expectedSource, record),
            settings: preservedSettings,
          }
        : undefined,
    ),
    reason: target.reason ?? ("manual" as const),
    carriedContextChars: 0,
    carryContext: (context: string) =>
      formatSwitchInstructions({
        from: describeAccount(
          settings,
          record.provider,
          live?.runtimeInfo?.model ?? sourceConfig.model,
        ),
        to: describeAccount(settings, target.provider, target.model),
        context,
      }),
  };
  return { dryRun: false as const, input, record, settings };
}

function describeActor(
  dependencies: ProfileSwitchDependencies,
  actor: NonNullable<ProfileSwitchOptions["actor"]>,
): string {
  if (actor.kind === "agent") {
    const title = dependencies.agentManager.getAgent(actor.id)?.config.title;
    return title ? `Thread “${title}”` : "The requesting thread";
  }
  return actor.id === "owner"
    ? "The owner"
    : `Service principal “${actor.label ?? "unavailable label"}”`;
}

function effectiveSwitchSettings(
  config: AgentSessionConfig,
  source: AgentProfileSwitchInput["expectedSource"],
  record: StoredAgentRecord,
): NonNullable<AgentProfileSwitchInput["preservedSettings"]> {
  const runtime = source ? source.runtimeInfo : record.runtimeInfo;
  const currentModeId = source ? source.currentModeId : record.lastModeId;
  const features = source ? source.features : record.features;
  const featureValues = { ...config.featureValues };
  for (const feature of features ?? []) featureValues[feature.id] = feature.value;
  for (const [id, value] of Object.entries(featureValues)) {
    if (typeof value !== "boolean" && typeof value !== "string") {
      throw new ProfileSwitchError(
        `Cannot preserve feature '${id}': its effective value is unknown.`,
        "unknown-setting",
      );
    }
  }
  return {
    modeId: currentModeId ?? runtime?.modeId ?? config.modeId,
    // Thinking follows the owner's stored choice; mode follows what is actually in force.
    thinkingOptionId: config.thinkingOptionId,
    featureValues,
  };
}

function sourceSwitchModel(
  config: AgentSessionConfig,
  source: AgentProfileSwitchInput["expectedSource"],
  record: StoredAgentRecord,
): string | null | undefined {
  const runtime = source ? source.runtimeInfo : record.runtimeInfo;
  return config.model ?? runtime?.model;
}
