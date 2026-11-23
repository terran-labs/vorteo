import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchablePreviewOrigins,
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
  describe("matching a link to one preview", () => {
    const write = (workspaceId: string, service: string, origin: string) =>
      writeFileSync(
        join(directory, `${workspaceId}.${service}.json`),
        JSON.stringify({ origin, workspaceId, service }),
      );
    const matchable = async (workspaceId: string) =>
      [
        ...(await matchablePreviewOrigins(
          workspaceId,
          await readWorkspacePreviewOrigins(workspaceId, directory),
          directory,
        )),
      ].sort();

    it("drops an origin that two previews claim, in one workspace or across workspaces", async () => {
      // In Dev an agent can write a reservation naming another preview's origin; neither matches.
      write("workspace", "web", "https://preview.example.ts.net:32780");
      write("workspace", "api", "https://preview.example.ts.net:32780");
      write("workspace", "ui", "https://preview.example.ts.net:32781");
      write("other", "api", "https://preview.example.ts.net:32782");
      write("forger", "web", "https://preview.example.ts.net:32782");
      expect(await matchable("workspace")).toEqual(["https://preview.example.ts.net:32781"]);
      expect(await matchable("other")).toEqual([]);
      expect(await matchable("forger")).toEqual([]);
      // The working link still comes from each preview's own file.
      expect((await readWorkspacePreviewOrigins("other", directory)).get("api")).toBe(
        "https://preview.example.ts.net:32782",
      );
    });

    it("a forged rewrite in place never lets two workspaces match one origin", async () => {
      write("victim", "api", "https://preview.example.ts.net:32782");
      write("forger", "web", "https://preview.example.ts.net:32790");
      expect(await matchable("forger")).toEqual(["https://preview.example.ts.net:32790"]);
      // Rewriting an existing file leaves the directory's time alone, so the index is not rebuilt.
      write("forger", "web", "https://preview.example.ts.net:32782");
      const victim = await matchable("victim");
      const forger = await matchable("forger");
      const stolen = "https://preview.example.ts.net:32782";
      expect(victim.includes(stolen) && forger.includes(stolen)).toBe(false);
      expect(await matchable("forger")).toEqual([]);
    });

    it("trusts no origin past the file cap or when the directory cannot be listed", async () => {
      write("workspace", "web", "https://preview.example.ts.net:32780");
      for (let index = 0; index < 128; index += 1) {
        writeFileSync(join(directory, `filler.s${index}.json`), "{}");
      }
      expect(await matchable("workspace")).toEqual([]);
      const unlistable = join(directory, "not-a-directory");
      writeFileSync(unlistable, "");
      expect(
        await matchablePreviewOrigins(
          "workspace",
          new Map([["web", "https://preview.example.ts.net:32780"]]),
          unlistable,
        ),
      ).toEqual(new Set());
    });
  });
  it("omits missing or malformed reservations and rejects path traversal", async () => {
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBeNull();
    writeFileSync(join(directory, "workspace.web.json"), "{");
    expect(await readWorkspacePreviewOrigin("workspace", "web", directory)).toBeNull();
    expect(await readWorkspacePreviewOrigin("../workspace", "web", directory)).toBeNull();
  });
});
