// Agent shells on a managed Host inherit variables that describe that Host: its installation
// client, its daemon home and the calling agent. A spec launched from such a shell must not
// hand them to its isolated daemons, CLIs or Metro, or every createAgent fails with
// "Installation settings migration is incomplete" and CLI calls can reach the real Host.
// Playwright loads its config in the runner and every worker, so scrubbing here covers
// every child process. Specs that need one of these variables pass it explicitly.
const HOST_VARIABLES = new Set([
  "VORTEO_INSTALLATION_CLIENT_CONFIG",
  "VORTEO_CLAUDE_SIGN_IN",
  "VORTEO_BUILDS",
  "VORTEO_RESTART_JOB_ID",
  "VORTEO_RESTART_FORCE",
  "VORTEO_CLAIMED_LOCK_FD",
  "VORTEO_PRECLAIM_LOCK_FD",
  "VORTEO_BOOTSTRAP_LOCK_FD",
  "PASEO_HOME",
  "PASEO_SERVER_ID",
  "PASEO_LISTEN",
]);
const HOST_VARIABLE_PREFIXES = ["PASEO_AGENT_"];

export function stripHostEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (HOST_VARIABLES.has(key) || HOST_VARIABLE_PREFIXES.some((p) => key.startsWith(p))) {
      delete env[key];
    }
  }
}
