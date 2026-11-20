#!/usr/bin/env node
// Runs heavy work (server builds, full typechecks, browser or whole-package
// suites, dependency installs) through one machine-wide slot.
//
//   node scripts/heavy-job.mjs run [--label <text>] [--priority low|normal|high] -- <command> [args...]
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
// Waiters go by priority class, then arrival, then pid. The ticket filename
// alone carries that order, so copies of this script from before priorities
// existed, which sort the same directory by name, agree with this one. A
// priority reorders waiters only: a running job is never displaced. Normal
// tickets, old and new, stay strictly first come, first served: only a low
// ticket ages, into normal at its own arrival time, and high is only declared.
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
// Lowest to highest. A caller may declare the first three; urgent is reserved
// for a later daemon grant and is never declared or reached by waiting.
const PRIORITIES = ["low", "normal", "high", "urgent"];
const DECLARABLE = new Set(PRIORITIES.slice(0, 3));
// Normal keeps the name every earlier copy writes, so their tickets are normal.
// "!" guards < "+" prefixes < digits < letters in the plain sort all copies use.
const PRIORITY_PREFIX = { urgent: "+0-urgent-", high: "+1-high-", normal: "", low: "low-" };
const TICKET_NAME = /^(\+0-urgent-|\+1-high-|low-|)(\d{15})-(\d+)\.json$/;
// How long a low waiter waits before it counts as normal. The override is for tests.
export const AGE_STEP_MS = Number(process.env.VORTEO_HEAVY_AGE_MS) || 20 * 60 * 1000;

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

function ticketName(queuedAt, pid, priority = "normal") {
  // Zero-padded arrival time sorts lexically; the pid breaks same-millisecond ties.
  return `${PRIORITY_PREFIX[priority]}${String(queuedAt).padStart(15, "0")}-${pid}.json`;
}

/** The priority class a ticket's filename places it in, or null for a guard or foreign file. */
export function ticketPriority(file) {
  const match = TICKET_NAME.exec(path.basename(file));
  return match ? PRIORITIES.find((name) => PRIORITY_PREFIX[name] === match[1]) : null;
}

/** Picks the declared priority: the argument, else VORTEO_HEAVY_PRIORITY, else normal. Throws on a bad value. */
export function declaredPriority(argument, env = process.env) {
  const fromEnv = env.VORTEO_HEAVY_PRIORITY || undefined;
  const value = argument ?? fromEnv ?? "normal";
  const origin = argument === undefined ? "VORTEO_HEAVY_PRIORITY" : "--priority";
  if (value === "urgent") {
    throw new Error(
      `${origin} urgent is refused: urgent priority is reserved and cannot be declared by the caller. Use low, normal or high.`,
    );
  }
  if (!DECLARABLE.has(value)) {
    throw new Error(`${origin} must be low, normal or high, not ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Reads `--priority <value>` or `--priority=<value>` from the options before `--`. Throws on any other form. */
export function priorityArgument(options) {
  let value;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--label") {
      index += 1;
    } else if (option.startsWith("--priority")) {
      if (value !== undefined) throw new Error("--priority was given more than once.");
      if (option === "--priority") {
        index += 1;
        if (index >= options.length) throw new Error("--priority needs a value.");
        value = options[index];
      } else if (option.startsWith("--priority=")) {
        value = option.slice("--priority=".length);
      } else {
        throw new Error(`unknown option ${option}; use --priority low|normal|high.`);
      }
    }
  }
  return value;
}

/**
 * Renames a waiter's own ticket to the place it is due and returns its path.
 * The arrival time and pid in the name never change.
 *
 * - A low ticket becomes normal once it has waited `step`, and so sorts by its
 *   original arrival among normal tickets. Normal never ages and nothing ages
 *   into high, so normal tickets from copies that cannot age are never passed
 *   by one that arrived after them, except by a declared high.
 * - A high ticket waits under its normal name while an earlier ticket from the
 *   3 November protocol is live and unstarted. Those callers take no slot
 *   claim: one that saw itself first may be about to start, and it cannot see
 *   a ticket that jumps ahead afterwards. Arrival order is what it relied on.
 *   For the same reason a low ticket does not age past such a ticket.
 *
 * One rename(2): the ticket exists under exactly one name at every instant,
 * including if the waiter dies here, and a dead waiter's ticket is pruned
 * under either name.
 */
export function placeTicket(
  file,
  { declared = "normal", now = Date.now(), step = AGE_STEP_MS, queue = [] } = {},
) {
  const match = TICKET_NAME.exec(path.basename(file));
  if (!match || (declared !== "low" && declared !== "high")) return file;
  const arrival = Number(match[2]);
  const name = (priority) => ticketName(arrival, match[3], priority);
  const normal = name("normal");
  const preSlot = queue
    .filter((entry) => !entry.gate && !entry.identity && !entry.startedAt)
    .filter((entry) => ticketPriority(entry.file) === "normal")
    .map((entry) => path.basename(entry.file));
  let target = path.basename(file);
  if (declared === "high") {
    target = preSlot.some((other) => other < normal) ? normal : name("high");
  } else if (target === name("low") && now - arrival >= step) {
    if (!preSlot.some((other) => other > normal)) target = normal;
  }
  if (target === path.basename(file)) return file;
  const next = path.join(path.dirname(file), target);
  try {
    fs.renameSync(file, next);
  } catch (error) {
    if (error.code === "ENOENT") return file;
    throw error;
  }
  return next;
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
export function enqueue(
  dir,
  { label, pid = process.pid, now = Date.now(), identity, priority = "normal" } = {},
) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ticketName(now, pid, priority));
  writeTicket(file, {
    pid,
    label: label || "heavy job",
    cwd: process.cwd(),
    queuedAt: now,
    identity,
    // What the caller asked for. The filename holds the class it currently waits in.
    priority,
    prioritySource: "declared",
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
  const gate = readJson(gateMarker);
  const first =
    gate && alive(gate.pid)
      ? [{ file: gateMarker, pid: gate.pid, label: "Builds install gate", gate: true }]
      : [];
  // A waiter gaining a class renames its ticket. A name that was listed and is
  // gone before it is read may be that waiter mid-move, so list again instead
  // of ranking the caller as if the waiter had left. The pass limit only bounds
  // a directory that keeps changing; the atomic slot claim still decides.
  for (let pass = 1; ; pass += 1) {
    const entries = [...first];
    let moved = false;
    for (const name of ticketNames(dir).sort()) {
      const file = path.join(dir, name);
      const ticket = readJson(file);
      if (!ticket) {
        moved ||= !fs.existsSync(file);
        continue;
      }
      const running = ticket.identity ? identityAlive(ticket.identity) : alive(ticket.pid);
      if (running) entries.push({ file, ...ticket });
      else fs.rmSync(file, { force: true });
    }
    if (!moved || pass === 3) return entries;
  }
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

/** The class a job waits or waited in and where that came from; empty for the gate. */
function describePriority(entry) {
  const current = entry.gate ? null : ticketPriority(entry.originTicket || entry.file);
  if (!current) return "";
  const declared = entry.priority;
  if (declared === undefined && entry.prioritySource === undefined && current === "normal") {
    return " [priority normal, legacy ticket]";
  }
  // Only what this script writes is reported as declared. Anything else, such
  // as a hand-written urgent ticket, is shown as the unverified claim it is.
  const moved = { low: ", aged from low", high: ", held from high by an older-format waiter" };
  const written =
    entry.prioritySource === "declared" &&
    DECLARABLE.has(declared) &&
    (current === declared || (current === "normal" && moved[declared]));
  if (!written) return ` [priority ${current}, unverified]`;
  return ` [priority ${current}${current === declared ? "" : moved[declared]}, declared]`;
}

/** Waits for the slot. `waiter.file` follows the ticket through its promotions. */
async function waitForSlot(dir, waiter, log) {
  let last = "";
  const say = (message) => {
    if (message !== last) log(message);
    last = message;
  };
  for (;;) {
    const queue = readQueue(dir);
    // Rename and bookkeeping share one synchronous step, so a signal handler
    // always removes the ticket's current name. A move restarts the pass:
    // every claim follows a queue read taken after the ticket's last rename.
    const placed = placeTicket(waiter.file, { declared: waiter.priority, queue });
    if (placed !== waiter.file) {
      waiter.file = placed;
      if (waiter.priority === "low") log("Waited long enough to move up to normal priority.");
      else if (ticketPriority(placed) === "high") log("Queued at high priority again.");
      else log("An older-format waiter arrived first; waiting behind it in arrival order.");
      continue;
    }
    const ticket = waiter.file;
    const position = queue.findIndex((entry) => entry.file === ticket);
    if (position === -1) throw new Error("heavy-job ticket disappeared from the queue");
    if (position > 0) {
      say(`Queued at position ${position + 1}; waiting for ${describe(queue[0])}.`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    const reason = memoryDeferral(await sampleMemory());
    // The memory sample takes a poll interval. A waiter that arrived or moved
    // ahead meanwhile goes first; one that lands after this check loses the
    // atomic claim below or waits for this job, like any arrival after a start.
    if (!reason && readQueue(dir)[0]?.file !== ticket) continue;
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
      "usage: heavy-job.mjs run [--label <text>] [--priority low|normal|high] -- <command> [args...] (foreground commands only; daemonizing or changing session/group is unsupported)",
    );
    return 2;
  }
  let priority;
  try {
    priority = declaredPriority(priorityArgument(args.slice(0, separator)));
  } catch (error) {
    console.error(`heavy-job.mjs: ${error.message}`);
    return 2;
  }
  const dir = defaultQueueDir();
  const waiter = {
    file: enqueue(dir, { label, priority, identity: processIdentity(process.pid) }),
    priority,
  };
  let releaseSlot;
  const release = () => {
    releaseSlot?.();
    fs.rmSync(waiter.file, { force: true });
  };
  process.on("exit", release);
  const log = (message) => console.error(`[heavy-job] ${message}`);
  const stop = (signal) => {
    release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  releaseSlot = await waitForSlot(dir, waiter, log);
  const ticket = waiter.file;
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
    console.log(`${index + 1}. ${state}: ${describe(entry)}${describePriority(entry)}`);
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
