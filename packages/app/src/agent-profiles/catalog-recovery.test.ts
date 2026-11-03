import { expect, test } from "vitest";
import { catalogRecoveryAction } from "./catalog-recovery";

test("installed providers with snapshot errors open sign-in", () => {
  expect(catalogRecoveryAction({ status: "error" })).toBe("sign-in");
});
test("catalog request failures offer retry even if the last snapshot failed", () => {
  expect(catalogRecoveryAction({ status: "error" }, "Could not discover profiles")).toBe("retry");
  expect(catalogRecoveryAction(undefined, "Request failed")).toBe("retry");
  expect(catalogRecoveryAction({ status: "ready" })).toBe("retry");
});
