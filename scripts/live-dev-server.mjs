#!/usr/bin/env node
// Run the Expo web dev server for an installation's live dev mode. The installation
// coordinator starts this from the live checkout and proxies it to the owner's browser.
// See docs/live-dev-mode.md.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const origin = new URL(process.env.PASEO_LIVE_DEV_ORIGIN ?? "");
if (
  origin.protocol !== "https:" ||
  !origin.hostname.endsWith(".ts.net") ||
  origin.origin !== process.env.PASEO_LIVE_DEV_ORIGIN
)
  throw new Error("Live dev mode requires the installation's private HTTPS origin");
const port = Number(process.env.PASEO_LIVE_DEV_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PASEO_LIVE_DEV_PORT required");
const require = createRequire(import.meta.url);
const cli = require.resolve("@expo/cli");
const server = new URL("../src/start/server/metro/runServer-fork.js", `file://${cli}`);
// The patch binds loopback and refuses any Host or Origin except the installation's own.
if (!readFileSync(server, "utf8").includes("PASEO_LIVE_PREVIEW_ORIGIN"))
  throw new Error("Apply repository dependency patches before starting live dev mode");

// The page learns its daemon from the coordinator's injected hint, never from build-time values.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("EXPO_PUBLIC_")) delete process.env[key];
}
process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL = "Live dev";
process.env.EXPO_NO_DOTENV = "1";
process.env.EXPO_NO_TELEMETRY = "1";
process.env.EXPO_OFFLINE = "1";
process.env.BROWSER = "none";
// CI mode would disable file watching, which is the whole point.
delete process.env.CI;
process.env.PASEO_LIVE_PREVIEW_ORIGIN = origin.origin;
process.env.EXPO_PACKAGER_PROXY_URL = origin.origin;
// Edits to shared protocol and client source must reach the bundle too, as `npm run web` does.
// The watchers share this process group, so stopping the server stops them.
const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const watchers = ["watch:protocol", "watch:client"].map((script) =>
  spawn(npm, ["run", script], { cwd: root, stdio: "inherit", env: process.env }),
);
process.on("exit", () => {
  for (const watcher of watchers) watcher.kill("SIGTERM");
});
process.chdir(fileURLToPath(new URL("../packages/app", import.meta.url)));
process.argv = [process.execPath, cli, "start", "--web", "--localhost", "--port", String(port)];
require(cli);
