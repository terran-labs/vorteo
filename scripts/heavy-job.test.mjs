import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enqueue, launchSpec, memoryDeferral, readQueue } from "./heavy-job.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "heavy-job-"));

test("the queue grants in arrival order, prunes exited holders and puts a live gate first", () => {
  const dir = temp();
  const gateMarker = path.join(dir, "gate.json");
  const alive = (pid) => pid !== 2;
  enqueue(dir, { label: "late", pid: 3, now: 2_000 });
  enqueue(dir, { label: "dead", pid: 2, now: 500 });
  enqueue(dir, { label: "early", pid: 1, now: 1_000 });
  assert.deepEqual(
    readQueue(dir, { gateMarker, alive }).map((entry) => entry.label),
    ["early", "late"],
  );
  assert.equal(fs.readdirSync(dir).length, 2, "the exited holder's ticket is removed");

  fs.writeFileSync(gateMarker, JSON.stringify({ pid: 4 }));
  assert.equal(readQueue(dir, { gateMarker, alive })[0].label, "Builds install gate");
  fs.writeFileSync(gateMarker, JSON.stringify({ pid: 2 }));
  assert.equal(readQueue(dir, { gateMarker, alive })[0].label, "early");
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
