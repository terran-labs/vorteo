import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  CLAUDE_ADOPTION_MARGIN_MS,
  adoptClaudeGrant,
  fileCredentialStore,
  projectClaudeHostAccess,
  restoreClaudeGrant,
  type ClaudeCredentialStore,
} from "./claude-oauth-authority.js";

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "claude-authority-"));
  directories.push(root);
  const agentDir = join(root, "claude-account-x");
  mkdirSync(agentDir);
  return { agentDir, authorityDir: join(root, "authority", "x") };
}

function grant(n: number, expiresAt = NOW + 8 * HOUR) {
  return {
    accessToken: `synthetic-access-${n}`,
    refreshToken: `synthetic-refresh-${n}`,
    expiresAt,
    scopes: ["user:inference"],
    subscriptionType: "max",
  };
}

/** Every byte under the account directory, so a refresh token cannot hide in any file. */
function agentBytes(dir: string): string {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

/** The macOS order: a Keychain item shadows the file, and a file write drops the item after. */
function keychainLike(): ClaudeCredentialStore & { items: Map<string, Record<string, unknown>> } {
  const items = new Map<string, Record<string, unknown>>();
  return {
    items,
    read: async (dir) => items.get(dir) ?? fileCredentialStore.read(dir),
    write: async (dir, value) => {
      items.set(dir, structuredClone(value));
    },
    writeFile: async (dir, value) => {
      await fileCredentialStore.write(dir, value);
      items.delete(dir);
    },
    primaryHolds: async (dir) => items.has(dir),
    remove: async (dir) => {
      items.delete(dir);
      await fileCredentialStore.remove(dir);
    },
  };
}

it("moves an existing login into the authority once and leaves the account access-only", async () => {
  const { agentDir, authorityDir } = dirs();
  const store = fileCredentialStore;
  await store.write(agentDir, { claudeAiOauth: grant(1), mcpOAuth: { server: "kept" } });
  const custody = { definitionId: "one", agentDir, authorityDir, store };

  await expect(adoptClaudeGrant({ ...custody, now: NOW })).resolves.toBe("adopted");
  expect(await store.read(authorityDir)).toEqual({ claudeAiOauth: grant(1) });
  const { refreshToken: _withheld, ...access } = grant(1);
  expect(await store.read(agentDir)).toEqual({
    claudeAiOauth: access,
    mcpOAuth: { server: "kept" },
  });
  expect(agentBytes(agentDir)).not.toContain("synthetic-refresh");

  // Re-running is a no-op, and later authority rotations reach the account without its token.
  await expect(adoptClaudeGrant({ ...custody, now: NOW })).resolves.toBe("none");
  await expect(projectClaudeHostAccess(custody)).resolves.toBe("unchanged");
  await store.write(authorityDir, { claudeAiOauth: grant(2, NOW + 9 * HOUR) });
  await expect(projectClaudeHostAccess(custody)).resolves.toBe("written");
  expect((await store.read(agentDir))?.claudeAiOauth).toMatchObject({
    accessToken: "synthetic-access-2",
  });
  expect(agentBytes(agentDir)).not.toContain("synthetic-refresh");
});

it("adopts any new sign-in, drops a token it already held and defers near expiry", async () => {
  const { agentDir, authorityDir } = dirs();
  const store = fileCredentialStore;
  const custody = { definitionId: "one", agentDir, authorityDir, store };
  await store.write(agentDir, { claudeAiOauth: grant(1) });
  await expect(adoptClaudeGrant({ ...custody, now: NOW })).resolves.toBe("adopted");
  // The authority refreshed to a new token.
  await store.write(authorityDir, { claudeAiOauth: grant(2, NOW + 9 * HOUR) });

  // A copy of a token the authority already held is a leftover: never replay it.
  await store.write(agentDir, { claudeAiOauth: grant(1) });
  await expect(adoptClaudeGrant({ ...custody, now: NOW })).resolves.toBe("stripped");
  expect((await store.read(authorityDir))?.claudeAiOauth).toEqual(grant(2, NOW + 9 * HOUR));
  expect((await store.read(agentDir))?.claudeAiOauth).toMatchObject({
    accessToken: "synthetic-access-2",
  });

  // Any token it never held is a new sign-in, even with an earlier expiry.
  await store.write(agentDir, { claudeAiOauth: grant(3, NOW + 2 * HOUR) });
  await expect(projectClaudeHostAccess(custody)).resolves.toBe("skipped");
  await expect(adoptClaudeGrant({ ...custody, now: NOW })).resolves.toBe("adopted");
  expect((await store.read(authorityDir))?.claudeAiOauth).toEqual(grant(3, NOW + 2 * HOUR));

  // Too close to expiry, an older CLI without the refresh lock may be refreshing it.
  await store.write(agentDir, { claudeAiOauth: grant(4, NOW + 9 * HOUR) });
  const late = NOW + 9 * HOUR - CLAUDE_ADOPTION_MARGIN_MS + 1;
  await expect(adoptClaudeGrant({ ...custody, now: late })).resolves.toBe("deferred");
  expect((await store.read(agentDir))?.claudeAiOauth).toEqual(grant(4, NOW + 9 * HOUR));
});

it("never moves a grant while an agent CLI holds its refresh lock", async () => {
  const { agentDir, authorityDir } = dirs();
  const store = fileCredentialStore;
  const custody = { definitionId: "one", agentDir, authorityDir, store, lock: { attempts: 1 } };
  await store.write(agentDir, { claudeAiOauth: grant(1) });
  // A CLI refreshing after a 401 holds this proper-lockfile directory.
  mkdirSync(join(agentDir, ".oauth_refresh.lock"));
  await expect(adoptClaudeGrant({ ...custody, now: NOW })).resolves.toBe("deferred");
  expect((await store.read(agentDir))?.claudeAiOauth).toEqual(grant(1));
  expect(await store.read(authorityDir)).toBeNull();
  rmSync(join(agentDir, ".oauth_refresh.lock"), { recursive: true });
  await expect(adoptClaudeGrant({ ...custody, now: NOW })).resolves.toBe("adopted");
  // Our own locks are released afterwards.
  expect(readdirSync(agentDir)).not.toContain(".oauth_refresh.lock");
});

it("on macOS moves the account's Keychain item to the file only after the authority holds it", async () => {
  const { agentDir, authorityDir } = dirs();
  const store = keychainLike();
  const custody = { definitionId: "one", agentDir, authorityDir, store };
  store.items.set(agentDir, { claudeAiOauth: grant(1) });

  await expect(adoptClaudeGrant({ ...custody, now: NOW })).resolves.toBe("adopted");
  expect(store.items.get(authorityDir)).toEqual({ claudeAiOauth: grant(1) });
  expect(store.items.has(agentDir)).toBe(false);
  expect(agentBytes(agentDir)).toContain("synthetic-access-1");
  expect(agentBytes(agentDir)).not.toContain("synthetic-refresh");

  // Another CLI save (MCP OAuth) recreated the item; projection moves it back behind the file.
  store.items.set(agentDir, (await store.read(agentDir))!);
  await expect(projectClaudeHostAccess(custody)).resolves.toBe("written");
  expect(store.items.has(agentDir)).toBe(false);

  // Rollback returns the full grant to the account's Keychain item and deletes the authority.
  await expect(restoreClaudeGrant(custody)).resolves.toBe("restored");
  expect(store.items.get(agentDir)?.claudeAiOauth).toEqual(grant(1));
  expect(store.items.has(authorityDir)).toBe(false);
  await expect(restoreClaudeGrant(custody)).resolves.toBe("none");
});
