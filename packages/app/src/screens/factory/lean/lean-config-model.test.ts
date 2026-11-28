import { describe, expect, it } from "vitest";
import { applyLeanConfigFields, leanConfigDraft } from "./lean-config-model";

const FILE = `{
  "schema": "vorteo-factory",
  "version": 1,
  "mode": "lean",
  "order": ["srv_m2/mira", "srv_studio/mira"],
  "futureKey": { "kept": true },
  "builder": { "provider": "codex", "model": "x" }
}
`;

describe("Factory config editor", () => {
  it("offers no save until the owner edits, and never drops later machines from the order", () => {
    // Opening settings and changing nothing proposes nothing.
    expect(leanConfigDraft(FILE, {})).toMatchObject({ content: FILE, changes: [] });
    // Editing only the provider leaves the order, unknown keys and other lines untouched.
    const provider = leanConfigDraft(FILE, { builderProvider: "claude" });
    expect(provider.changes.map((line) => line.kind)).toEqual(["remove", "add"]);
    const value = JSON.parse(provider.content!);
    expect(value.order).toEqual(["srv_m2/mira", "srv_studio/mira"]);
    expect(value.builder).toEqual({ provider: "claude", model: "x" });
    expect(value.futureKey).toEqual({ kept: true });
    // A new primary replaces only order[0] and keeps the rest.
    const primary = applyLeanConfigFields(FILE, { primary: "srv_new/mira" });
    if (!primary.ok) throw new Error(primary.error);
    expect(JSON.parse(primary.content).order).toEqual(["srv_new/mira", "srv_studio/mira"]);
    expect(JSON.parse(primary.content).builder).toEqual({ provider: "codex", model: "x" });
    // A primary already listed moves to the front; nothing is dropped.
    const reorder = applyLeanConfigFields(FILE, { primary: "srv_studio/mira" });
    if (!reorder.ok) throw new Error(reorder.error);
    expect(JSON.parse(reorder.content).order).toEqual(["srv_studio/mira", "srv_m2/mira"]);
  });

  it("refuses to edit a file that is not valid JSON rather than overwrite it", () => {
    expect(applyLeanConfigFields("{ nope", { primary: "a/b" }).ok).toBe(false);
  });
});
