import { readFile, rm } from "node:fs/promises";
import type { Logger } from "pino";
import path from "node:path";
import { PresetFencePolicySchema, type PresetFencePolicy } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../../atomic-file.js";

/**
 * Where the preset fence policy lives (#360). It is kept out of config.json on purpose:
 * - config.json is reloaded live (`paseo daemon config set … ` then reload), and any shell on the
 *   machine can edit it, so a policy there could be switched without the owner or a log line;
 * - daemons from before this setting validate config.json strictly and would refuse to start
 *   with an unknown key, turning a routine rollback into an outage. They never read this file.
 *
 * The daemon reads this file once, at startup, and the policy is fixed for the life of the
 * process. A change, from the owner's app or the file, applies at the next daemon restart, which
 * goes through the tracked restart approval.
 */
export const PRESET_FENCE_POLICY_FILE = "preset-fence.json";

export interface PresetFenceStartupPolicy {
  /** The policy in force; undefined means report-only. */
  policy: PresetFencePolicy | undefined;
  source: "default" | "file";
  /** Why a stored policy was ignored, when it was. */
  problem?: string;
}

export function presetFencePolicyPath(paseoHome: string): string {
  return path.join(paseoHome, PRESET_FENCE_POLICY_FILE);
}

/** Reads the stored policy. A missing file is the default; anything unreadable is reported. */
export async function readPresetFencePolicyFile(
  paseoHome: string,
): Promise<PresetFenceStartupPolicy> {
  let text: string;
  try {
    text = await readFile(presetFencePolicyPath(paseoHome), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { policy: undefined, source: "default" };
    return { policy: undefined, source: "file", problem: "unreadable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { policy: undefined, source: "file", problem: "not valid JSON" };
  }
  const parsed = PresetFencePolicySchema.safeParse(value);
  if (!parsed.success)
    return {
      policy: undefined,
      source: "file",
      problem: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`)
        .join("; ")
        .slice(0, 300),
    };
  return { policy: parsed.data, source: "file" };
}

/** Saves the policy for the next start; null removes it (report-only). */
export async function writePresetFencePolicyFile(
  paseoHome: string,
  policy: PresetFencePolicy | null,
): Promise<void> {
  if (policy === null) {
    await rm(presetFencePolicyPath(paseoHome), { force: true });
    return;
  }
  await writeJsonFileAtomic(
    presetFencePolicyPath(paseoHome),
    PresetFencePolicySchema.parse(policy),
  );
}

let effective: PresetFencePolicy | undefined;

/**
 * Sets the policy for this process. Only daemon startup calls it; no reload, request or tool
 * path does, so a change to the stored policy waits for the next restart.
 */
export function fixEffectivePresetFencePolicy(policy: PresetFencePolicy | undefined): void {
  effective = policy;
}

/** The policy in force for this process; undefined (report-only) until startup fixes it. */
export function effectivePresetFencePolicy(): PresetFencePolicy | undefined {
  return effective;
}

/**
 * Daemon startup: reads the stored policy, fixes it for this process and logs what is in force
 * and where it came from. A stored policy that cannot be used is logged at warn with the reason,
 * so nobody believes enforcement is on while the fence only reports.
 */
export async function loadStartupPresetFencePolicy(paseoHome: string, logger: Logger) {
  const startup = await readPresetFencePolicyFile(paseoHome);
  fixEffectivePresetFencePolicy(startup.policy);
  if (startup.problem)
    logger.warn(
      { code: "preset_fence_setting", problem: startup.problem },
      "Stored preset fence policy ignored; the fence only reports until it is fixed",
    );
  logger.info(
    {
      code: "preset_fence_setting",
      mode: startup.policy?.mode ?? "report",
      report: startup.policy?.report ?? [],
      source: startup.source,
    },
    "Preset fence policy at startup",
  );
  return startup;
}
