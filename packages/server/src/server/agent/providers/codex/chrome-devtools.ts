import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Pinned so a Chrome-enabled thread never picks up an unreviewed release of a tool that drives
// the owner's logged-in browser. Bump deliberately.
export const CODEX_CHROME_DEVTOOLS_MCP_PACKAGE = "chrome-devtools-mcp@1.12.0";
export const CODEX_CHROME_MCP_SERVER_NAME = "chrome-devtools";

/**
 * Google Chrome's stable user data directory. `chrome-devtools-mcp --autoConnect` attaches to
 * the Chrome running from it once the owner turns on remote debugging at
 * chrome://inspect/#remote-debugging, which writes DevToolsActivePort there.
 */
export function chromeUserDataDirectory(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string | null {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
  }
  if (platform === "linux") return path.join(homeDir, ".config", "google-chrome");
  return null;
}

/**
 * Whether the owner's Chrome lives on this machine. Containers have no Chrome profile, so the
 * toggle stays hidden there. Remote debugging may still be off; the MCP server then reports
 * that it cannot find DevToolsActivePort, which tells the agent what the owner must enable.
 */
export function isChromeAvailableForCodex(
  directory: string | null = chromeUserDataDirectory(),
): boolean {
  return directory !== null && fs.existsSync(directory);
}

/**
 * Launches the pinned package through the daemon's own Node and npx, because a daemon started
 * by a service manager may not have a version-managed Node on its PATH.
 */
export function buildChromeDevtoolsMcpServer(nodePath: string = process.execPath): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const nodeBin = path.dirname(nodePath);
  const npx = path.join(nodeBin, "npx");
  const npxCli = fs.existsSync(npx) ? fs.realpathSync(npx) : null;
  return {
    command: npxCli ? nodePath : "npx",
    args: [
      ...(npxCli ? [npxCli] : []),
      "-y",
      CODEX_CHROME_DEVTOOLS_MCP_PACKAGE,
      "--autoConnect",
      // The server reads the owner's logged-in sessions; keep its telemetry and CrUX lookups,
      // which send page URLs to Google, off.
      "--no-usage-statistics",
      "--no-performance-crux",
    ],
    env: { PATH: [nodeBin, process.env.PATH].filter(Boolean).join(path.delimiter) },
  };
}
