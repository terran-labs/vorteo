import type { ProviderCliUpdate } from "@getpaseo/protocol/messages";

/**
 * Draft for a Host task that upgrades an outdated provider CLI. The owner reviews
 * and submits it; preparing the draft never starts an agent.
 */
export function buildCliUpgradePrompt(update: ProviderCliUpdate, environment?: string): string {
  const where = environment ? `the ${environment} environment` : "the environment that reported it";
  const models = update.affectedModels
    .map((model) => `${model.label} needs ${model.minimumVersion} or later`)
    .join("; ");
  return `Upgrade ${update.cli} in ${where}. It reports version ${update.installedVersion}. ${models ? `${models}.` : ""}

The environment suggested: ${update.instructions}

Find how this installation installs ${update.cli} in that environment before changing anything, and upgrade it through that mechanism so the next installation update does not revert it. If the CLI lives in the Dev container, upgrade it there through the supported installation workflow rather than editing the container by hand. Refresh the provider afterwards and verify that the reported ${update.cli} version satisfies every model listed above. Do not restart a daemon outside the installation-maintenance workflow.`;
}
