import { expect, it } from "vitest";
import { openAgentProfileForm } from "../internal/profile-form-model";
import { parseProfileRoute, profileDraftKey, showProfileSaveBar } from "./agent-profile-page-model";
it("tracks edits and reverting, ignoring submission changes", () => {
  const m = openAgentProfileForm({
    mode: "edit",
    profile: { id: "p", name: "Test", provider: "claude" },
  });
  const baseline = profileDraftKey(m.getState());
  m.setSubmitting(true);
  m.setSubmitError("Error");
  expect(showProfileSaveBar(baseline, m.getState())).toBe(false);
  m.setName("Changed");
  expect(showProfileSaveBar(baseline, m.getState())).toBe(true);
  m.setName("Test");
  expect(showProfileSaveBar(baseline, m.getState())).toBe(false);
});
it("parses route parameters", () => {
  expect(
    parseProfileRoute({
      profileId: [" p ", "q"],
      providerType: "claude",
      serverId: " ",
    }),
  ).toEqual({ profileId: "p", providerType: "claude", serverId: null });
  expect(parseProfileRoute({})).toEqual({
    profileId: null,
    providerType: null,
    serverId: null,
  });
});

it.each(["new", "defaults", "workflow-id"])("preserves the %s profile route", (profileId) => {
  expect(parseProfileRoute({ profileId, providerType: "claude", serverId: "host" })).toEqual({
    profileId,
    providerType: "claude",
    serverId: "host",
  });
});
