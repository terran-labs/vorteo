import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWorkspacePreviewOrigin,
  readWorkspacePreviewOrigins,
} from "./workspace-preview-origin.js";

describe("workspace preview origins", async () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "preview-origin-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  function reserve(origin: string, workspaceId = "workspace", service = "web") {
    writeFileSync(
      join(directory, "workspace.web.json"),
      JSON.stringify({ origin, workspaceId, service }),
    );
  }
  it("returns the exact broker HTTPS reservation, including its port", async () => {
    reserve("https://preview.example.ts.net:32780");
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBe(
      "https://preview.example.ts.net:32780",
    );
  });
  it("does not borrow another workspace or service reservation", async () => {
    reserve("https://preview.example.ts.net:32780", "other");
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBeNull();
    reserve("https://preview.example.ts.net:32780", "workspace", "other");
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBeNull();
  });
  it.each([
    "http://preview.example.ts.net:32780",
    "https://localhost:32780",
    "https://preview.example.ts.net.evil.test",
    "https://user:secret@preview.example.ts.net",
    "https://preview.example.ts.net/path",
    "javascript:alert(1)",
  ])("rejects an invalid broker origin: %s", async (origin) => {
    reserve(origin);
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBeNull();
  });
  it("drops an origin that two services of the workspace claim", async () => {
    // In Dev an agent can write a reservation naming another service's origin; neither matches.
    const write = (service: string, origin: string) =>
      writeFileSync(
        join(directory, `workspace.${service}.json`),
        JSON.stringify({ origin, workspaceId: "workspace", service }),
      );
    write("web", "https://preview.example.ts.net:32780");
    write("api", "https://preview.example.ts.net:32780");
    write("ui", "https://preview.example.ts.net:32781");
    const origins = await readWorkspacePreviewOrigins("workspace", directory);
    expect([...origins.keys()]).toEqual(["ui"]);
  });
  it("omits missing or malformed reservations and rejects path traversal", async () => {
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBeNull();
    writeFileSync(join(directory, "workspace.web.json"), "{");
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBeNull();
    expect(await readWorkspacePreviewOrigin("../workspace", "web", directory)).toBeNull();
  });
});
