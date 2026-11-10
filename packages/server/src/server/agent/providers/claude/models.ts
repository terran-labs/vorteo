import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  buildThinkingOptions,
  CLAUDE_DEFAULT_THINKING_OPTION_ID,
  getClaudeCustomModelThinkingOptions,
  getClaudeManifestModels,
  isClaudeEffortLevel,
  normalizeClaudeManifestModelId,
  normalizeClaudeRuntimeModelId as normalizeClaudeManifestRuntimeModelId,
} from "./model-manifest.js";

const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

export function getClaudeModels(claudeCodeVersion?: string): AgentModelDefinition[] {
  return getClaudeManifestModels(claudeCodeVersion);
}

export function resolveConfiguredClaudeModel(model: AgentModelDefinition): AgentModelDefinition {
  if (model.thinkingOptions !== undefined) return model;

  const manifestModelId = normalizeClaudeManifestModelId(model.id);
  const manifestModel = manifestModelId
    ? getClaudeModels().find((candidate) => candidate.id === manifestModelId)
    : undefined;
  if (manifestModel) {
    return manifestModel.thinkingOptions
      ? { ...model, thinkingOptions: manifestModel.thinkingOptions }
      : model;
  }
  return { ...model, thinkingOptions: getClaudeCustomModelThinkingOptions() };
}

export function findClaudeModel(
  modelId: string | null | undefined,
): AgentModelDefinition | undefined {
  const normalizedModelId = normalizeClaudeRuntimeModelId(modelId);
  if (!normalizedModelId) {
    return undefined;
  }
  return getClaudeModels().find((model) => model.id === normalizedModelId);
}

export function getClaudeContextWindowMaxTokens(
  modelId: string | null | undefined,
): number | undefined {
  if (modelId?.trim().toLowerCase().endsWith("[1m]")) {
    return 1_000_000;
  }
  return findClaudeModel(modelId)?.contextWindowMaxTokens;
}

/**
 * Build catalog entries for models Claude Code advertises that the curated manifest lacks, so a
 * new release appears as soon as the installed CLI supports it. Curated entries keep priority
 * because they carry context windows, fast mode and disabled thinking, which the CLI does not
 * report or the launcher gates on the manifest.
 */
export function getDiscoveredClaudeModels(
  advertisedModels: readonly ModelInfo[],
): AgentModelDefinition[] {
  const definitions: AgentModelDefinition[] = [];
  for (const advertised of advertisedModels) {
    // "default" is a pointer to another advertised row, labelled for Claude Code's own picker.
    if (advertised.value === "default") continue;
    const id = (advertised.resolvedModel ?? advertised.value).trim();
    if (
      !id ||
      // Runtime normalization also maps gateway and cloud provider spellings of curated models.
      normalizeClaudeRuntimeModelId(id) !== null ||
      definitions.some((model) => model.id === id)
    ) {
      continue;
    }
    const definition: AgentModelDefinition = {
      provider: "claude",
      id,
      label: advertised.displayName.trim() || id,
      description: advertised.description.trim() || "Reported by Claude Code",
    };
    if (id.toLowerCase().endsWith("[1m]")) {
      definition.contextWindowMaxTokens = 1_000_000;
    }
    // A newer CLI may report effort levels this daemon cannot label or launch.
    const effortLevels = (advertised.supportedEffortLevels ?? []).filter(isClaudeEffortLevel);
    if (effortLevels.length > 0) {
      const defaultThinkingOptionId = effortLevels.includes(CLAUDE_DEFAULT_THINKING_OPTION_ID)
        ? CLAUDE_DEFAULT_THINKING_OPTION_ID
        : effortLevels[0];
      // Disabled thinking and fast mode stay manifest-only: session launch gates them on the
      // curated manifest, which every client and restart sees the same way.
      definition.thinkingOptions = buildThinkingOptions(
        effortLevels,
        false,
        defaultThinkingOptionId,
      );
      definition.defaultThinkingOptionId = defaultThinkingOptionId;
    }
    definitions.push(definition);
  }
  return definitions;
}

export async function getClaudeModelsWithSettings(
  logger: Logger,
  configDir: string,
  claudeCodeVersion?: string,
  discoveredModelIds: ReadonlySet<string> = new Set(),
  advertisedModels: readonly ModelInfo[] = [],
): Promise<AgentModelDefinition[]> {
  const hardcodedModels = [
    ...getDiscoveredClaudeModels(advertisedModels),
    ...getClaudeManifestModels(claudeCodeVersion, discoveredModelIds),
  ];
  const settingsModels = await readClaudeSettingsModels(logger, configDir);
  if (settingsModels.length === 0) {
    return hardcodedModels;
  }

  const models = [...hardcodedModels];

  for (const model of settingsModels) {
    const existingIndex = models.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex !== -1) {
      const existing = models[existingIndex];
      if (existing?.isSelectable === false) {
        models[existingIndex] = { ...existing, ...model, isSelectable: true };
      }
      continue;
    }
    const manifestModel = getClaudeModels(claudeCodeVersion).find(
      (candidate) => candidate.id === model.id,
    );
    models.push({ ...manifestModel, ...model });
  }

  return models;
}

async function readClaudeSettingsModels(
  logger: Logger,
  configDir: string,
): Promise<AgentModelDefinition[]> {
  const settingsPath = path.join(configDir, "settings.json");

  let parsed: unknown;
  try {
    const rawSettings = await fs.readFile(settingsPath, "utf8");
    parsed = JSON.parse(rawSettings);
  } catch (error) {
    logger.debug({ err: error, settingsPath }, "Failed to read Claude settings models");
    return [];
  }

  if (!isRecord(parsed)) {
    logger.debug({ settingsPath }, "Claude settings.json is not an object");
    return [];
  }

  const models: AgentModelDefinition[] = [];
  addSettingsModel(models, parsed.model, "model");

  const env = parsed.env;
  if (env === undefined) {
    return models;
  }
  if (!isRecord(env)) {
    logger.debug({ settingsPath }, "Claude settings.json env is not an object");
    return models;
  }

  for (const envKey of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
    addSettingsModel(models, env[envKey], `env.${envKey}`);
  }

  return models;
}

function addSettingsModel(
  models: AgentModelDefinition[],
  value: unknown,
  settingsKey: string,
): void {
  if (typeof value !== "string") {
    return;
  }

  const id = value.trim();
  if (id.length === 0 || models.some((model) => model.id === id)) {
    return;
  }

  models.push({
    provider: "claude",
    id,
    label: id,
    description: `From Claude settings.json ${settingsKey}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a runtime model string (from SDK init message) to a known model ID.
 * Handles the `[1m]` suffix that the SDK appends for 1M context sessions.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  return normalizeClaudeManifestRuntimeModelId(value);
}

/**
 * Placeholder model values Claude Code writes on frames with no real inference behind them.
 * These are not models and must never be displayed.
 */
const CLAUDE_PLACEHOLDER_MODEL_IDS = new Set(["<synthetic>"]);

/**
 * Resolve a model id observed on a Claude assistant frame, for display.
 *
 * Prefers the manifest-normalized id so equivalent spellings collapse (a dated alias and a
 * gateway prefix are the same model), but falls back to the raw string when the manifest does
 * not know it. The fallback matters: Claude Code is an Anthropic-compatible client, so subagents
 * routinely report models that are not Anthropic's — Z.AI GLM ids via `ANTHROPIC_BASE_URL`
 * (docs/custom-providers.md) among them. Manifest-only resolution would blank the model for
 * exactly those users.
 *
 * A `[1m]` suffix is preserved where it names its own manifest entry. Models such as Fable 5
 * that only have a 1M entry normalize the retired suffixed spelling to the canonical ID.
 *
 * Returns null for placeholders and empty values, meaning "not observed".
 */
export function resolveObservedClaudeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || CLAUDE_PLACEHOLDER_MODEL_IDS.has(trimmed)) {
    return null;
  }
  return normalizeClaudeManifestRuntimeModelId(trimmed) ?? trimmed;
}
