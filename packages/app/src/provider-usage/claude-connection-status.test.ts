import { expect, test } from "vitest";
import { installationConnectionStatus } from "./claude-connection-status";

const claude = (connection: Parameters<typeof installationConnectionStatus>[0]) =>
  installationConnectionStatus(connection, "Claude");

test("shared readiness requires every included delivery, not just a saved token", () => {
  expect(claude(undefined)).toEqual({ tone: "busy", text: "Checking connection..." });
  expect(claude({ connected: false, environments: [] })).toEqual({
    tone: "neutral",
    text: "Not connected",
  });
  expect(
    claude({
      connected: true,
      environments: [
        { serverId: "host", status: "ready" },
        { serverId: "dev", status: "pending" },
      ],
    }),
  ).toMatchObject({ tone: "busy", text: expect.stringContaining("Syncing") });
  expect(
    claude({
      connected: true,
      environments: [
        { serverId: "host", status: "ready" },
        { serverId: "dev", status: "excluded" },
      ],
    }),
  ).toEqual({ tone: "success", text: "Connected" });
  expect(claude({ connected: true, environments: [] }).tone).toBe("busy");
  expect(
    claude({ connected: true, environments: [{ serverId: "host", status: "excluded" }] }).text,
  ).toContain("excluded");
});

test("pending credential removal remains visible after disconnect", () => {
  expect(
    claude({ connected: false, environments: [{ serverId: "dev", status: "disconnecting" }] }),
  ).toMatchObject({ tone: "busy", text: expect.stringContaining("Disconnecting") });
});

test("full sign-in names the Host account and asks for sign-in again when its grant is lost", () => {
  expect(
    claude({
      connected: true,
      needsSignIn: false,
      accountLabel: "owner@example.com",
      environments: [{ serverId: "dev", status: "ready" }],
    }),
  ).toEqual({ tone: "success", text: "Connected as owner@example.com" });
  expect(claude({ connected: true, needsSignIn: false, environments: [] }).text).toBe("Connected");
  expect(
    claude({
      connected: false,
      needsSignIn: true,
      environments: [{ serverId: "dev", status: "disconnected" }],
    }),
  ).toMatchObject({ tone: "error", text: expect.stringContaining("Sign in again") });
});

test("Codex uses the same installation-wide readiness with its own name", () => {
  expect(
    installationConnectionStatus({ connected: false, needsSignIn: true, environments: [] }, "Codex")
      .text,
  ).toBe("Codex sign-in expired. Sign in again.");
  expect(
    installationConnectionStatus(
      {
        connected: true,
        needsSignIn: false,
        environments: [{ serverId: "dev", status: "pending" }],
      },
      "Codex",
    ).tone,
  ).toBe("busy");
});
