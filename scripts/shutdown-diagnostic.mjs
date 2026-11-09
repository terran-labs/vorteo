import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism, cpus } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.VORTEO_SHUTDOWN_DIAGNOSTIC_DIR;
if (!output) throw new Error("VORTEO_SHUTDOWN_DIAGNOSTIC_DIR is required");
if (process.version !== "v22.23.4") throw new Error("Diagnostic requires Node 22.23.4");
if (
  process.platform !== "linux" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted"
) {
  throw new Error("Shard diagnostic is restricted to GitHub-hosted Linux");
}
await mkdir(output, { recursive: true });
const command = ["run", "test:local", "--workspace=@getpaseo/cli"];
await writeFile(
  join(output, "shard.json"),
  JSON.stringify(
    {
      command: ["npm", ...command],
      cpuCount: availableParallelism(),
      reportedCpuCount: cpus().length,
      shard: 3,
      shardTotal: 3,
      concurrency: 4,
      outerDeadlineMs: 710000,
      terminationGraceMs: 5000,
    },
    null,
    2,
  ) + "\n",
);
const log = createWriteStream(join(output, "run.log"));
// The original runner owns HOME, cache, PATH and PASEO_ filtering for each test.
const child = spawn("npm", command, {
  cwd: root,
  detached: true,
  env: {
    ...process.env,
    PASEO_PREBUILT_SERVER_STACK: "1",
    PASEO_CLI_TEST_SHARD: "3",
    PASEO_CLI_TEST_SHARD_TOTAL: "3",
    PASEO_CLI_TEST_CONCURRENCY: "4",
    VORTEO_SHUTDOWN_DIAGNOSTIC_DIR: resolve(output),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let timedOut = false;
let interrupted = false;
let killTimer;
function signalGroup(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function terminate() {
  signalGroup("SIGTERM");
  if (!killTimer) killTimer = setTimeout(() => signalGroup("SIGKILL"), 5000);
}
const onTermination = () => {
  interrupted = true;
  terminate();
};
process.once("SIGTERM", onTermination);
process.once("SIGINT", onTermination);
const deadline = setTimeout(() => {
  timedOut = true;
  terminate();
}, 710000);
child.stdout.on("data", (chunk) => {
  log.write(chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  log.write(chunk);
  process.stderr.write(chunk);
});
try {
  const result = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => done({ exitCode, signal }));
  });
  await writeFile(
    join(output, "exit.json"),
    JSON.stringify({ ...result, timedOut, interrupted }, null, 2) + "\n",
  );
  process.exitCode = timedOut || interrupted ? 1 : (result.exitCode ?? 1);
} finally {
  if (timedOut || interrupted) signalGroup("SIGKILL");
  clearTimeout(deadline);
  clearTimeout(killTimer);
  process.removeListener("SIGTERM", onTermination);
  process.removeListener("SIGINT", onTermination);
  await new Promise((done) => log.end(done));
}
