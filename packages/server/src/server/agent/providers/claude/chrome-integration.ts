import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude Code registers this native messaging host when Chrome integration is first enabled.
// The Claude in Chrome extension reaches the CLI through it, so without it `--chrome` has
// nothing to connect to.
export const CLAUDE_CHROME_NATIVE_HOST_MANIFEST =
  "com.anthropic.claude_code_browser_extension.json";

/** NativeMessagingHosts directories for the Chromium browsers the extension supports. */
export function claudeChromeNativeHostDirectories(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string[] {
  if (platform === "darwin") {
    const support = path.join(homeDir, "Library", "Application Support");
    return [
      "Google/Chrome",
      "Google/Chrome Beta",
      "Google/Chrome Canary",
      "Chromium",
      "BraveSoftware/Brave-Browser",
      "Microsoft Edge",
    ].map((browser) => path.join(support, browser, "NativeMessagingHosts"));
  }
  if (platform === "linux") {
    const config = path.join(homeDir, ".config");
    return ["google-chrome", "google-chrome-beta", "chromium", "BraveSoftware/Brave-Browser"].map(
      (browser) => path.join(config, browser, "NativeMessagingHosts"),
    );
  }
  // Windows registers native hosts in the registry; not detected here.
  return [];
}

/**
 * Whether this machine can bridge a Claude session to the owner's browser. Containers and
 * machines without the extension have no manifest, so the Chrome toggle stays hidden there.
 */
export function isClaudeChromeBridgeInstalled(
  directories: string[] = claudeChromeNativeHostDirectories(),
): boolean {
  return directories.some((directory) =>
    fs.existsSync(path.join(directory, CLAUDE_CHROME_NATIVE_HOST_MANIFEST)),
  );
}
