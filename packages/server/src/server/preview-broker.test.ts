import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import { admitPreviewRestart, PreviewBrokerRestarter } from "./preview-broker-restart.js";
import {
  projectWorkspaceScriptPreview,
  type PreviewBrokerService,
} from "./preview-broker-status.js";

const broker: PreviewBrokerService = {
  workspaceId: "wks_a",
  service: "web",
  desired: "stopped",
  status: "failed",
  stoppedAt: 1_000,
};
const channels: string[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) rmSync(channel, { recursive: true, force: true });
});

function makeChannel(): string {
  const directory = mkdtempSync(join(tmpdir(), "preview-channel-"));
  channels.push(directory);
  for (const name of ["inbox", "receipts"]) mkdirSync(join(directory, name));
  writeFileSync(join(directory, "installed.json"), "{}");
  return directory;
}

describe("preview restart admission", () => {
  const restarter = { inFlight: () => false };
  const allowed = {
    credential: "password" as const,
    restarter,
    brokerAvailable: true,
    workspace: { archivedAt: null },
    hasReservation: true,
    broker,
    workspaceId: "wks_a",
    scriptName: "web",
  };

  test("admits only a password session, for a reserved preview that needs no review", () => {
    expect(admitPreviewRestart(allowed)).toBeNull();
    // The local credential is readable by any process of the daemon's user, agents included.
    for (const credential of ["local", "service", "plugin", "open", null] as const) {
      expect(admitPreviewRestart({ ...allowed, credential })?.code).toBe("owner_app_only");
    }
    expect(admitPreviewRestart({ ...allowed, workspace: { archivedAt: "2026-11-01" } })?.code).toBe(
      "workspace_unavailable",
    );
    expect(admitPreviewRestart({ ...allowed, hasReservation: false })?.code).toBe("no_reservation");
    expect(
      admitPreviewRestart({ ...allowed, broker: { ...broker, needsReview: true } })?.code,
    ).toBe("needs_review");
    expect(admitPreviewRestart({ ...allowed, broker: null })?.code).toBe("broker_unavailable");
    expect(admitPreviewRestart({ ...allowed, brokerAvailable: false })?.code).toBe(
      "broker_unavailable",
    );
  });
});

describe("preview broker restarter", () => {
  test("writes one valid broker request and reports the broker's failure", async () => {
    const directory = makeChannel();
    const onChange = vi.fn();
    const restarter = new PreviewBrokerRestarter({
      channel: directory,
      onChange,
      logger: pino({ level: "silent" }),
      pollMs: 5,
    });
    await restarter.submit("wks_a", "web", "start");
    expect(restarter.inFlight("wks_a", "web")).toBe(true);
    await expect(restarter.submit("wks_a", "web", "start")).rejects.toThrow("already running");

    const [file] = readdirSync(join(directory, "inbox"));
    const request = JSON.parse(readFileSync(join(directory, "inbox", file), "utf8"));
    // Exactly the fields the broker's validate() accepts.
    expect(Object.keys(request).sort()).toEqual([
      "createdAt",
      "id",
      "operation",
      "service",
      "workspaceId",
    ]);
    expect(request).toMatchObject({ operation: "start", workspaceId: "wks_a", service: "web" });

    writeFileSync(
      join(directory, "receipts", `${request.id}.json`),
      JSON.stringify({ status: "failed", error: "Service configuration identity changed" }),
    );
    await vi.waitFor(() => expect(restarter.outcome("wks_a", "web")?.status).toBe("failed"));
    expect(restarter.outcome("wks_a", "web")?.error).toBe("Service configuration identity changed");
    expect(onChange).toHaveBeenLastCalledWith("wks_a");
  });
});

describe("preview state projection", () => {
  test("a forged or unknown broker entry cannot add a cause or a link", () => {
    // In Dev the status file is agent-writable; only known codes and plain text pass.
    const preview = projectWorkspaceScriptPreview({
      broker: {
        ...broker,
        stopReason: "owner_asked",
        error: "Open https://example.test to fix this",
      },
      publishedAt: 2_000,
      lifecycle: "stopped",
      health: null,
      restart: null,
      nowSeconds: 2_010,
    });
    expect(preview.state).toBe("stopped");
    expect(preview.stopReason).toBeUndefined();
    expect(preview.error).toBeUndefined();
  });
});
