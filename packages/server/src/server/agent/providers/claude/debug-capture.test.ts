import { expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAUDE_DEBUG_LOGS_SETTINGS_FILE } from "./account-starts.js";
import { openClaudeDebugCapture } from "./debug-capture.js";

// Synthetic values only; nothing here is a real credential.
const FAKE_TOKEN = "zzFAKEtokenVALUEnotREAL0123456789abcdefABCDEF";
const ACCOUNT = "claude-account-test";

async function withHome(
  run: (input: { root: string; home: string; configDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "claude-debug-capture-"));
  try {
    const home = path.join(root, "home");
    await mkdir(home, { mode: 0o700 });
    await run({ root, home, configDir: path.join(root, ACCOUNT) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function optIn(home: string, settings: unknown): Promise<void> {
  await writeFile(path.join(home, CLAUDE_DEBUG_LOGS_SETTINGS_FILE), JSON.stringify(settings), {
    mode: 0o600,
  });
}

test("capture stays off unless the exact account is listed", async () => {
  await withHome(async ({ home, configDir }) => {
    const env = { PASEO_HOME: home };
    expect(await openClaudeDebugCapture({ configDir, env })).toBeNull();
    await optIn(home, { enabled: true });
    expect(await openClaudeDebugCapture({ configDir, env })).toBeNull();
    await optIn(home, { enabled: true, accounts: ["claude-account-other"] });
    expect(await openClaudeDebugCapture({ configDir, env })).toBeNull();
    await expect(stat(path.join(home, "logs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("a symlinked log directory refuses capture", async () => {
  await withHome(async ({ root, home, configDir }) => {
    await optIn(home, { enabled: true, accounts: [ACCOUNT] });
    const target = path.join(root, "elsewhere");
    await mkdir(target, { mode: 0o700 });
    await mkdir(path.join(home, "logs"), { mode: 0o700 });
    await symlink(target, path.join(home, "logs", "claude-debug"));
    const errors: unknown[] = [];
    const capture = await openClaudeDebugCapture({
      configDir,
      env: { PASEO_HOME: home },
      onError: (error) => errors.push(error),
    });
    expect(capture).toBeNull();
    expect(errors).toHaveLength(1);
    expect(await readdir(target)).toEqual([]);
  });
});

test("debug lines go to a private file with credentials removed; other stderr passes through", async () => {
  await withHome(async ({ home, configDir }) => {
    await optIn(home, { enabled: true, accounts: [ACCOUNT] });
    const capture = await openClaudeDebugCapture({ configDir, env: { PASEO_HOME: home } });
    if (!capture) throw new Error("expected a capture");
    const ts = "2026-11-12T23:58:49.123Z";
    const stream = [
      `${ts} [DEBUG] OAuth refresh starting for person@example.com\n`,
      `${ts} [DEBUG] Token refresh failed: invalid_grant refresh=${FAKE_TOKEN}\n`,
      `${ts} [DEBUG] sending Authorization: Bearer ${FAKE_TOKEN}\n`,
      `${ts} [DEBUG] MCP server "x": rendered a prompt\n`,
      "Error: ordinary stderr survives\n",
      `${ts} [ERROR] 401 OAuth access token has been revoked\npartial ordinary`,
    ].join("");
    // Split mid-line to prove line buffering.
    let passthrough = "";
    for (let i = 0; i < stream.length; i += 37)
      passthrough += capture.accept(stream.slice(i, i + 37));
    passthrough += capture.close();
    await capture.closed;

    expect(passthrough).toBe("Error: ordinary stderr survives\npartial ordinary");
    const dir = path.dirname(capture.filePath);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(capture.filePath)).mode & 0o777).toBe(0o600);
    const written = await readFile(capture.filePath, "utf8");
    expect(written).not.toContain(FAKE_TOKEN);
    expect(written).not.toContain("person@example.com");
    expect(written.trim().split("\n")).toEqual([
      `${ts} [DEBUG] OAuth refresh starting for [email]`,
      `${ts} [DEBUG] Token refresh failed: invalid_grant [redacted]`,
      `${ts} [ERROR] 401 OAuth access token has been revoked`,
    ]);
  });
});
