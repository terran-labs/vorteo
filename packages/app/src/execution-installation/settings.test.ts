import { afterEach, expect, it, vi } from "vitest";

vi.mock("./owner-access", () => ({ useOwnerAccess: () => ({ status: "unlocked" }) }));
vi.mock("@/data/query", () => ({ useFetchQuery: () => ({}) }));
vi.mock("./policy", () => ({ readExecutionInstallation: () => null }));
vi.mock("./client", () => ({ OwnerAccessExpired: class OwnerAccessExpired extends Error {} }));

import { PrimaryConnectionUnavailableError } from "./primary-connection-error";
import { InstallationSettingsConflictError, requestInstallationSettings } from "./settings";

afterEach(() => vi.unstubAllGlobals());

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const update = { expectedRevision: 3, settings: { primaryConnection: { providerId: "gone" } } };

it("maps the server's stale primary connection refusal to the typed error", async () => {
  respond(400, {
    error: "That connection is no longer available.",
    reason: "primary-connection-unavailable",
  });
  const failure = await requestInstallationSettings(update).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PrimaryConnectionUnavailableError);
  expect((failure as Error).message).toBe("That connection is no longer available.");
});

it("keeps other refusals and conflicts distinct", async () => {
  respond(400, { error: "Shared settings reference an unknown environment or resource." });
  const refusal = await requestInstallationSettings(update).catch((error: unknown) => error);
  expect(refusal).not.toBeInstanceOf(PrimaryConnectionUnavailableError);
  expect((refusal as Error).message).toContain("unknown environment");
  respond(409, {});
  await expect(requestInstallationSettings(update)).rejects.toBeInstanceOf(
    InstallationSettingsConflictError,
  );
});
