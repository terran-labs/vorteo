#!/usr/bin/env node
// Runs heavy work (server builds, full typechecks, browser or whole-package
// suites, dependency installs) through one machine-wide slot.
//
//   node scripts/heavy-job.mjs run [--label <text>] -- <command> [args...]
//   node scripts/heavy-job.mjs status
//
// Each caller writes a ticket named by its arrival time; the oldest ticket
// whose process is alive holds the slot, so jobs never overlap and run in
// arrival order. A ticket whose process has exited is removed by the next
// reader. A live Builds gate marker holds the slot ahead of every ticket.
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Adds a ticket at the back of the queue and returns its path. */
export function enqueue(dir, { label, pid = process.pid, now = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const ticket = {
    pid,
    label: label || "heavy job",
    cwd: process.cwd(),
    queuedAt: now,
  };
  // Zero-padded arrival time sorts lexically; the pid breaks same-millisecond ties.
  const file = path.join(dir, `${String(now).padStart(15, "0")}-${pid}.json`);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ticket));
  fs.renameSync(temp, file);
  return file;
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
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return entries;
  }
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const ticket = readJson(file);
    if (ticket && alive(ticket.pid)) {
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
  const capped = { ...env };
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
    if (!reason) return;
    say(`Holding the heavy slot but deferring the start: ${reason}.`);
  }
}

async function run(args) {
  const separator = args.indexOf("--");
  const command = separator === -1 ? [] : args.slice(separator + 1);
  const labelIndex = args.indexOf("--label");
  const label = labelIndex !== -1 && labelIndex < separator ? args[labelIndex + 1] : command[0];
  if (command.length === 0) {
    console.error("usage: heavy-job.mjs run [--label <text>] -- <command> [args...]");
    return 2;
  }
  const dir = defaultQueueDir();
  const ticket = enqueue(dir, { label });
  const release = () => fs.rmSync(ticket, { force: true });
  process.on("exit", release);
  const log = (message) => console.error(`[heavy-job] ${message}`);
  const stop = (signal) => {
    release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await waitForSlot(dir, ticket, log);
  fs.writeFileSync(ticket, JSON.stringify({ ...readJson(ticket), startedAt: Date.now() }));
  log(`Starting ${label} with background priority.`);

  const spec = launchSpec(command);
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    stdio: "inherit",
    env: spec.env,
  });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  return await new Promise((resolve) => {
    child.on("error", (error) => {
      log(error.message);
      resolve(127);
    });
    child.on("exit", (code, signal) =>
      resolve(code ?? (signal ? 128 + os.constants.signals[signal] : 1)),
    );
  });
}

function status() {
  const queue = readQueue(defaultQueueDir());
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
  console.error("usage: heavy-job.mjs run|status");
  process.exit(2);
}
