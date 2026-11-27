import { describe, expect, it } from "vitest";
import {
  applyLeanConfigFields,
  builderProviderOptions,
  lineDiff,
  parseLeanConfig,
} from "./lean-config-model";

const FILE = `{
  "schema": "vorteo-factory",
  "version": 1,
  "mode": "lean",
  "order": ["srv_m2/mira"],
  "futureKey": { "kept": true },
  "builder": { "provider": "codex", "model": "x" }
}
`;

describe("Factory config editor", () => {
  it("changes only the primary machine and builder provider, keeping unknown keys", () => {
    const result = applyLeanConfigFields(FILE, {
      primary: "srv_studio/mira",
      builderProvider: "claude",
    });
    if (!result.ok) throw new Error(result.error);
    const value = JSON.parse(result.content);
    expect(value.order).toEqual(["srv_studio/mira"]);
    expect(value.builder).toEqual({ provider: "claude", model: "x" });
    expect(value.futureKey).toEqual({ kept: true });
    expect(Object.keys(value)).toEqual(Object.keys(JSON.parse(FILE)));
    expect(parseLeanConfig(result.content)).toMatchObject({
      ok: true,
      fields: { primary: "srv_studio/mira", builderProvider: "claude" },
    });
  });

  it("shows a diff before saving, and no change when nothing was edited", () => {
    const same = applyLeanConfigFields(FILE, { primary: "srv_m2/mira", builderProvider: "codex" });
    if (!same.ok) throw new Error(same.error);
    expect(lineDiff(FILE, same.content).every((line) => line.kind === "same")).toBe(true);
    const edited = applyLeanConfigFields(FILE, {
      primary: "srv_studio/mira",
      builderProvider: "codex",
    });
    if (!edited.ok) throw new Error(edited.error);
    const changed = lineDiff(FILE, edited.content).filter((line) => line.kind !== "same");
    expect(changed.map((line) => line.kind)).toEqual(["remove", "add"]);
  });

  it("refuses to edit a file that is not valid JSON rather than overwrite it", () => {
    expect(applyLeanConfigFields("{ nope", { primary: "a/b", builderProvider: null }).ok).toBe(
      false,
    );
  });

  it("starts a lean configuration when the repository has none", () => {
    const result = applyLeanConfigFields(null, {
      primary: "srv_m2/mira",
      builderProvider: "codex",
    });
    if (!result.ok) throw new Error(result.error);
    expect(JSON.parse(result.content)).toEqual({
      schema: "vorteo-factory",
      version: 1,
      mode: "lean",
      order: ["srv_m2/mira"],
      builder: { provider: "codex" },
    });
  });
});

describe("Factory config editor formatting", () => {
  it("adds a builder provider to a file without one by rewriting the file", () => {
    const file = `{"schema":"vorteo-factory","version":1,"order":["a/b"]}`;
    const result = applyLeanConfigFields(file, { primary: "a/b", builderProvider: "claude" });
    if (!result.ok) throw new Error(result.error);
    expect(JSON.parse(result.content).builder).toEqual({ provider: "claude" });
  });
});

describe("builder provider choices", () => {
  it("offers each enabled provider type once and keeps an unavailable current value", () => {
    const families: Record<string, string> = { "claude-2": "claude", "codex-work": "codex" };
    const options = builderProviderOptions({
      entries: [
        { provider: "codex", enabled: true },
        { provider: "claude", enabled: true },
        { provider: "claude-2", enabled: true },
        { provider: "codex-work", enabled: true },
        { provider: "antigravity", enabled: true },
        { provider: "gemini", enabled: false },
      ],
      resolveType: (provider) => families[provider] ?? provider,
      current: "opencode",
    });
    expect(options).toEqual([
      { value: "codex", available: true },
      { value: "claude", available: true },
      { value: "antigravity", available: true },
      { value: "opencode", available: false },
    ]);
  });
});
