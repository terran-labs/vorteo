import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import type { ContainerDaemonConfig } from "./config.js";

const execute = promisify(execFile);

export function supervisorPlanDigest(
  plan: ContainerDaemonConfig["supervisorMaintenance"],
): string | undefined {
  if (!plan) return undefined;
  try {
    accessSync(plan.node, constants.X_OK);
    const sha256 = createHash("sha256").update(readFileSync(plan.script)).digest("hex");
    return sha256 === plan.sha256 ? sha256 : undefined;
  } catch {
    // Unreadable scripts or unavailable executables cannot advertise maintenance capability.
    return undefined;
  }
}

export async function runSupervisorMaintenance(
  plan: NonNullable<ContainerDaemonConfig["supervisorMaintenance"]>,
  job: RestartJob,
): Promise<void> {
  if (job.target !== "container-daemon" || job.supervisorPlanSha256 !== plan.sha256)
    throw new Error("Supervisor maintenance plan is unavailable or changed");
  const script = readFileSync(plan.script);
  if (createHash("sha256").update(script).digest("hex") !== plan.sha256)
    throw new Error("Supervisor maintenance script changed; no restart dispatched");
  // Execute the verified buffer so replacing the script after review cannot change the operation.
  await execute(plan.node, ["--input-type=module", "--eval", script.toString("utf8")], {
    env: {
      ...process.env,
      VORTEO_RESTART_JOB_ID: job.id,
      VORTEO_RESTART_FORCE: job.whenIdle ? "0" : "1",
    },
    timeout: 360_000,
    maxBuffer: 8192,
  });
}

export interface SupervisorReplacementInput {
  /** Reads the current Dev worker PID; rejects when Dev does not answer. */
  readPid(): Promise<number>;
  /** Runs the verified plan once. Never retried. */
  run(): Promise<void>;
  wait?: (ms: number) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Runs supervisor maintenance once and waits for a replacement worker. A wedged
 * Dev, whose supervisor or worker is down, has no previous PID; that is the
 * outage this route recovers, so any answering worker then counts as the
 * replacement. The protected plan script verifies the release it selected.
 * Returns null when no worker answers before the deadline.
 */
export async function runSupervisorReplacement({
  readPid,
  run,
  wait = delay,
  now = Date.now,
  timeoutMs = 120_000,
}: SupervisorReplacementInput): Promise<{ previousPid: number | null; pid: number } | null> {
  let previousPid: number | null;
  try {
    previousPid = await readPid();
  } catch {
    previousPid = null;
  }
  await run();
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await wait(1000);
    try {
      const pid = await readPid();
      if (pid !== previousPid) return { previousPid, pid };
    } catch {
      /* The worker may still be starting; never dispatch again. */
    }
  }
  return null;
}
