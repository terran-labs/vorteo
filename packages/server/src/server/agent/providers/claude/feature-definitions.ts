import type { AgentFeature, AgentFeatureToggle } from "../../agent-sdk-types.js";
import { claudeManifestModelSupportsFastMode } from "./model-manifest.js";

export const CLAUDE_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export const CLAUDE_CHROME_FEATURE_ID = "chrome";

// Opt-in per thread: it hands the agent the owner's real, logged-in browser.
export const CLAUDE_CHROME_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: CLAUDE_CHROME_FEATURE_ID,
  label: "Chrome",
  description: "Let this agent use your Chrome through the Claude in Chrome extension",
  tooltip: "Toggle Claude in Chrome (applies next turn)",
  icon: "globe",
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  return claudeManifestModelSupportsFastMode(modelId);
}

export function buildClaudeFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
  chromeAvailable?: boolean;
  chromeEnabled?: boolean;
}): AgentFeature[] {
  const features: AgentFeature[] = [];
  if (claudeModelSupportsFastMode(input.modelId)) {
    features.push({ ...CLAUDE_FAST_MODE_FEATURE, value: input.fastModeEnabled });
  }
  if (input.chromeAvailable) {
    features.push({ ...CLAUDE_CHROME_FEATURE, value: input.chromeEnabled === true });
  }
  return features;
}
