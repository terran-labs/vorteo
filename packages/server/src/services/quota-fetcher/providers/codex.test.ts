import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { CodexQuotaProvider } from "./codex.js";
import {
  isCodexRefreshRejection,
  readCodexAuthGeneration,
  recordCodexRefreshRejection,
} from "../../../server/agent/providers/codex/refresh-rejection.js";
import { evaluateQuotaReserve } from "../../../server/agent/quota-reserve/evaluate.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it.each([
  {
    name: "single coding window with an explicitly absent secondary",
    limits: { primary_window: { used_percent: 20 }, secondary_window: null },
    ids: ["session"],
    evaluation: "ready",
  },
  {
    name: "secondary coding limit crossing Redline",
    limits: { primary_window: { used_percent: 20 }, secondary_window: { used_percent: 90 } },
    ids: ["session", "weekly"],
    evaluation: "redline",
  },
  {
    name: "applicable secondary with missing utilization",
    limits: { primary_window: { used_percent: 20 }, secondary_window: {} },
    ids: ["session", "weekly"],
    evaluation: "unavailable",
  },
  {
    name: "omitted secondary applicability",
    limits: { primary_window: { used_percent: 20 } },
    ids: undefined,
    evaluation: "unavailable",
  },
  {
    name: "no coding allowances",
    limits: { primary_window: null, secondary_window: null },
    ids: [],
    evaluation: "unavailable",
  },
  {
    name: "missing rate-limit response",
    limits: null,
    ids: undefined,
    evaluation: "unavailable",
  },
])("declares reserve applicability for $name", async ({ limits, ids, evaluation }) => {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-reserve-"));
  homes.push(home);
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "test" } }));
  const provider = new CodexQuotaProvider({
    logger: pino({ level: "silent" }),
    codexHome: home,
    strictCodexHome: true,
    fetch: async () =>
      Response.json({
        rate_limit: limits,
        code_review_rate_limit: { primary_window: { used_percent: 100 } },
        credits: { balance: 100 },
      }),
  });
  const usage = await provider.fetchUsage();
  expect(usage.balances).toEqual([
    expect.objectContaining({ id: "credits", remaining: 100, unit: "credits" }),
  ]);
  expect(usage.reserveWindowIds).toEqual(ids);
  expect(
    evaluateQuotaReserve({
      policy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
      windows: usage.windows,
      requiredWindowIds: usage.reserveWindowIds ?? [],
      observedAtMs: 1000,
      nowMs: 1001,
      maxAgeMs: 30000,
      recovering: false,
    }).kind,
  ).toBe(evaluation);
});

it.each([
  { seconds: 604800, label: "Weekly" },
  { seconds: 18000, label: "5-hour" },
  { seconds: undefined, label: "Session" },
])("labels a primary allowance lasting $seconds seconds as $label", async ({ seconds, label }) => {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-window-"));
  homes.push(home);
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "test" } }));
  const provider = new CodexQuotaProvider({
    logger: pino({ level: "silent" }),
    codexHome: home,
    strictCodexHome: true,
    fetch: async () =>
      Response.json({
        rate_limit: {
          primary_window: { used_percent: 91, limit_window_seconds: seconds },
          secondary_window: null,
        },
      }),
  });

  const usage = await provider.fetchUsage();

  expect(usage.windows).toEqual([
    {
      id: "session",
      label,
      usedPct: 91,
      remainingPct: 9,
      resetsAt: null,
      tone: "danger",
    },
  ]);
});

it("never claims a native Codex home has no credentials, and accepts API-key sign-in", async () => {
  const read = async (auth: unknown) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-codex-credentials-"));
    homes.push(home);
    if (auth !== undefined) await writeFile(join(home, "auth.json"), JSON.stringify(auth));
    const fetch = async () => {
      throw new Error("No usage request without a ChatGPT sign-in");
    };
    return new CodexQuotaProvider({
      logger: pino({ level: "silent" }),
      codexHome: home,
      strictCodexHome: true,
      fetch,
    }).fetchUsage();
  };
  // An API key elsewhere may still authenticate, so neither reading proves a missing sign-in.
  for (const usage of [await read(undefined), await read({ OPENAI_API_KEY: "sk", tokens: null })]) {
    expect(usage.status).toBe("unavailable");
    expect(usage.credentialsMissing).toBeUndefined();
  }
});

it("asks for reconnection once Codex refused to refresh the stored sign-in, until it changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-refresh-rejected-"));
  homes.push(home);
  // Synthetic token; the access token still answers usage reads after the refresh grant died.
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "test" } }));
  const provider = new CodexQuotaProvider({
    logger: pino({ level: "silent" }),
    codexHome: home,
    strictCodexHome: true,
    fetch: async () =>
      new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } } }), {
        status: 200,
      }),
  });
  expect(
    isCodexRefreshRejection(
      "Your access token could not be refreshed because your refresh token has expired.",
    ),
  ).toBe(true);
  const failedTurn = await readCodexAuthGeneration(home);
  if (!failedTurn) throw new Error("expected a stored sign-in");
  expect(await recordCodexRefreshRejection(home, failedTurn)).toBe(true);
  const rejected = await provider.fetchUsage();
  expect(rejected.authRecovery?.method).toBe("device_code");
  // A new sign-in rewrites auth.json and clears the record.
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "test-new" } }),
  );
  const reconnected = await provider.fetchUsage();
  expect(reconnected.authRecovery).toBeUndefined();
  expect(reconnected.status).toBe("available");
});

it("a late failure from a turn on the old sign-in never marks a completed reconnect", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-refresh-race-"));
  homes.push(home);
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "old" } }));
  // Captured when the turn started on the old sign-in.
  const oldTurn = await readCodexAuthGeneration(home);
  if (!oldTurn) throw new Error("expected a stored sign-in");
  // The owner reconnects before that turn's refresh failure arrives.
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "reconnected" } }),
  );
  expect(await recordCodexRefreshRejection(home, oldTurn)).toBe(false);
  const usage = await new CodexQuotaProvider({
    logger: pino({ level: "silent" }),
    codexHome: home,
    strictCodexHome: true,
    fetch: async () =>
      new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } } }), {
        status: 200,
      }),
  }).fetchUsage();
  expect(usage.authRecovery).toBeUndefined();
});
