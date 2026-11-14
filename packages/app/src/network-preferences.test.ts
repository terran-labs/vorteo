import { describe, expect, it } from "vitest";
import { parseDataSaverOverride, resolveDataSaver, shouldSaveData } from "./network-preferences";

describe("data saving", () => {
  it("follows the browser's data saver, 2G-class connections and prefers-reduced-data only", () => {
    expect(shouldSaveData({})).toBe(false);
    expect(shouldSaveData({ connection: { effectiveType: "4g" } })).toBe(false);
    expect(shouldSaveData({ connection: { effectiveType: "3g" } })).toBe(false);
    expect(shouldSaveData({ connection: { saveData: true, effectiveType: "4g" } })).toBe(true);
    expect(shouldSaveData({ connection: { effectiveType: "slow-2g" } })).toBe(true);
    expect(shouldSaveData({ connection: { effectiveType: "2g" } })).toBe(true);
    expect(shouldSaveData({ connection: null, prefersReducedData: true })).toBe(true);
  });

  it("lets the startup screen's stored choice win both ways and follows the browser otherwise", () => {
    const slow = { connection: { effectiveType: "2g" } };
    const fast = { connection: { effectiveType: "4g" } };
    expect(resolveDataSaver(parseDataSaverOverride("off"), slow)).toBe(false);
    expect(resolveDataSaver(parseDataSaverOverride("on"), fast)).toBe(true);
    for (const stored of [null, "", "true", "maybe"]) {
      expect(resolveDataSaver(parseDataSaverOverride(stored), slow)).toBe(true);
      expect(resolveDataSaver(parseDataSaverOverride(stored), fast)).toBe(false);
    }
  });
});
