import { performance } from "node:perf_hooks";

if (
  process.platform !== "linux" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted"
) {
  throw new Error("CPU contention is restricted to an isolated GitHub-hosted Linux runner");
}
const stopAt = performance.now() + 180_000;
process.send({ ready: true, pid: process.pid, stopAt });
// No provider calls, disk traffic or allocations proportional to runtime.
let accumulator = 1;
while (performance.now() < stopAt && process.connected) {
  for (let i = 0; i < 100_000; i++) accumulator = Math.imul(accumulator + i, 1664525);
}
if (process.connected) {
  process.send({ finished: true, accumulator, monoMs: performance.now() });
  process.disconnect();
}
