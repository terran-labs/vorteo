import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PreviewVersion } from "@getpaseo/protocol/previews";
import { createPreviewsRouter, SNAPSHOT_CSP } from "./routes.js";
import { PreviewsService } from "./service.js";
import {
  KEEP_UNRATED_PER_LINEAGE,
  PreviewStore,
  resolveSnapshotPath,
  selectPrunable,
} from "./store.js";

let root: string;
let store: PreviewStore;
let delivered: { agentId: string; messageId: string; text: string }[];
let baseUrl: string;
let close: () => Promise<void>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "previews-test-"));
  store = new PreviewStore(path.join(root, "store"));
  delivered = [];
  const service = new PreviewsService({
    store,
    deliver: async (agentId, messageId, text) => {
      delivered.push({ agentId, messageId, text });
    },
    describeAgent: () => ({ title: "Deck author", workspaceId: "wks_test" }),
    onChanged: () => undefined,
    loopbackBaseUrl: () => null,
    warn: () => undefined,
  });
  const app = express();
  app.use("/api/previews", createPreviewsRouter(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
});

async function publishDeck(): Promise<PreviewVersion> {
  const source = path.join(root, "deck");
  await mkdir(path.join(source, "assets"), { recursive: true });
  await writeFile(path.join(source, "index.html"), "<html><head></head><body>Slide</body></html>");
  await writeFile(path.join(source, "assets", "app.js"), "console.log(1)");
  await writeFile(path.join(source, ".env.local"), "SECRET=1");
  // A link out of the published directory must not be followed into the snapshot.
  await writeFile(path.join(root, "outside.txt"), "private");
  await symlink(path.join(root, "outside.txt"), path.join(source, "leak.txt"));
  return store.publish(
    { title: "Deck", kind: "deck", lineage: "deck", path: source },
    { agentId: "agent-1" },
  );
}

async function pair(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/previews/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ ticket: store.mintTicket() }),
  });
  return ((await response.json()) as { reviewKey: string }).reviewKey;
}

function annotate(headers: Record<string, string>, versionId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/previews/review/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ target: { versionId }, comment: "Make the title larger", rating: 4 }),
  });
}

describe("owner feedback cannot be forged by a previewed page", () => {
  test("only a paired browser posting from the daemon origin reaches the thread", async () => {
    const version = await publishDeck();
    const key = await pair();
    const pageOrigin = "http://127.0.0.1:1";

    // A script in the previewed page: cross-origin, and it cannot read the key.
    expect((await annotate({ origin: pageOrigin }, version.id)).status).toBe(403);
    // Even a leaked key is refused from another origin.
    expect(
      (await annotate({ origin: pageOrigin, "x-vorteo-review-key": key }, version.id)).status,
    ).toBe(403);
    // Same origin without a key, with a wrong key, and with no Origin header at all.
    expect((await annotate({ origin: baseUrl }, version.id)).status).toBe(401);
    expect(
      (await annotate({ origin: baseUrl, "x-vorteo-review-key": "wrong" }, version.id)).status,
    ).toBe(401);
    expect((await annotate({ "x-vorteo-review-key": key }, version.id)).status).toBe(403);
    expect(delivered).toHaveLength(0);
    expect((await store.getVersion(version.id))?.annotations).toHaveLength(0);

    const accepted = await annotate({ origin: baseUrl, "x-vorteo-review-key": key }, version.id);
    expect(accepted.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.agentId).toBe("agent-1");
    expect(delivered[0]?.text).toContain("Preview feedback from the owner.");
    expect(delivered[0]?.text).toContain(version.id);
    expect((await store.getVersion(version.id))?.rating).toBe(4);
  });

  test("a pairing ticket works once, and only from the daemon origin", async () => {
    const ticket = store.mintTicket();
    const redeem = (origin: string) =>
      fetch(`${baseUrl}/api/previews/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ ticket }),
      });
    expect((await redeem("http://127.0.0.1:1")).status).toBe(403);
    expect((await redeem(baseUrl)).status).toBe(200);
    expect((await redeem(baseUrl)).status).toBe(403);
    expect(await store.redeemTicket(store.mintTicket(0), 10 * 60_000)).toBeNull();
    expect(await store.reviewOrigin()).toBe(baseUrl);
  });
});

describe("snapshots", () => {
  test("are frozen without links or environment files and served sandboxed", async () => {
    const version = await publishDeck();
    const entry = await fetch(`${baseUrl}/api/previews/snap/${version.id}/`);
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-security-policy")).toBe(SNAPSHOT_CSP);
    expect(await entry.text()).toContain("data-vorteo-review");
    for (const leaked of ["leak.txt", ".env.local", "..%2f..%2findex.json", "%2e%2e/index.json"]) {
      const response = await fetch(`${baseUrl}/api/previews/snap/${version.id}/${leaked}`);
      expect(response.status, leaked).toBeGreaterThanOrEqual(400);
    }
  });

  test("path resolution never leaves the snapshot", () => {
    const filesRoot = "/store/versions/abc/files";
    expect(resolveSnapshotPath(filesRoot, "assets/app.js")).toBe(`${filesRoot}/assets/app.js`);
    for (const escape of ["../x", "a/../../x", "%2e%2e/x", "a\\..\\x", "a%00b", "%zz"])
      expect(resolveSnapshotPath(filesRoot, escape), escape).toBeNull();
  });
});

test("retention removes only old versions the owner never touched", () => {
  const version = (number: number, extra: Partial<PreviewVersion> = {}): PreviewVersion => ({
    id: `version-${String(number).padStart(12, "0")}`,
    lineage: "deck",
    number,
    title: "Deck",
    kind: "deck",
    createdAt: new Date(number * 1000).toISOString(),
    agentId: "agent-1",
    sizeBytes: 1,
    hasThumbnail: false,
    rating: null,
    approved: false,
    annotations: [],
    ...extra,
  });
  const versions = Array.from({ length: KEEP_UNRATED_PER_LINEAGE + 4 }, (_, index) =>
    version(index + 1),
  );
  versions[0] = version(1, { rating: 2 });
  versions[1] = version(2, { approved: true });
  versions[2] = version(3, { variantSetId: "deck:fonts" });
  const variantSets = [
    {
      id: "deck:fonts",
      title: "Fonts",
      versionIds: [versions[2]!.id],
      winnerVersionId: null,
      reason: null,
      pickedAt: null,
    },
  ];
  // Twelve versions; three protected, the newest always kept, seven more unrated kept.
  expect(selectPrunable({ versions, variantSets })).toEqual([versions[3]!.id]);
});
