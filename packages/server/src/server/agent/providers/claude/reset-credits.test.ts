import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ClaudeResetCreditSession,
  forgetClaudeResetStatus,
  recordClaudeResetStatus,
} from "./reset-credits.js";

const ACCOUNT = "acct-1";
const ORG = "org-1";
// An obviously fake request ID: the schema requires a UUID, nothing more.
const REQUEST_ID = "00000000-0000-4000-8000-000000000000";
const STATUS = {
  eligible: true,
  at_limit: true,
  next_grant_id: "weekly_reset",
  grants: [
    {
      id: "weekly_reset",
      label: "Weekly reset",
      resets_total: 1,
      resets_left: 1,
      ends_at: "2026-11-12T00:00:00Z",
      usable_now: true,
      type: "session",
    },
    { id: "BAD ID", resets_left: 1 },
  ],
};

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "claude-reset-"));
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({
      oauthAccount: { accountUuid: ACCOUNT, organizationUuid: ORG, emailAddress: "a@example.com" },
    }),
  );
});

afterEach(() => {
  forgetClaudeResetStatus(configDir);
  rmSync(configDir, { recursive: true, force: true });
});

function session(fetchApi: typeof fetch, dir: string | null = configDir) {
  return new ClaudeResetCreditSession({
    configDir: dir,
    readAccessToken: async () => "token-1",
    fetch: fetchApi,
  });
}

describe("ClaudeResetCreditSession", () => {
  test("reads the usage poll's reset grants without calling Claude again", async () => {
    const fetchApi = vi.fn<typeof fetch>();
    recordClaudeResetStatus(configDir, STATUS);
    const snapshot = await session(fetchApi).read();
    expect(fetchApi).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      status: "available",
      accountId: ACCOUNT,
      availableCount: 1,
      credits: [{ id: "weekly_reset", status: "available" }],
    });
  });

  test("claims the selected grant for the account's organization and maps the result", async () => {
    const fetchApi = vi.fn<typeof fetch>(async () => Response.json({ result: "reset" }));
    recordClaudeResetStatus(configDir, STATUS);
    const outcome = await session(fetchApi).consume({
      accountId: ACCOUNT,
      idempotencyKey: REQUEST_ID,
      creditId: "weekly_reset",
    });
    expect(outcome).toBe("reset");
    const [url, init] = fetchApi.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`,
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      program: "cedar_ember",
      grant_id: "weekly_reset",
      request_id: REQUEST_ID,
    });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-1");
    // Claude offers resets to Claude Code, so Vorteo's reads identify as the installed CLI.
    expect(headers["User-Agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
  });

  test("labels grants that name the limits they clear instead of a type", async () => {
    const fetchApi = vi.fn<typeof fetch>();
    recordClaudeResetStatus(configDir, {
      eligible: true,
      grants: [
        { id: "fable", label: "Fable reset", resets_left: 2, clears: ["seven_day_omelette"] },
        { id: "both", label: "Full", resets_left: 1, clears: ["five_hour", "seven_day"] },
      ],
    });
    const snapshot = await session(fetchApi).read();
    expect(snapshot).toMatchObject({
      status: "available",
      availableCount: 3,
      credits: [
        { id: "fable", resetType: "weekly" },
        { id: "both", resetType: "full" },
      ],
    });
  });

  test("refuses to spend a reset when the signed-in account changed", async () => {
    const fetchApi = vi.fn<typeof fetch>();
    await expect(
      session(fetchApi).consume({ accountId: "someone-else", idempotencyKey: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "account_changed" });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  test("reports setup-token accounts as unsupported so the picker hides the control", async () => {
    const fetchApi = vi.fn<typeof fetch>();
    expect(await session(fetchApi, null).read()).toMatchObject({ status: "unsupported" });
    expect(fetchApi).not.toHaveBeenCalled();
  });
});
