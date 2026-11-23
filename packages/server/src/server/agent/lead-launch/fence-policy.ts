import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
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

/**
 * Whether this release may enforce at all. False in C1: whatever the file or the owner's app says,
 * the policy in force is report-only, and a stored enforce is kept on disk but logged at warn.
 * Any same-user process can write the policy file and every install restarts the daemon, so an
 * enforce written by anyone would refuse Factory and worker traffic after the next install. C3
 * removes this constant once its preconditions hold (see the plan on #360). The enforce code
 * paths stay, exercised in tests through FenceLookup.policy.
 */
export const PRESET_FENCE_ENFORCE_AVAILABLE = false;

/** Every path the fence checks. A policy naming anything else is malformed. */
export const PRESET_FENCE_PATHS = [
  "create_agent",
  "remote_create_agent",
  "session_create_agent",
  "update_agent",
  "set_agent_mode",
  "send_agent_prompt",
  "switch_agent_profile",
  "session_switch_agent_profile",
  "create_schedule",
  "update_schedule",
  "run_schedule_once",
  "resume_schedule",
] as const;
export type PresetFencePath = (typeof PRESET_FENCE_PATHS)[number];

/** Larger than any real policy; a bigger file is refused rather than read. */
const MAX_POLICY_BYTES = 16 * 1024;

/** The unknown path names in a policy, which make it malformed. */
export function unknownPresetFencePaths(policy: PresetFencePolicy): string[] {
  const known = new Set<string>(PRESET_FENCE_PATHS);
  return (policy.report ?? []).filter((name) => !known.has(name));
}

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

/**
 * Reads at most MAX_POLICY_BYTES from a regular file, without following a symbolic link and
 * without blocking on a FIFO, so a hostile file cannot hang or bloat daemon startup.
 */
async function readPolicyText(file: string): Promise<{ text: string } | { problem: string }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { problem: "not a regular file" };
    if (stat.size > MAX_POLICY_BYTES) return { problem: `larger than ${MAX_POLICY_BYTES} bytes` };
    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_POLICY_BYTES) return { problem: `larger than ${MAX_POLICY_BYTES} bytes` };
    return { text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

/** Reads the stored policy. A missing file is the default; anything unusable is reported. */
export async function readPresetFencePolicyFile(
  paseoHome: string,
): Promise<PresetFenceStartupPolicy> {
  let text: string;
  try {
    const read = await readPolicyText(presetFencePolicyPath(paseoHome));
    if ("problem" in read) return { policy: undefined, source: "file", problem: read.problem };
    text = read.text;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { policy: undefined, source: "default" };
    if (code === "ELOOP") return { policy: undefined, source: "file", problem: "a symbolic link" };
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
  const unknown = unknownPresetFencePaths(parsed.data);
  if (unknown.length)
    return {
      policy: undefined,
      source: "file",
      problem: `unknown path names in report: ${unknown.join(", ").slice(0, 200)}`,
    };
  return { policy: parsed.data, source: "file" };
}

/** Saves the policy for the next start; null removes it (report-only). */
export async function writePresetFencePolicyFile(
  paseoHome: string,
  policy: PresetFencePolicy | null,
): Promise<void> {
  if (policy && unknownPresetFencePaths(policy).length)
    throw new Error(`Unknown preset fence paths: ${unknownPresetFencePaths(policy).join(", ")}`);
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
  const stored = await readPresetFencePolicyFile(paseoHome);
  const startup = policyInForce(stored);
  if (stored.policy?.mode === "enforce" && startup.policy?.mode !== "enforce")
    logger.warn(
      { code: "preset_fence_setting", stored: stored.policy },
      "Preset fence enforce requested but not available in this release; reporting only",
    );
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

/**
 * The policy this release puts in force for what is stored. A stored enforce stays on disk but
 * is reported only while PRESET_FENCE_ENFORCE_AVAILABLE is false.
 */
export function policyInForce(
  stored: PresetFenceStartupPolicy,
  enforceAvailable: boolean = PRESET_FENCE_ENFORCE_AVAILABLE,
): PresetFenceStartupPolicy {
  if (stored.policy?.mode !== "enforce" || enforceAvailable) return stored;
  return { ...stored, policy: { ...stored.policy, mode: "report" } };
}
