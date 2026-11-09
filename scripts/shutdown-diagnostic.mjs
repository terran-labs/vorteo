import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, availableParallelism, cpus } from "node:os";
import { delimiter, join, resolve } from "node:path";
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
  throw new Error("Contention diagnostic is restricted to GitHub-hosted Linux");
}
const cpuCount = availableParallelism();
if (cpuCount < 2 || cpuCount > 4)
  throw new Error(`Expected 2 to 4 available CPUs, got ${cpuCount}; no experiment started`);
const workerCount = cpuCount * 2;
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "contention.json"),
  JSON.stringify(
    {
      cpuCount,
      reportedCpuCount: cpus().length,
      workerCount,
      workerLifetimeMs: 180000,
      parentKillMs: 185000,
    },
    null,
    2,
  ) + "\n",
);
const npmCache = await mkdtemp(join(tmpdir(), "paseo-cli-test-npm-cache-"));
const osHome = await mkdtemp(join(tmpdir(), "paseo-cli-test-os-home-"));
const log = createWriteStream(join(output, "run.log"));
// Match run-all.ts isolation without executing its other tests or its worker pool.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_"))),
  HOME: osHome,
  USERPROFILE: osHome,
  PATH: [join(root, "node_modules", ".bin"), process.env.PATH].filter(Boolean).join(delimiter),
  npm_config_cache: npmCache,
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  PASEO_DICTATION_ENABLED: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
  VORTEO_SHUTDOWN_DIAGNOSTIC_DIR: resolve(output),
};
const workers = [];
const workerExits = [];
let testChild;
let interrupted = false;
const stopWorkers = () => {
  for (const child of workers)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};
const onTermination = () => {
  interrupted = true;
  stopWorkers();
  if (testChild?.pid && testChild.exitCode === null && testChild.signalCode === null) {
    try {
      process.kill(-testChild.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
};
process.once("SIGTERM", onTermination);
process.once("SIGINT", onTermination);
const workerLimit = setTimeout(stopWorkers, 185_000);
workerLimit.unref();
try {
  for (let i = 0; i < workerCount; i++) {
    const child = spawn(process.execPath, [join(root, "scripts/shutdown-contention-worker.mjs")], {
      env,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    workers.push(child);
    workerExits.push(
      new Promise((done) =>
        child.once("close", (code, signal) =>
          done({
            pid: child.pid,
            code,
            signal,
            closedAt: new Date().toISOString(),
            monoMs: performance.now(),
          }),
        ),
      ),
    );
    await new Promise((ready, reject) => {
      const deadline = setTimeout(() => reject(new Error("CPU worker readiness timed out")), 5000);
      child.once("message", (message) => {
        log.write(
          JSON.stringify({
            phase: "cpu-worker-ready",
            message,
            at: new Date().toISOString(),
            monoMs: performance.now(),
          }) + "\n",
        );
        clearTimeout(deadline);
        ready();
      });
      child.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(deadline);
        reject(new Error("CPU worker exited before readiness"));
      });
    });
  }
  if (interrupted) throw new Error("Diagnostic interrupted before test start");
  if (workers.some((child) => child.exitCode !== null || child.signalCode !== null)) {
    throw new Error("CPU worker exited before test start; experiment not started");
  }
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(
      "npx",
      ["tsx", join(root, "packages/cli/tests/22-daemon-stop-supervisor.test.ts")],
      {
        cwd: join(root, "packages/cli"),
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    testChild = child;
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      log.write(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolveExit({ exitCode, signal }));
  });
  await writeFile(join(output, "exit.json"), JSON.stringify(code, null, 2) + "\n");
  process.exitCode = code.exitCode ?? 1;
} finally {
  clearTimeout(workerLimit);
  stopWorkers();
  const workerResults = await Promise.all(workerExits);
  await writeFile(
    join(output, "contention-cleanup.json"),
    JSON.stringify(workerResults, null, 2) + "\n",
  );
  process.removeListener("SIGTERM", onTermination);
  process.removeListener("SIGINT", onTermination);
  await new Promise((done) => log.end(done));
  await rm(npmCache, { recursive: true, force: true });
  await rm(osHome, { recursive: true, force: true });
}
