import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RENDER_TIMEOUT_MS = 45_000;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Render one frozen snapshot to a PNG with the optional headless Chromium, restricted to
 * `allowedPrefix` (that snapshot's own loopback route), one render at a time, in a
 * separate short-lived process (see thumbnail-worker). Rejects when the browser package or
 * a Chromium build is missing, or the render fails; callers treat that as "no thumbnail".
 */
export function renderThumbnail(
  url: string,
  outputPath: string,
  allowedPrefix: string,
): Promise<void> {
  const run = queue.then(() => render(url, outputPath, allowedPrefix));
  queue = run.catch(() => undefined);
  return run;
}

function render(url: string, outputPath: string, allowedPrefix: string): Promise<void> {
  const self = fileURLToPath(import.meta.url);
  // Same directory and extension as this module, so it works from source and from the build.
  const worker = path.join(path.dirname(self), `thumbnail-worker${path.extname(self)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, worker, url, outputPath, allowedPrefix],
      {
        stdio: ["ignore", "ignore", "pipe"],
        // The renderer loads agent-authored pages. It gets no daemon secrets from the environment.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH
            ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
            : {}),
          ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep the end of the output: a failed launch prints its long argument list first
      // and the actual reason last.
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), RENDER_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(new Error(stderr.trim().slice(-1500) || `Thumbnail renderer exited with ${code}`));
    });
  });
}
