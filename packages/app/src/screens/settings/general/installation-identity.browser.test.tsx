import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { InstallationTypeStatus } from "@getpaseo/protocol/installation-type";
import { OwnerAccessSourceContext, type OwnerAccess } from "@/execution-installation/owner-access";
import { saveInstallationName } from "@/execution-installation/installation-name";
import { InstallationNameSection } from "./installation-name-section";

const fixture = vi.hoisted(() => ({
  access: "unlocked" as OwnerAccess["status"],
  failName: false,
  names: [] as (string | null)[],
  readType: vi.fn(),
  changeType: vi.fn(),
  toast: { show: vi.fn(), error: vi.fn() },
}));
const client = vi.hoisted(() => ({
  installationType: fixture.readType,
  changeInstallationType: fixture.changeType,
}));
vi.mock("@/execution-installation/policy", () => ({
  readExecutionInstallation: () => ({ name: "Lab" }),
}));
vi.mock("@/execution-installation/panel", () => ({
  useInstallationOwnerClient: () => (fixture.access === "unlocked" ? client : null),
  useInstallationOwnerAccess: () => ({ status: "none", busy: false, error: null }),
  PasswordFileHint: () => null,
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => fixture.toast }));

const originalFetch = globalThis.fetch;
const stable: InstallationTypeStatus = {
  type: "stable",
  revision: "stable-revision",
  changedAt: null,
};
const mounted: { root: Root; container: HTMLElement }[] = [];
function useOwner(): OwnerAccess {
  return {
    status: fixture.access,
    busy: false,
    error: null,
    unlock: async () => {},
    lock: async () => {},
  };
}
async function mountIdentity() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <OwnerAccessSourceContext.Provider value={useOwner}>
        <InstallationNameSection />
      </OwnerAccessSourceContext.Provider>,
    );
  });
  return container;
}
beforeEach(async () => {
  fixture.access = "unlocked";
  fixture.failName = false;
  fixture.readType.mockReset().mockResolvedValue(stable);
  fixture.changeType.mockReset().mockImplementation(async (current, type) => ({
    ...current,
    type,
    revision: "next-revision",
  }));
  fixture.toast.show.mockClear();
  fixture.toast.error.mockClear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    if (input !== "/api/installation/owner/name") return originalFetch(input, options);
    const body = JSON.parse(String(options?.body)) as { name: string | null };
    fixture.names.push(body.name);
    return new Response(JSON.stringify({ name: body.name }), {
      status: fixture.failName ? 500 : 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await saveInstallationName("Lab");
  fixture.names.length = 0;
});
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

test.each([390, 1280])("installation name and type save together at width %s", async (width) => {
  await page.viewport(width, 900);
  const container = await mountIdentity();
  await expect.poll(() => container.textContent).toContain("Stable");
  await page.getByRole("textbox", { name: "Installation name", exact: true }).fill("Workshop");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => fixture.names).toEqual(["Workshop"]);
  await expect.poll(() => container.querySelector("input")?.value).toBe("Workshop");
  await page.getByTestId("settings-installation-type-trigger").click();
  await page.getByTestId("settings-installation-type-lab").click();
  await expect.poll(() => fixture.changeType.mock.calls).toEqual([[stable, "lab"]]);
  await expect
    .poll(
      () =>
        container.querySelector('[data-testid="settings-installation-type-trigger"]')?.textContent,
    )
    .toBe("Lab");
});

test("locked installation identity does not mount protected type reads or save controls", async () => {
  fixture.access = "locked";
  const container = await mountIdentity();
  expect(container.textContent).toContain("Installation name: Lab");
  expect(container.querySelector("input")).toBeNull();
  expect(fixture.readType).not.toHaveBeenCalled();
  expect(fixture.names).toEqual([]);
});

test("failed identity saves keep the draft and the last confirmed type", async () => {
  const container = await mountIdentity();
  await expect.poll(() => container.textContent).toContain("Stable");
  fixture.failName = true;
  await page
    .getByRole("textbox", { name: "Installation name", exact: true })
    .fill("Keep this draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => fixture.toast.error.mock.calls)
    .toEqual([["Unable to save the installation name."]]);
  expect(container.querySelector("input")?.value).toBe("Keep this draft");
  fixture.changeType.mockRejectedValueOnce(new Error("Type changed elsewhere"));
  await page.getByTestId("settings-installation-type-trigger").click();
  await page.getByTestId("settings-installation-type-lab").click();
  await expect
    .poll(() => fixture.toast.error.mock.calls.at(-1))
    .toEqual(["Type changed elsewhere"]);
  expect(
    container.querySelector('[data-testid="settings-installation-type-trigger"]')?.textContent,
  ).toBe("Stable");
  fixture.failName = false;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => fixture.toast.show.mock.calls.at(-1)).toEqual(["Saved."]);
});
