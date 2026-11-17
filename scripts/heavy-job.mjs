#!/usr/bin/env node
// Runs heavy work (server builds, full typechecks, browser or whole-package
// suites, dependency installs) through one machine-wide slot.
//
//   node scripts/heavy-job.mjs run [--label <text>] -- <command> [args...]
//   node scripts/heavy-job.mjs status
//
// Foreground commands only: the slot follows the original job process group.
// Daemonizing or moving descendants into another session/group is unsupported.
//
// Tickets determine polling order; an atomic directory rename grants the slot.
// A populated slot cannot be overwritten. Ownership follows process identity
// and the job process group, so wrapper death does not release a running job.
// Ticket rewrites use atomic replacement so polling never misses a running job.
//
// The holder starts only when memory allows: critical kernel memory pressure,
// low free memory or active swapping defers the start with the reason shown.
// Load average is deliberately not consulted; background virtual machines and
// agents keep it high without starving memory.
//
// The command runs under `taskpolicy -b` on macOS, which moves it to efficiency
// cores and throttles its I/O, and under `nice -n 10` everywhere. Test worker
// counts are capped unless the caller already set them.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";

const POLL_MS = Number(process.env.VORTEO_HEAVY_POLL_MS) || 5_000;
// kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. Warn is
// routine on a busy 64 GB machine with half its memory free, so only critical defers.
const CRITICAL_PRESSURE = 4;
const MIN_FREE_PERCENT = 10;
const MAX_SWAPOUT_BYTES_PER_SECOND = 1024 * 1024;
export const TEST_WORKER_CAPS = { VITEST_MAX_WORKERS: "2", E2E_WORKERS: "1" };

export function defaultQueueDir(env = process.env) {
  return (
    env.VORTEO_HEAVY_QUEUE_DIR ||
    path.join(os.homedir(), ".local", "share", "vorteo-host", "state", "heavy-jobs")
  );
}

export function defaultGateMarker(env = process.env) {
  return (
    env.VORTEO_BUILDS_GATE_MARKER ||
    path.join(os.homedir(), ".local", "share", "vorteo-host", "state", "builds-gate-running.json")
  );
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

let bootIdentity;
function bootId() {
  if (bootIdentity) return bootIdentity;
  bootIdentity =
    process.platform === "linux"
      ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      : execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" }).trim();
  return bootIdentity;
}

export function processIdentity(pid) {
  if (!processAlive(pid)) return null;
  try {
    const result = execFileSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!result || result.startsWith("Z")) return null;
    return { pid, boot: bootId(), start: result.replace(/^\S+\s+/, "") };
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

export function identityAlive(identity) {
  if (!identity || identity.boot !== bootId()) return false;
  const current = processIdentity(identity.pid);
  if (current && current.start !== identity.start) return false;
  if (!identity.group) return current !== null;
  // A process group keeps its ID until its last member exits, even if the
  // original leader dies. A new leader with a different start time is reuse.
  // Foreground-only contract: descendants that daemonize or call setsid leave
  // this group and do not retain the slot. We do not follow escaped processes.
  const groups = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  return groups.split("\n").some((line) => {
    const [pgid, state] = line.trim().split(/\s+/);
    return Number(pgid) === identity.pid && !state.startsWith("Z");
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function ticketName(queuedAt, pid) {
  // Zero-padded arrival time sorts lexically; the pid breaks same-millisecond ties.
  return `${String(queuedAt).padStart(15, "0")}-${pid}.json`;
}

function ticketNames(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Replaces a ticket atomically so a concurrent reader sees the old or new content, never neither. */
function writeTicket(file, ticket) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ticket));
  fs.renameSync(temp, file);
}

/** Adds a ticket and returns its path. Ticket order is advisory, not a lock. */
export function enqueue(dir, { label, pid = process.pid, now = Date.now(), identity } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ticketName(now, pid));
  writeTicket(file, {
    pid,
    label: label || "heavy job",
    cwd: process.cwd(),
    queuedAt: now,
    identity,
  });
  return file;
}

function removeEmptySlot(slot) {
  try {
    fs.rmdirSync(slot);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

/** Atomically claims the slot; returns a release function, or null when held. */
export function acquireSlot(
  dir,
  { pid = process.pid, identity = processIdentity, live = identityAlive, ticket } = {},
) {
  const slot = path.join(dir, ".slot");
  const candidate = fs.mkdtempSync(path.join(dir, `.claim-${pid}-`));
  const owner = `${pid}-${path.basename(candidate)}`;
  const entries = [owner];
  const wrapper = identity(pid);
  function publish(directory, name, processId) {
    const guard = `!${name}.json`;
    writeTicket(path.join(directory, name), { identity: processId, guard });
    if (ticket && directory === slot) {
      writeTicket(path.join(dir, guard), {
        ...readJson(ticket),
        pid: processId.pid,
        identity: processId,
        startedAt: Date.now(),
        slotGuard: true,
        originTicket: ticket,
      });
    }
  }
  // Populate before the atomic rename. Publishing child ownership later uses a
  // separate immutable entry: a stale wrapper snapshot cannot erase its child.
  publish(candidate, owner, wrapper);
  try {
    let owners = [];
    try {
      owners = fs.readdirSync(slot);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of owners) {
      const previous = readJson(path.join(slot, name));
      // Pre-review claims had no identity payload. A real caller also owns a
      // ticket; an isolated PID-shaped file is not evidence of a running job.
      const oldPid = Number.parseInt(name, 10);
      const oldTicket = ticketNames(dir).some(
        (file) => readJson(path.join(dir, file))?.pid === oldPid,
      );
      const running = previous ? live(previous.identity) : oldTicket && processAlive(oldPid);
      if (!running) {
        fs.rmSync(path.join(slot, name), { force: true });
        if (previous?.guard) fs.rmSync(path.join(dir, previous.guard), { force: true });
      }
    }
    removeEmptySlot(slot);
    try {
      fs.renameSync(candidate, slot);
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST"].includes(error.code)) return null;
      throw error;
    }
    if (ticket) {
      const guard = `!${owner}.json`;
      writeTicket(path.join(dir, guard), {
        ...readJson(ticket),
        pid: wrapper.pid,
        identity: wrapper,
        startedAt: Date.now(),
        slotGuard: true,
        originTicket: ticket,
      });
    }
    const release = () => {
      for (const name of entries) {
        const held = readJson(path.join(slot, name));
        // An exception in the wrapper also triggers exit cleanup. Leave the
        // child's entry and guard intact until the actual group has finished.
        if (name !== owner && live(held?.identity)) continue;
        fs.rmSync(path.join(slot, name), { force: true });
        if (held?.guard) fs.rmSync(path.join(dir, held.guard), { force: true });
      }
      removeEmptySlot(slot);
    };
    release.addChild = (child) => {
      const name = `${child.pid}-${owner}`;
      publish(slot, name, child);
      entries.push(name);
    };
    return release;
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

/** Live tickets in grant order, with the Builds gate marker first when live. Prunes dead tickets. */
export function readQueue(dir, { gateMarker = defaultGateMarker(), alive = processAlive } = {}) {
  const entries = [];
  const gate = readJson(gateMarker);
  if (gate && alive(gate.pid)) {
    entries.push({
      file: gateMarker,
      pid: gate.pid,
      label: "Builds install gate",
      gate: true,
    });
  }
  for (const name of ticketNames(dir).sort()) {
    const file = path.join(dir, name);
    const ticket = readJson(file);
    const running = ticket?.identity ? identityAlive(ticket.identity) : ticket && alive(ticket.pid);
    if (running) {
      entries.push({ file, ...ticket });
    } else if (ticket) {
      fs.rmSync(file, { force: true });
    }
  }
  return entries;
}

/** Returns a reason to defer a heavy start, or null when memory allows it. */
export function memoryDeferral({ pressureLevel, freePercent, swapoutBytesPerSecond }) {
  if (pressureLevel >= CRITICAL_PRESSURE) return "macOS reports critical memory pressure";
  if (Number.isFinite(freePercent) && freePercent < MIN_FREE_PERCENT) {
    return `only ${freePercent}% of memory is free (need ${MIN_FREE_PERCENT}%)`;
  }
  if (swapoutBytesPerSecond > MAX_SWAPOUT_BYTES_PER_SECOND) {
    const mib = (swapoutBytesPerSecond / 1024 / 1024).toFixed(1);
    return `the system is swapping out ${mib} MiB/s`;
  }
  return null;
}

function swapoutBytes() {
  if (process.platform === "darwin") {
    const stats = execFileSync("vm_stat", { encoding: "utf8" });
    const pageSize = Number(/page size of (\d+)/.exec(stats)?.[1] ?? 16384);
    return Number(/Swapouts:\s+(\d+)/.exec(stats)?.[1] ?? 0) * pageSize;
  }
  if (process.platform === "linux") {
    const stats = fs.readFileSync("/proc/vmstat", "utf8");
    return Number(/^pswpout (\d+)/m.exec(stats)?.[1] ?? 0) * 4096;
  }
  return 0;
}

function sysctl(name) {
  return Number(execFileSync("sysctl", ["-n", name], { encoding: "utf8" }).trim());
}

/** Samples memory over `windowMs`; unsupported platforms never defer. */
export async function sampleMemory(windowMs = POLL_MS) {
  const before = swapoutBytes();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const swapoutBytesPerSecond = ((swapoutBytes() - before) * 1000) / windowMs;
  if (process.platform === "darwin") {
    return {
      pressureLevel: sysctl("kern.memorystatus_vm_pressure_level"),
      freePercent: sysctl("kern.memorystatus_level"),
      swapoutBytesPerSecond,
    };
  }
  if (process.platform === "linux") {
    const info = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(info)?.[1]);
    const freePercent = Math.round((kb("MemAvailable") / kb("MemTotal")) * 100);
    return { pressureLevel: 1, freePercent, swapoutBytesPerSecond };
  }
  return { pressureLevel: 1, freePercent: NaN, swapoutBytesPerSecond: 0 };
}

/** The command line and environment a heavy job runs with. */
export function launchSpec(command, { platform = process.platform, env = process.env } = {}) {
  const niced = ["nice", "-n", "10", ...command];
  const argv = platform === "darwin" ? ["taskpolicy", "-b", ...niced] : niced;
  // Marks the job so a nested caller, such as a dependency install, does not queue behind itself.
  const capped = { ...env, VORTEO_HEAVY_JOB: "1" };
  for (const [key, value] of Object.entries(TEST_WORKER_CAPS)) capped[key] ??= value;
  return { argv, env: capped };
}

function describe(entry) {
  return `${entry.label} (pid ${entry.pid}${entry.cwd ? `, ${entry.cwd}` : ""})`;
}

async function waitForSlot(dir, ticket, log) {
  let last = "";
  const say = (message) => {
    if (message !== last) log(message);
    last = message;
  };
  for (;;) {
    const queue = readQueue(dir);
    const position = queue.findIndex((entry) => entry.file === ticket);
    if (position === -1) throw new Error("heavy-job ticket disappeared from the queue");
    if (position > 0) {
      say(`Queued at position ${position + 1}; waiting for ${describe(queue[0])}.`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    const reason = memoryDeferral(await sampleMemory());
    if (!reason) {
      const release = acquireSlot(dir, { ticket });
      if (release) {
        // Legacy callers honor the earliest guard and we drain marked holders.
        // An old caller paused AFTER its last check can still launch: new code
        // cannot revoke that decision. This rollout window ends as old copies
        // pick up main and their finite jobs finish; fresh CI is single-version.
        while (readQueue(dir).some((entry) => entry.startedAt && !entry.identity && !entry.gate)) {
          say("Waiting for the running legacy heavy job to finish.");
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        return release;
      }
      say("Waiting for the running heavy job to release the slot.");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    say(`Holding the heavy slot but deferring the start: ${reason}.`);
  }
}

async function run(args) {
  const separator = args.indexOf("--");
  const command = separator === -1 ? [] : args.slice(separator + 1);
  const labelIndex = args.indexOf("--label");
  const label = labelIndex !== -1 && labelIndex < separator ? args[labelIndex + 1] : command[0];
  if (command.length === 0) {
    console.error(
      "usage: heavy-job.mjs run [--label <text>] -- <command> [args...] (foreground commands only; daemonizing or changing session/group is unsupported)",
    );
    return 2;
  }
  const dir = defaultQueueDir();
  const ticket = enqueue(dir, { label, identity: processIdentity(process.pid) });
  let releaseSlot;
  const release = () => {
    releaseSlot?.();
    fs.rmSync(ticket, { force: true });
  };
  process.on("exit", release);
  const log = (message) => console.error(`[heavy-job] ${message}`);
  const stop = (signal) => {
    release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  releaseSlot = await waitForSlot(dir, ticket, log);
  writeTicket(ticket, { ...readJson(ticket), startedAt: Date.now() });
  log(`Starting ${label} with background priority.`);

  const spec = launchSpec(command);
  // The job cannot execute until its identity and legacy guard are durable.
  // If the wrapper dies before granting permission, EOF makes the shell exit.
  const child = spawn(
    "sh",
    ["-c", 'read -r token <&3 || exit 125; exec 3<&-; exec "$@"', "heavy-job", ...spec.argv],
    {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      detached: true,
      env: spec.env,
    },
  );
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      log(error.message);
      resolve(127);
    });
    child.on("exit", (code, signal) =>
      resolve(code ?? (signal ? 128 + os.constants.signals[signal] : 1)),
    );
  });
  const job = child.pid ? { ...processIdentity(child.pid), group: true } : null;
  if (job?.pid) {
    releaseSlot.addChild(job);
    child.stdio[3].end("go\n");
  } else {
    child.stdio[3]?.destroy();
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
  }
  const code = await done;
  if (job) {
    while (identityAlive(job)) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return code;
}

function status() {
  const jobs = new Map();
  for (const entry of readQueue(defaultQueueDir())) {
    const key = entry.originTicket || entry.file;
    const previous = jobs.get(key);
    // Prefer the live wrapper ticket; if it died, show its surviving child.
    const primary = entry.file === key;
    const survivingChild = previous?.slotGuard && entry.identity?.group;
    if (!previous || primary || survivingChild) {
      jobs.set(key, { ...entry, startedAt: entry.startedAt || previous?.startedAt });
    }
  }
  const queue = [...jobs.values()];
  if (queue.length === 0) {
    console.log("The heavy slot is free.");
    return 0;
  }
  queue.forEach((entry, index) => {
    let state = "queued";
    if (index === 0) state = entry.startedAt || entry.gate ? "running" : "starting";
    console.log(`${index + 1}. ${state}: ${describe(entry)}`);
  });
  return 0;
}

if (isMainModule(import.meta.url)) {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === "run") process.exit(await run(rest));
  if (subcommand === "status") process.exit(status());
  console.error(
    "usage: heavy-job.mjs run|status (foreground commands only; slot ends with the original process group)",
  );
  process.exit(2);
}
