import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CODEX_REFRESH_LEAD_MS,
  codexAccessProjection,
  createCodexHostCli,
  jwtExpiry,
  needsCodexHostRefresh,
  readCodexHostGrant,
  verifyCodexHostSession,
} from "./codex-signin-host.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "codex-signin-host-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** An unsigned synthetic JWT; only its `exp` claim matters here. */
function jwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.synthetic`;
}
const EXP = 2_000_000_000;

function writeAuth(directory: string, value: unknown, mode = 0o600) {
  writeFileSync(join(directory, "auth.json"), JSON.stringify(value), { mode });
  chmodSync(join(directory, "auth.json"), mode);
}
const auth = {
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "synthetic-id",
    access_token: jwt({ exp: EXP }),
    refresh_token: "synthetic-refresh",
    account_id: "workspace-1",
  },
  last_refresh: "2026-10-20T00:00:00Z",
};

it("reads the Host grant and projects it without the refresh token", async () => {
  const directory = await home();
  writeAuth(directory, auth);
  const grant = readCodexHostGrant(directory);
  expect(grant).toMatchObject({
    idToken: "synthetic-id",
    accountId: "workspace-1",
    hasRefreshToken: true,
    expiresAt: EXP * 1000,
    lastRefresh: "2026-10-20T00:00:00Z",
  });
  expect(JSON.stringify(grant)).not.toContain("synthetic-refresh");
  const projection = codexAccessProjection(grant);
  expect(projection).toEqual({
    accessToken: auth.tokens.access_token,
    idToken: "synthetic-id",
    accountId: "workspace-1",
    expiresAt: EXP * 1000,
    lastRefresh: "2026-10-20T00:00:00Z",
  });
});

it("refuses shared-writable, linked, API key and unparseable storage", async () => {
  const directory = await home();
  writeAuth(directory, auth, 0o622);
  expect(readCodexHostGrant(directory)).toBeNull();
  const linked = await home();
  mkdirSync(join(linked, "real"));
  writeAuth(join(linked, "real"), auth);
  symlinkSync(join(linked, "real", "auth.json"), join(linked, "auth.json"));
  expect(readCodexHostGrant(linked)).toBeNull();
  const key = await home();
  writeAuth(key, { OPENAI_API_KEY: "synthetic-key", tokens: null });
  expect(readCodexHostGrant(key)).toBeNull();
  expect(jwtExpiry("opaque-token")).toBeNull();
  // Without an expiry the grant cannot be scheduled, so it is not projected.
  const opaque = await home();
  writeAuth(opaque, { ...auth, tokens: { ...auth.tokens, access_token: "opaque" } });
  expect(codexAccessProjection(readCodexHostGrant(opaque))).toBeNull();
});

it("asks for a Host refresh inside the lead window or after seven days", () => {
  const base = {
    accessToken: "a",
    idToken: "i",
    accountId: null,
    hasRefreshToken: true,
    expiresAt: 10_000_000_000_000,
    lastRefresh: new Date(1_000_000_000_000).toISOString(),
  };
  expect(needsCodexHostRefresh(base, 1_000_000_000_000)).toBe(false);
  expect(
    needsCodexHostRefresh(
      { ...base, expiresAt: 1_000_000_000_000 + CODEX_REFRESH_LEAD_MS },
      1_000_000_000_000,
    ),
  ).toBe(true);
  expect(needsCodexHostRefresh(base, 1_000_000_000_000 + 7 * 24 * 3_600_000)).toBe(true);
  expect(needsCodexHostRefresh({ ...base, hasRefreshToken: false }, 20_000_000_000_000)).toBe(
    false,
  );
});

it("signs the Host account out with its own CODEX_HOME", async () => {
  const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
  const cli = createCodexHostCli({
    run: run as never,
    resolveLaunch: async () => ({ executable: "/opt/codex", args: [] }),
  });
  await cli.logout("/host/codex-accounts/codex-account-x");
  expect(run).toHaveBeenCalledWith(
    "/opt/codex",
    ["logout"],
    expect.objectContaining({
      envOverlay: expect.objectContaining({ CODEX_HOME: "/host/codex-accounts/codex-account-x" }),
    }),
  );
});

it("verifies an adoption from the Host file alone and refuses a token near expiry", async () => {
  const directory = await home();
  const now = EXP * 1000 - 31 * 60_000;
  const idToken = jwt({
    "https://api.openai.com/profile": { email: "owner@example.com" },
    "https://api.openai.com/auth": { chatgpt_user_id: "person-1" },
  });
  writeAuth(directory, { ...auth, tokens: { ...auth.tokens, id_token: idToken } });
  expect(verifyCodexHostSession(readCodexHostGrant(directory), now)).toEqual({
    verified: true,
    identity: { email: "owner@example.com", orgId: "workspace-1" },
  });
  // Starting Codex here could refresh, so a nearly expired token waits for a Host session.
  expect(verifyCodexHostSession(readCodexHostGrant(directory), now + 2 * 60_000)).toEqual({
    verified: false,
    reason: "The Host's sign-in for this account is about to renew. Try again in a few minutes.",
  });
  const withoutRefresh = await home();
  writeAuth(withoutRefresh, { ...auth, tokens: { ...auth.tokens, refresh_token: "" } });
  expect(verifyCodexHostSession(readCodexHostGrant(withoutRefresh), now)).toMatchObject({
    verified: false,
  });
  expect(verifyCodexHostSession(null, now)).toMatchObject({ verified: false });
  // A workspace with no named person cannot be told apart from a teammate's sign-in.
  const noPerson = await home();
  const anonymous = jwt({ "https://api.openai.com/profile": { email: "owner@example.com" } });
  writeAuth(noPerson, { ...auth, tokens: { ...auth.tokens, id_token: anonymous } });
  expect(verifyCodexHostSession(readCodexHostGrant(noPerson), now)).toMatchObject({
    verified: false,
  });
});

it("ends the Host Codex process when a refresh outruns its time", async () => {
  // A stand-in app-server that initializes and then never answers the refresh.
  const script = [
    'const lines = require("node:readline").createInterface({ input: process.stdin });',
    'lines.on("line", (line) => {',
    "  const message = JSON.parse(line);",
    '  if (message.method === "initialize")',
    '    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");',
    "});",
  ].join("\n");
  let child: ChildProcessWithoutNullStreams | undefined;
  const cli = createCodexHostCli({
    spawnAppServer: async () => {
      child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
      return child;
    },
  });
  const session = await cli.openRefresh(await home());
  const started = Date.now();
  await expect(session.refresh(200)).resolves.toBe("timed-out");
  expect(Date.now() - started).toBeLessThan(2_000);
  await session.close();
  expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
});
