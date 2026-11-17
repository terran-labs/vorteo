import { describe, expect, it } from "vitest";
import {
  DEFAULT_USAGE_PREFERENCES,
  setUsageDisplayAs,
  setUsageHost,
  UsagePreferencesSchema,
} from "./preferences";

describe("usage preferences", () => {
  it("switches between used and remaining and remembers the picked host", () => {
    expect(setUsageDisplayAs(DEFAULT_USAGE_PREFERENCES, "remaining")).toEqual({
      displayAs: "remaining",
      serverId: null,
    });
    expect(setUsageHost(DEFAULT_USAGE_PREFERENCES, "server")).toEqual({
      displayAs: "used",
      serverId: "server",
    });
  });

  it("reads preferences saved with retired sidebar pins without keeping them", () => {
    const pin = { sourceId: "codex", windowId: "weekly" };
    expect(UsagePreferencesSchema.parse({ displayAs: "remaining", pinned: [pin] })).toEqual({
      displayAs: "remaining",
      serverId: null,
    });
    expect(UsagePreferencesSchema.parse({ pins: [pin], serverId: "host" })).toEqual({
      displayAs: "used",
      serverId: "host",
    });
  });
});
