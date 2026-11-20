import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGE_STEP_MS,
  acquireSlot,
  declaredPriority,
  enqueue,
  launchSpec,
  memoryDeferral,
  placeTicket,
  priorityArgument,
  readQueue,
  processIdentity,
  identityAlive,
  ticketPriority,
} from "./heavy-job.mjs";

// Every child below inherits this environment; a caller's own queue settings must not leak in.
delete process.env.VORTEO_HEAVY_PRIORITY;
delete process.env.VORTEO_HEAVY_AGE_MS;

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "heavy-job-"));

test("the queue grants by priority then arrival, prunes exited holders and puts a live gate first", () => {
  const dir = temp();
  const gateMarker = path.join(dir, "gate.json");
  const alive = (pid) => pid !== 2;
  // Written out of order: [label, priority, arrival, pid]. Expected grant order follows.
  for (const [label, priority, now, pid] of [
    ["low", "low", 100, 11],
    ["late", "normal", 2_000, 3],
    ["dead", "normal", 500, 2],
    ["high-late", "high", 3_000, 13],
    ["early", "normal", 1_000, 1],
    ["high-tie-b", "high", 2_500, 14],
    ["high-tie-a", "high", 2_500, 12],
    ["reserved", "urgent", 9_000, 15],
  ]) {
    enqueue(dir, { label, priority, now, pid });
  }
  // A ticket from a copy of the script that predates priorities, and a running job's guard.
  fs.writeFileSync(
    path.join(dir, "000000000001500-7.json"),
    JSON.stringify({ pid: 7, label: "legacy", queuedAt: 1_500 }),
  );
  fs.writeFileSync(
    path.join(dir, "!9-claim.json"),
    JSON.stringify({ pid: 9, label: "running", startedAt: 1, slotGuard: true }),
  );
  const tickets = readQueue(dir, { gateMarker, alive });
  assert.deepEqual(
    tickets.map((entry) => [entry.label, ticketPriority(entry.file)]),
    [
      ["running", null],
      ["reserved", "urgent"],
      ["high-tie-a", "high"],
      ["high-tie-b", "high"],
      ["high-late", "high"],
      ["early", "normal"],
      ["legacy", "normal"],
      ["late", "normal"],
      ["low", "low"],
    ],
  );
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.deepEqual(
    tickets.map((entry) => path.basename(entry.file)),
    names.toSorted(),
    "grant order is plain filename order, which older copies of the script also use",
  );
  assert.equal(names.length, 9, "the exited holder's ticket is removed");
  assert.equal(path.basename(tickets[5].file), "000000000001000-1.json", "normal keeps its name");

  fs.writeFileSync(gateMarker, JSON.stringify({ pid: 4 }));
  assert.equal(readQueue(dir, { gateMarker, alive })[0].label, "Builds install gate");
  fs.writeFileSync(gateMarker, JSON.stringify({ pid: 2 }));
  assert.equal(readQueue(dir, { gateMarker, alive })[0].label, "running");
});

test("only a low waiter ages, into normal at its arrival, and a reader never loses it mid-rename", () => {
  const dir = temp();
  const gateMarker = path.join(dir, "none");
  let low = enqueue(dir, { label: "low", pid: 2, now: 500, priority: "low" });
  const first = enqueue(dir, { label: "first", pid: 1, now: 1_000 });
  enqueue(dir, { label: "second", pid: 3, now: 2_000, identity: processIdentity(process.pid) });
  const read = (alive = () => true) => readQueue(dir, { gateMarker, alive });
  const labels = (alive) => read(alive).map((entry) => entry.label);
  const age = (minutes, queue = []) => {
    low = placeTicket(low, { declared: "low", now: 500 + minutes * 60_000, queue });
    return path.basename(low);
  };
  assert.equal(age(19), "low-000000000000500-2.json");
  assert.deepEqual(labels(), ["first", "second", "low"]);
  // "first" has no identity and no start time: a caller on the 3 November
  // protocol that may already have seen itself first. Nothing moves ahead of it.
  assert.equal(age(20, read()), "low-000000000000500-2.json");
  const high = enqueue(dir, { label: "high", pid: 5, now: 1_500, priority: "high" });
  const held = placeTicket(high, { declared: "high", queue: read() });
  assert.equal(path.basename(held), "000000000001500-5.json", "high waits in arrival order");
  assert.deepEqual(labels(), ["first", "high", "second", "low"]);
  const started = [{ file: first, pid: 1, startedAt: 1 }];
  const again = placeTicket(held, { declared: "high", queue: started });
  assert.equal(ticketPriority(again), "high", "and returns once that caller has started or gone");
  fs.rmSync(again);
  // The rename lands after a reader listed the directory and before it reads
  // the old name. Dropping the waiter here would let "first" and it both lead.
  assert.deepEqual(
    labels((pid) => {
      if (pid === 1) age(20);
      return true;
    }),
    ["low", "first", "second"],
    "it joins normal at its original arrival, ahead of later arrivals",
  );
  assert.equal(age(60 * 24), "000000000000500-2.json", "waiting never reaches high");
  const ticket = JSON.parse(fs.readFileSync(low, "utf8"));
  assert.deepEqual(
    [ticket.queuedAt, ticket.priority, ticket.prioritySource],
    [500, "low", "declared"],
  );
  assert.deepEqual(fs.readdirSync(dir).toSorted(), [
    "000000000000500-2.json",
    "000000000001000-1.json",
    "000000000002000-3.json",
  ]);
  const normal = enqueue(dir, { pid: 4, now: 0 });
  assert.equal(placeTicket(normal, { now: 100 * AGE_STEP_MS }), normal, "normal never ages");
});

test("a priority is declared by argument, then environment, and urgent is refused", () => {
  assert.equal(declaredPriority(undefined, {}), "normal");
  assert.equal(declaredPriority(undefined, { VORTEO_HEAVY_PRIORITY: "low" }), "low");
  assert.equal(declaredPriority("high", { VORTEO_HEAVY_PRIORITY: "low" }), "high");
  assert.equal(priorityArgument(["--label", "--priority", "--priority=high"]), "high");
  assert.equal(priorityArgument(["--priority", "low", "--label", "x"]), "low");
  const dir = temp();
  for (const [args, extra, message] of [
    [["--priority", "urgent"], {}, /--priority urgent is refused/],
    [["--priority=urgent"], {}, /--priority urgent is refused/],
    [[], { VORTEO_HEAVY_PRIORITY: "urgent" }, /VORTEO_HEAVY_PRIORITY urgent is refused/],
    [[], { VORTEO_HEAVY_PRIORITY: "soon" }, /VORTEO_HEAVY_PRIORITY must be low, normal or high/],
    [["--priority", "soon"], {}, /--priority must be low, normal or high/],
    [["--priority=low", "--priority", "high"], {}, /more than once/],
    [["--priority-high"], {}, /unknown option --priority-high/],
    [["--priority"], {}, /--priority needs a value/],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/heavy-job.mjs"), "run", ...args, "--", "true"],
      {
        env: { ...process.env, VORTEO_HEAVY_QUEUE_DIR: path.join(dir, "queue"), ...extra },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 2, `${args} ${result.stderr}`);
    assert.match(result.stderr, message);
  }
  assert.equal(fs.existsSync(path.join(dir, "queue")), false, "a refused caller never queues");
});

test("memory, not load, defers a start", () => {
  const calm = { pressureLevel: 2, freePercent: 50, swapoutBytesPerSecond: 0 };
  assert.equal(memoryDeferral(calm), null, "routine warn pressure does not defer");
  assert.match(memoryDeferral({ ...calm, pressureLevel: 4 }), /critical memory pressure/);
  assert.match(memoryDeferral({ ...calm, freePercent: 5 }), /5% of memory is free/);
  assert.match(
    memoryDeferral({ ...calm, swapoutBytesPerSecond: 8 << 20 }),
    /swapping out 8\.0 MiB\/s/,
  );
});

test("heavy jobs run at background priority with capped test workers", () => {
  const mac = launchSpec(["npm", "test"], {
    platform: "darwin",
    env: { E2E_WORKERS: "3" },
  });
  assert.deepEqual(mac.argv, ["taskpolicy", "-b", "nice", "-n", "10", "npm", "test"]);
  assert.equal(mac.env.VITEST_MAX_WORKERS, "2");
  assert.equal(mac.env.E2E_WORKERS, "3", "an explicit caller setting wins");
  assert.equal(mac.env.VORTEO_HEAVY_JOB, "1", "nested callers can tell they hold the slot");
  assert.deepEqual(launchSpec(["x"], { platform: "linux", env: {} }).argv, [
    "nice",
    "-n",
    "10",
    "x",
  ]);
});

test("concurrent runs never overlap", async () => {
  const dir = temp();
  const log = path.join(dir, "log.txt");
  const env = {
    ...process.env,
    VORTEO_HEAVY_QUEUE_DIR: path.join(dir, "queue"),
    VORTEO_BUILDS_GATE_MARKER: path.join(dir, "none.json"),
    VORTEO_HEAVY_POLL_MS: "50",
  };
  const job = (name) =>
    new Promise((resolve) => {
      const script = `echo start-${name} >> "${log}"; sleep 0.3; echo end-${name} >> "${log}"`;
      const child = spawn(
        process.execPath,
        [path.resolve("scripts/heavy-job.mjs"), "run", "--", "sh", "-c", script],
        { env, stdio: "ignore" },
      );
      child.on("exit", resolve);
    });
  assert.deepEqual(await Promise.all([job("a"), job("b"), job("c")]), [0, 0, 0]);
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  for (let i = 0; i < lines.length; i += 2) {
    assert.equal(lines[i].replace("start-", ""), lines[i + 1].replace("end-", ""), lines.join(" "));
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, "queue")), [], "finished jobs release the slot");
});

// Reproduce a preempted caller publishing an older timestamp after the holder
// has passed its queue check. Both callers see themselves first without a lock.
test("late publication cannot steal a claimed slot, and dead owners are recoverable", () => {
  const dir = temp();
  const options = { gateMarker: path.join(dir, "none"), alive: () => true };
  const first = enqueue(dir, { now: 2000, pid: 1 });
  assert.equal(readQueue(dir, options)[0].file, first);
  const release = acquireSlot(dir);
  assert.equal(typeof release, "function");
  const late = enqueue(dir, { now: 1000, pid: 2 });
  assert.equal(readQueue(dir, options)[0].file, late, "queue snapshots can grant two holders");
  assert.equal(acquireSlot(dir), null, "an older ticket cannot overwrite the claimed slot");
  release();
  // Simulate death after claim publication. No timeout can evict a live owner.
  acquireSlot(dir, { pid: 123456789 });
  const recovered = acquireSlot(dir, {});
  assert.equal(typeof recovered, "function");
  recovered();
  acquireSlot(dir, { pid: 123456789 });
  const staleOwner = fs.readdirSync(path.join(dir, ".slot"))[0];
  let successor;
  assert.equal(
    acquireSlot(dir, {
      live: () => {
        // Pause stale cleanup until another reader has already recovered the slot.
        fs.rmSync(path.join(dir, ".slot", staleOwner));
        fs.rmdirSync(path.join(dir, ".slot"));
        successor = acquireSlot(dir);
        return false;
      },
    }),
    null,
    "a delayed stale reader cannot remove a successor's claim",
  );
  successor();
  assert.equal(fs.existsSync(path.join(dir, ".slot")), false);
});

test("a reused live PID with a different process or boot identity cannot hold the slot", () => {
  const dir = temp();
  const current = processIdentity(process.pid);
  fs.mkdirSync(path.join(dir, ".slot"));
  fs.writeFileSync(path.join(dir, ".slot", `${process.pid}-unversioned`), "");
  const isolated = acquireSlot(dir);
  assert.equal(
    typeof isolated,
    "function",
    "an isolated old-format PID claim has no live job ticket",
  );
  isolated();
  const parent = acquireSlot(dir);
  parent.addChild(current);
  parent();
  assert.equal(acquireSlot(dir), null, "exit cleanup preserves a still-live child entry");
  fs.rmSync(path.join(dir, ".slot"), { recursive: true });
  for (const identity of [
    { ...current, start: "previous incarnation" },
    { ...current, boot: "previous boot" },
  ]) {
    assert.equal(identityAlive(identity), false);
    acquireSlot(dir, { identity: () => identity });
    const release = acquireSlot(dir);
    assert.equal(typeof release, "function");
    release();
  }
});

function launchJob(
  root,
  name,
  {
    script = path.resolve("scripts/heavy-job.mjs"),
    preload,
    phase,
    duration = 300,
    finishMarker,
    priority,
    env,
  } = {},
) {
  const log = path.join(root, "events");
  const start = JSON.stringify(`start-${name}\n`);
  const end = JSON.stringify(`end-${name}\n`);
  const wait = finishMarker
    ? `const limit=Date.now()+60000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finishMarker)})||Date.now()>limit){clearInterval(timer);finish();}},10);`
    : `setTimeout(finish,${duration});`;
  const jobCode = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},${start});const finish=()=>fs.appendFileSync(${JSON.stringify(log)},${end});${wait}`;
  const child = spawn(
    process.execPath,
    [
      ...(preload ? ["--import", preload] : []),
      script,
      "run",
      ...(priority ? ["--priority", priority] : []),
      "--",
      process.execPath,
      "-e",
      jobCode,
    ],
    {
      env: {
        ...process.env,
        VORTEO_HEAVY_QUEUE_DIR: path.join(root, "queue"),
        VORTEO_BUILDS_GATE_MARKER: path.join(root, "none"),
        VORTEO_HEAVY_POLL_MS: "20",
        PROBE_ROOT: root,
        PROBE_PHASE: phase,
        ...env,
      },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 90000,
      killSignal: "SIGKILL",
    },
  );
  child.log = "";
  child.stderr.on("data", (chunk) => (child.log += chunk));
  child.done = new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
  return child;
}

function events(root) {
  try {
    return fs.readFileSync(path.join(root, "events"), "utf8").trim().split("\n");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function until(predicate) {
  const deadline = Date.now() + 45000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("heavy-job probe timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "wrapper death retains the running child's slot until its process group ends",
  { timeout: 90000 },
  async () => {
    const dir = temp();
    const finishMarker = path.join(dir, "finish-a");
    const a = launchJob(dir, "a", { finishMarker });
    await until(() => events(dir).includes("start-a"));
    const status = () =>
      execFileSync(process.execPath, [path.resolve("scripts/heavy-job.mjs"), "status"], {
        env: {
          ...process.env,
          VORTEO_HEAVY_QUEUE_DIR: path.join(dir, "queue"),
          VORTEO_BUILDS_GATE_MARKER: path.join(dir, "none"),
        },
        encoding: "utf8",
      })
        .trim()
        .split("\n");
    const running = status();
    assert.equal(running.length, 1, "guards and ticket render as one logical job");
    assert.match(running[0], new RegExp(`^1\\. running: .*pid ${a.pid}\\b`));
    const guard = fs
      .readdirSync(path.join(dir, "queue"))
      .map((name) =>
        name.endsWith(".json")
          ? JSON.parse(fs.readFileSync(path.join(dir, "queue", name), "utf8"))
          : null,
      )
      .find((ticket) => ticket?.identity?.group);
    a.kill("SIGKILL"); // Only this test's wrapper; its job deliberately keeps running.
    await a.done;
    const surviving = status();
    assert.equal(surviving.length, 1, "a surviving child still renders as one job");
    assert.match(surviving[0], new RegExp(`^1\\. running: .*pid ${guard.pid}\\b`));
    const b = launchJob(dir, "b");
    await until(() => fs.readdirSync(path.join(dir, "queue")).some((name) => /^\d/.test(name)));
    fs.writeFileSync(finishMarker, "");
    assert.equal(await b.done, 0);
    assert.deepEqual(events(dir), ["start-a", "end-a", "start-b", "end-b"]);
  },
);

test(
  "legacy interoperability protects both directions and demonstrates the accepted post-check window",
  { timeout: 180000 },
  async () => {
    const fixtures = temp();
    const legacy = path.join(fixtures, "legacy.mjs");
    const main = execFileSync("git", ["show", "origin/main:scripts/heavy-job.mjs"], {
      encoding: "utf8",
    });
    // Keep testing the old protocol after this fix itself reaches main.
    const source = main.includes("export function acquireSlot")
      ? execFileSync("git", [
          "show",
          "de622f701fac322885ec3a2fc26611a22e37e1d2:scripts/heavy-job.mjs",
        ])
      : main;
    fs.writeFileSync(legacy, source);
    fs.copyFileSync(
      path.resolve("scripts/is-main-module.mjs"),
      path.join(fixtures, "is-main-module.mjs"),
    );
    // Instrument only the external legacy subprocess to force the reviewer's
    // schedule. Production code and the test process retain their real adapters.
    const preload = path.join(fixtures, "pause.mjs");
    fs.writeFileSync(
      preload,
      `import fs from 'node:fs';
const root=process.env.PROBE_ROOT;
if(process.env.PROBE_PHASE==='post-check'){const now=Date.now;Date.now=()=>now()+60000;}
let paused=false;
function pause(){if(paused)return;paused=true;fs.writeFileSync(root+'/ready','');while(!fs.existsSync(root+'/go'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
const rename=fs.renameSync;
fs.renameSync=(from,to)=>{if(process.env.PROBE_PHASE==='publication'&&String(from).endsWith('.json.tmp'))pause();return rename(from,to);};
const write=fs.writeFileSync;
fs.writeFileSync=(file,data,...args)=>{if(['post-check','stalled'].includes(process.env.PROBE_PHASE)&&String(file).endsWith('.json')&&String(data).includes('startedAt'))pause();return write(file,data,...args);};`,
    );
    const holder = temp();
    const oldFirst = launchJob(holder, "old", { script: legacy, duration: 700 });
    await until(() => events(holder).includes("start-old"));
    const newSecond = launchJob(holder, "new");
    assert.deepEqual(await Promise.all([oldFirst.done, newSecond.done]), [0, 0]);
    assert.deepEqual(events(holder), ["start-old", "end-old", "start-new", "end-new"]);
    for (const phase of ["publication", "post-check"]) {
      const root = temp();
      const old = launchJob(root, "old", { script: legacy, preload, phase, duration: 100 });
      await until(() => fs.existsSync(path.join(root, "ready")));
      const finishMarker = phase === "post-check" ? path.join(root, "finish-new") : undefined;
      const fresh = launchJob(root, "new", { duration: 700, finishMarker });
      await until(() => events(root).includes("start-new"));
      fs.writeFileSync(path.join(root, "go"), "");
      if (finishMarker) {
        await until(() => events(root).includes("start-old"));
        fs.writeFileSync(finishMarker, "");
      }
      assert.deepEqual(await Promise.all([old.done, fresh.done]), [0, 0]);
      const lines = events(root);
      if (phase === "publication")
        assert.deepEqual(lines, ["start-new", "end-new", "start-old", "end-old"]);
      else assert.ok(lines.indexOf("start-old") < lines.indexOf("end-new"), lines.join(" "));
    }
    // The old caller has seen itself first and stalls before marking its start.
    // A later high-priority arrival must not jump ahead of it and run beside it.
    const root = temp();
    const old = launchJob(root, "old", {
      script: legacy,
      preload,
      phase: "stalled",
      duration: 100,
    });
    await until(() => fs.existsSync(path.join(root, "ready")));
    const high = launchJob(root, "new", { priority: "high", duration: 100 });
    await until(() => high.log.includes("Queued at position 2"));
    assert.deepEqual(events(root), [], "the high waiter stays behind the stalled old caller");
    fs.writeFileSync(path.join(root, "go"), "");
    assert.deepEqual(await Promise.all([old.done, high.done]), [0, 0]);
    assert.deepEqual(events(root), ["start-old", "end-old", "start-new", "end-new"]);
  },
);

test(
  "priorities order waiters across script versions, and a killed high waiter frees its place",
  { timeout: 90000 },
  async () => {
    const root = temp();
    const queue = path.join(root, "queue");
    const waiting = (pattern) => fs.readdirSync(queue).filter((name) => pattern.test(name)).length;
    // The last copy before priorities: it knows nothing of the new ticket names.
    const legacy = path.join(root, "legacy.mjs");
    fs.writeFileSync(
      legacy,
      execFileSync("git", [
        "show",
        "291de7db60b429b5692f7189f5c47d035dbd0093:scripts/heavy-job.mjs",
      ]),
    );
    fs.copyFileSync(
      path.resolve("scripts/is-main-module.mjs"),
      path.join(root, "is-main-module.mjs"),
    );
    const finishMarker = path.join(root, "finish-holder");
    const holder = launchJob(root, "holder", { finishMarker });
    await until(() => events(root).includes("start-holder"));
    const low = launchJob(root, "low", { priority: "low", duration: 50 });
    await until(() => waiting(/^low-/) === 1);
    const old = launchJob(root, "old", { script: legacy, duration: 50 });
    await until(() => waiting(/^\d/) === 2);
    const doomed = launchJob(root, "doomed", { priority: "high" });
    await until(() => doomed.log.includes("Queued at position"));
    assert.equal(waiting(/^\+1-high-/), 1);
    doomed.kill("SIGTERM"); // Only this test's own queued waiter.
    assert.equal(await doomed.done, 143);
    assert.equal(waiting(/^\+1-high-/), 0, "a killed waiter leaves no ticket");
    const high = launchJob(root, "high", { priority: "high", duration: 50 });
    await until(() => waiting(/^\+1-high-/) === 1);
    // A hand-written ticket in the reserved class, claiming a source this script never writes.
    const forged = path.join(queue, "+0-urgent-000000000000001-1.json");
    fs.writeFileSync(
      forged,
      JSON.stringify({ pid: process.pid, label: "forged", prioritySource: "daemon" }),
    );
    const status = execFileSync(
      process.execPath,
      [path.resolve("scripts/heavy-job.mjs"), "status"],
      {
        env: {
          ...process.env,
          VORTEO_HEAVY_QUEUE_DIR: queue,
          VORTEO_BUILDS_GATE_MARKER: path.join(root, "none"),
        },
        encoding: "utf8",
      },
    );
    assert.deepEqual(
      status
        .trim()
        .split("\n")
        .map((line) => /^\d\. (\w+): .*\[priority (.*)\]$/.exec(line)?.slice(1)),
      [
        ["running", "normal, declared"],
        ["queued", "urgent, unverified"],
        ["queued", "high, declared"],
        ["queued", "normal, legacy ticket"],
        ["queued", "low, declared"],
      ],
      status,
    );
    fs.rmSync(forged);
    fs.writeFileSync(finishMarker, "");
    assert.deepEqual(await Promise.all([holder.done, high.done, old.done, low.done]), [0, 0, 0, 0]);
    assert.deepEqual(
      events(root),
      ["holder", "high", "old", "low"].flatMap((name) => [`start-${name}`, `end-${name}`]),
    );
  },
);

test(
  "a gate that appears during the memory sample is honored, and an aged waiter cleans up its current ticket",
  { timeout: 90000 },
  async () => {
    const root = temp();
    const queue = path.join(root, "queue");
    const gateMarker = path.join(root, "none");
    const tickets = () => fs.readdirSync(queue).filter((name) => name.endsWith(".json"));
    // Alone in the queue, the waiter is first and spends one poll sampling memory.
    const first = launchJob(root, "first", { duration: 10, env: { VORTEO_HEAVY_POLL_MS: "1000" } });
    await until(() => fs.existsSync(queue) && tickets().length === 1);
    fs.writeFileSync(gateMarker, JSON.stringify({ pid: process.pid }));
    await until(() => first.log.includes("waiting for Builds install gate"));
    assert.deepEqual(events(root), [], "nothing starts behind a live gate");
    fs.rmSync(gateMarker);
    assert.equal(await first.done, 0);
    assert.deepEqual(tickets(), []);

    // No other process reads this queue, so only the waiter can remove its ticket.
    fs.writeFileSync(gateMarker, JSON.stringify({ pid: process.pid }));
    const aged = launchJob(root, "aged", { priority: "low", env: { VORTEO_HEAVY_AGE_MS: "1" } });
    await until(() => aged.log.includes("move up to normal priority"));
    await until(() => aged.log.includes("waiting for Builds install gate"));
    assert.deepEqual(tickets().map(ticketPriority), ["normal"]);
    aged.kill("SIGTERM"); // Only this test's own queued waiter.
    assert.equal(await aged.done, 143);
    assert.deepEqual(tickets(), [], "the ticket is removed under its current name");
    assert.deepEqual(events(root), ["start-first", "end-first"]);
  },
);

test(
  "foreground contract releases the slot when the original group ends, excluding setsid descendants",
  { timeout: 90000 },
  async () => {
    const dir = temp();
    const log = path.join(dir, "events");
    const finish = path.join(dir, "finish-grandchild");
    const code = `import os,time
pid=os.fork()
if pid==0:
 os.setsid()
 with open(${JSON.stringify(log)},'a') as f: f.write('start-grandchild\\n')
 deadline=time.monotonic()+60
 while not os.path.exists(${JSON.stringify(finish)}) and time.monotonic()<deadline: time.sleep(0.01)
 with open(${JSON.stringify(log)},'a') as f: f.write('end-grandchild\\n')
 os._exit(0)
while not os.path.exists(${JSON.stringify(log)}): time.sleep(0.01)
os._exit(0)`;
    const a = spawn(
      process.execPath,
      [path.resolve("scripts/heavy-job.mjs"), "run", "--", "python3", "-c", code],
      {
        env: {
          ...process.env,
          VORTEO_HEAVY_QUEUE_DIR: path.join(dir, "queue"),
          VORTEO_BUILDS_GATE_MARKER: path.join(dir, "none"),
          VORTEO_HEAVY_POLL_MS: "20",
        },
        stdio: "ignore",
        timeout: 90000,
        killSignal: "SIGKILL",
      },
    );
    const done = new Promise((resolve, reject) => {
      a.once("exit", resolve);
      a.once("error", reject);
    });
    try {
      await until(() => events(dir).includes("start-grandchild"));
      assert.equal(await done, 0);
      const b = launchJob(dir, "b");
      assert.equal(await b.done, 0);
      assert.deepEqual(events(dir), ["start-grandchild", "start-b", "end-b"]);
    } finally {
      fs.writeFileSync(finish, "");
    }
    await until(() => events(dir).includes("end-grandchild"));
  },
);
