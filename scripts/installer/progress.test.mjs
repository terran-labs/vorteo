import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, exitStatus } from "./progress.mjs";

const progressScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "progress.mjs");

function render(lines, options = {}) {
  let output = "";
  const renderer = createRenderer({ write: (text) => (output += text), ...options });
  for (const line of lines) renderer.handle(typeof line === "string" ? line : JSON.stringify(line));
  return { output, state: renderer.finish() };
}

describe("installer progress", () => {
  test("renders steps, skips and plain output as tidy lines", () => {
    const { output, state } = render([
      { step: "identity", status: "start", message: "Creating the identity" },
      {
        step: "identity",
        status: "done",
        message: "Created the identity",
        fix: "Check Dev connectivity.",
      },
      { step: "dev", status: "skip", message: "Dev container" },
      "docker: pulling layer",
      { result: { origin: "https://vorteo.example.ts.net" } },
    ]);
    assert.equal(
      output,
      [
        "  … Creating the identity",
        "  ✓ Created the identity",
        "    Note: Check Dev connectivity.",
        "  · Dev container (skipped)",
        "    docker: pulling layer",
        "",
      ].join("\n"),
    );
    assert.equal(exitStatus(state), 0);
  });

  test("a failed step shows its fix and fails", () => {
    const { output, state } = render([
      { step: "host", status: "start", message: "Starting the Host" },
      { step: "host", status: "fail", message: "Starting the Host failed", fix: "Free port 6790." },
    ]);
    assert.match(output, /✗ Starting the Host failed\n {4}Fix: Free port 6790\.\n$/);
    assert.equal(exitStatus(state), 1);
  });

  test("a stream that ends without a result counts as stopped early", () => {
    const { state } = render([{ step: "host", status: "done", message: "Started" }]);
    assert.equal(exitStatus(state), 2);
    assert.equal(exitStatus(state, { expectResult: false }), 0);
  });

  test("on a terminal the spinner line is replaced when the step ends", () => {
    const { output } = render(
      [
        { step: "host", status: "start", message: "Starting the Host" },
        { step: "host", status: "done", message: "Started the Host" },
      ],
      { animate: true },
    );
    assert.ok(output.startsWith("\r  ⠋ 0:00 elapsed | Total 0:00 | Starting the Host"));
    assert.ok(output.endsWith("\r\u001b[K  ✓ Started the Host\n"));
  });

  test("the command writes the result file and reports the exit status", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vorteo-progress-"));
    try {
      const resultFile = path.join(dir, "result.json");
      const ok = spawnSync(process.execPath, [progressScript, "--result", resultFile], {
        input: `${JSON.stringify({ result: { name: "Vorteo" } })}\n`,
        encoding: "utf8",
      });
      assert.equal(ok.status, 0);
      assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), { name: "Vorteo" });
      const failed = spawnSync(process.execPath, [progressScript], {
        input: `${JSON.stringify({ step: "x", status: "fail", message: "Broke" })}\n`,
        encoding: "utf8",
      });
      assert.equal(failed.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("live progress reports elapsed time and quiet output without claiming a stall", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
  let output = "";
  const renderer = createRenderer({
    write: (text) => (output += text),
    animate: true,
  });
  renderer.handle(
    JSON.stringify({
      step: "dev-images",
      status: "start",
      message: "Building",
      index: 3,
      total: 12,
    }),
  );
  t.mock.timers.tick(65000);
  assert.match(output, /3\/12.*1:05 elapsed.*Building/);
  renderer.handle(
    JSON.stringify({
      step: "dev-images",
      status: "progress",
      detail: "Docker stage build 4/8",
      outputBytes: 1024,
    }),
  );
  t.mock.timers.tick(2000);
  assert.match(output, /Docker stage build 4\/8/);
  assert.match(output, /last output 0:02 ago/);
  renderer.handle(JSON.stringify({ step: "dev-images", status: "done", message: "Built" }));
  const finished = output;
  t.mock.timers.tick(30000);
  assert.equal(output, finished);
  renderer.handle(JSON.stringify({ step: "release", status: "start", message: "Next phase" }));
  assert.match(output, /0:00 elapsed \| Total 1:37 \| Next phase/);
  renderer.finish();
});

test("redirected progress prints periodic heartbeats and stops at EOF", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
  let output = "";
  const renderer = createRenderer({ write: (text) => (output += text), banner: true });
  renderer.handle(
    JSON.stringify({ step: "upgrade-release", status: "start", message: "Building" }),
  );
  t.mock.timers.tick(30000);
  assert.match(output, /0:30 elapsed/);
  assert.ok(!output.includes("\u001b"));
  renderer.finish();
  const ended = output;
  t.mock.timers.tick(30000);
  assert.equal(output, ended);
});

test("a narrow terminal keeps the counter and latest Docker stage visible", () => {
  let output = "";
  const renderer = createRenderer({
    write: (text) => (output += text),
    animate: true,
    columns: () => 60,
  });
  renderer.handle(
    JSON.stringify({
      status: "start",
      message: "Building the Dev container image and network gate",
      index: 4,
      total: 15,
    }),
  );
  renderer.handle(
    JSON.stringify({
      status: "progress",
      detail: "Docker stage build 4/8",
      outputBytes: 10,
    }),
  );
  const last = output.split("\r").at(-1).replaceAll("\u001b[K", "");
  assert.match(last, /4\/15.*0:00 elapsed.*build 4\/8/);
  assert.ok(last.length < 60);
  renderer.finish();
});

for (const step of ["release", "upgrade-release", "upgrade-dev-build"]) {
  test(`${step} animation preserves ordinary output across resize and stops before prompts`, (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
    for (const completion of [
      { step, status: "done", message: "Built" },
      { step, status: "fail", message: "Build failed" },
      { result: { name: "Vorteo" } },
      null,
    ]) {
      let output = "";
      let columns = 120;
      let rows = 40;
      const renderer = createRenderer({
        write: (text) => (output += text),
        animate: true,
        banner: true,
        columns: () => columns,
        rows: () => rows,
      });
      renderer.handle(JSON.stringify({ step, status: "start", message: "Building" }));
      assert.equal(output.split("\u001b[?1049h").length - 1, 1);
      columns = 40;
      rows = 10;
      t.mock.timers.tick(1000);
      assert.match(output, /Phase 0:01/);
      columns = 100;
      rows = 35;
      t.mock.timers.tick(1000);
      assert.equal(output.split("\u001b[?1049h").length - 1, 1);
      if (completion) renderer.handle(JSON.stringify(completion));
      renderer.finish();
      assert.equal(output.split("\u001b[?1049l").length - 1, 1);
      const stopped = output;
      t.mock.timers.tick(1000);
      assert.equal(output, stopped);
    }
  });
}

test("demo walks every installation step with five minutes of simulated build time", async () => {
  const { runDemo } = await import("./demo.mjs");
  const { planSteps, STEP_TITLES } = await import("./flow.mjs");
  let output = "";
  let buildWait = 0;
  await runDemo({
    write: (text) => {
      output += text;
    },
    interactive: false,
    wait: async (ms) => {
      if (ms !== 250) buildWait += ms;
    },
  });
  assert.equal(buildWait, 300_000);
  for (const step of planSteps({ devContainer: true, adopt: false, remote: "tailscale" }))
    assert.ok(output.includes(STEP_TITLES[step]), step);
  assert.ok(output.includes("Nothing was changed"));
  let waited = false;
  await runDemo({
    write: () => {},
    interactive: false,
    ask: async (prompt) => (prompt.startsWith("Proceed") ? "no" : ""),
    wait: async () => {
      waited = true;
    },
  });
  assert.equal(waited, false);
});
