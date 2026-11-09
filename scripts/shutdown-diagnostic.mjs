import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.VORTEO_SHUTDOWN_DIAGNOSTIC_DIR;
if (!output) throw new Error("VORTEO_SHUTDOWN_DIAGNOSTIC_DIR is required");
if (process.version !== "v22.23.4") throw new Error("Diagnostic requires Node 22.23.4");
await mkdir(output, { recursive: true });
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
try {
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(
      "npx",
      ["tsx", join(root, "packages/cli/tests/22-daemon-stop-supervisor.test.ts")],
      {
        cwd: join(root, "packages/cli"),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
  await new Promise((done) => log.end(done));
  await rm(npmCache, { recursive: true, force: true });
  await rm(osHome, { recursive: true, force: true });
}
