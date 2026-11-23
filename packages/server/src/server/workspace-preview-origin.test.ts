import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspacePreviewOrigin } from "./workspace-preview-origin.js";

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
  it("omits missing or malformed reservations and rejects path traversal", async () => {
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBeNull();
    writeFileSync(join(directory, "workspace.web.json"), "{");
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBeNull();
    expect(await readWorkspacePreviewOrigin("../workspace", "web", directory)).toBeNull();
  });
});
