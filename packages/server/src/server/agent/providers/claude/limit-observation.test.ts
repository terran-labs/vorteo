import { describe, expect, test } from "vitest";
import { ClaudeLimitObservations, parseClaudeLimitMessage } from "./limit-observation.js";

// 2026-11-02 10:00 in Los Angeles (PST, UTC-8).
const NOW = Date.parse("2026-11-02T18:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("parseClaudeLimitMessage", () => {
  test("reads a weekly limit and the next 11pm in the named zone", () => {
    expect(
      parseClaudeLimitMessage(
        "You've hit your weekly limit · resets 11pm (America/Los_Angeles)\n\ncode: quota_exhausted",
        NOW,
      ),
    ).toEqual({ window: "weekly", resetsAt: "2026-11-03T07:00:00.000Z" });
  });

  test("moves a clock time that already passed today to tomorrow", () => {
    expect(
      parseClaudeLimitMessage(
        "You've hit your session limit · resets 9am (America/Los_Angeles)",
        NOW,
      ),
    ).toEqual({ window: "session", resetsAt: "2026-11-03T17:00:00.000Z" });
  });

  test("reads a dated reset with minutes, rolling into next year when it passed", () => {
    expect(
      parseClaudeLimitMessage(
        "You've hit your weekly limit · resets Nov 8, 8:30am (Europe/London)",
        NOW,
      ),
    ).toEqual({ window: "weekly", resetsAt: "2026-11-08T08:30:00.000Z" });
    expect(
      parseClaudeLimitMessage(
        "You've hit your weekly limit · resets Oct 1, 8am (America/New_York)",
        NOW,
      )?.resetsAt,
    ).toBe("2027-10-01T12:00:00.000Z");
  });

  test("keeps the limit but no reset when the time cannot be read", () => {
    expect(parseClaudeLimitMessage("You've hit your session limit · resets 11am", NOW)).toEqual({
      window: "session",
      resetsAt: null,
    });
    expect(
      parseClaudeLimitMessage("You've hit your weekly limit · resets 11pm (Not/AZone)", NOW),
    ).toEqual({ window: "weekly", resetsAt: null });
    expect(parseClaudeLimitMessage("You've hit your limit · resets soon", NOW)).toEqual({
      window: null,
      resetsAt: null,
    });
  });

  test("ignores messages that are not limit stops", () => {
    expect(parseClaudeLimitMessage("Claude run failed: code 1", NOW)).toBeNull();
  });
});

describe("ClaudeLimitObservations", () => {
  test("keeps an observation until its reset passes", () => {
    let now = NOW;
    const observations = new ClaudeLimitObservations({ now: () => now });
    expect(
      observations.record("claude-two", {
        error: "You've hit your weekly limit · resets 11pm (America/Los_Angeles)",
      }),
    ).toBe(true);
    expect(observations.read("claude-two")).toEqual({
      window: "weekly",
      resetsAt: "2026-11-03T07:00:00.000Z",
      observedAt: new Date(NOW).toISOString(),
    });
    expect(observations.read("claude-one")).toBeNull();
    now = Date.parse("2026-11-03T07:00:00.000Z");
    expect(observations.read("claude-two")).toBeNull();
  });

  test("prefers the reported reset and window over the message text", () => {
    const observations = new ClaudeLimitObservations({ now: () => NOW });
    const resetsAt = new Date(NOW + 3 * HOUR).toISOString();
    observations.record("claude-two", {
      error: "Claude usage limit reached",
      usageLimit: { resetsAt, window: "five_hour" },
    });
    expect(observations.read("claude-two")).toMatchObject({ window: "session", resetsAt });
  });

  test("expires an observation without a reset time after seven days", () => {
    let now = NOW;
    const observations = new ClaudeLimitObservations({ now: () => now });
    observations.record("claude-two", { error: "You've hit your session limit · resets 11am" });
    now += 7 * 24 * HOUR - 1;
    expect(observations.read("claude-two")?.resetsAt).toBeNull();
    now += 1;
    expect(observations.read("claude-two")).toBeNull();
  });

  test("ignores failures that describe no usage limit", () => {
    const observations = new ClaudeLimitObservations({ now: () => NOW });
    expect(observations.record("claude-two", { error: "Network error" })).toBe(false);
    expect(observations.read("claude-two")).toBeNull();
  });
});
