import { expect, test } from "vitest";
import { isProviderSelectable, areProvidersDetecting } from "./provider-availability";

test("availability distinguishes missing CLIs from sign-in failures", () => {
  expect(isProviderSelectable({ enabled: true, status: "unavailable" })).toBe(false);
  expect(isProviderSelectable({ enabled: true, status: "error" })).toBe(true);
  expect(isProviderSelectable({ enabled: false, status: "ready" })).toBe(false);
  expect(areProvidersDetecting([{ enabled: true, status: "loading" }])).toBe(true);
  expect(areProvidersDetecting([])).toBe(false);
});
