import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build, run } from "./primitives.mjs";

test("a private build log receives stdout and stderr before the child exits", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "vorteo-build-output-"));
  const log = path.join(directory, "build.log");
  let sawLiveOutput = false;
  try {
    await build(
      process.execPath,
      [
        "-e",
        "console.log('building'); console.error('diagnostic'); setTimeout(() => console.log('finished'), 100);",
      ],
      directory,
      log,
      {},
      (command, args, options) =>
        run(command, args, {
          ...options,
          onOutput(chunk) {
            options.onOutput(chunk);
            const contents = readFileSync(log, "utf8");
            if (contents.includes("building") && !contents.includes("finished"))
              sawLiveOutput = true;
          },
        }),
    );
    assert.ok(sawLiveOutput);
    assert.match(readFileSync(log, "utf8"), /diagnostic/);
    assert.equal(statSync(log).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a logging failure rejects the command instead of throwing from an event listener", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "console.log('hello'); setTimeout(() => {}, 10000)"], {
      onOutput() {
        throw new Error("log unavailable");
      },
    }),
    /log unavailable/,
  );
});
