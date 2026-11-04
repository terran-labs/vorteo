import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import { createLiveDevMiddleware } from "./proxy.js";
import { changeLiveDevMode, readLiveDevMode, LiveDevStateError } from "./state.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

/** A stand-in Metro that records every path it is asked for. */
async function fakeMetro(seen: string[]): Promise<number> {
  return listen((req, res) => {
    seen.push(req.url ?? "");
    if ((req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head></head><body>live page</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("live bundle");
  });
}

async function app(metroPort: number, owner: boolean): Promise<number> {
  const server = express();
  server.use(
    createLiveDevMiddleware({
      port: () => metroPort,
      ownerSession: () => owner,
      label: "Vorteo",
      installation: () => ({}) as ExecutionInstallation,
      logger: pino({ level: "silent" }),
      secureCookies: false,
    }),
  );
  server.use((_req, res) => res.status(200).send("static interface"));
  return listen(server);
}

async function get(port: number, requestPath: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    headers,
    redirect: "manual",
  });
  return {
    status: res.status,
    body: await res.text(),
    cookie: res.headers.get("set-cookie"),
    location: res.headers.get("location"),
  };
}

const page = { accept: "text/html" };

test("only the owner gets live code, and only through allowlisted Metro paths", async () => {
  const seen: string[] = [];
  const metro = await fakeMetro(seen);
  const visitor = await app(metro, false);
  expect((await get(visitor, "/", page)).body).toBe("static interface");
  expect((await get(visitor, "/node_modules/entry.bundle?platform=web")).body).toBe(
    "static interface",
  );

  const owner = await app(metro, true);
  const live = await get(owner, "/settings/general", page);
  expect(live.body).toContain("live page");
  expect(live.body).toContain("vorteo-live-dev-marker");
  expect((await get(owner, "/node_modules/entry.bundle?platform=web")).body).toBe("live bundle");
  // Editor launchers, the debugger and anything unlisted never reach Metro, whether or not
  // the request asks for a page, and encoded or dotted paths cannot be normalized into them.
  const blocked = [
    "/open-stack-frame",
    "/_expo/open",
    "/inspector/device",
    "/json",
    "/message",
    "/assets/%2e%2e/json/list",
    "/assets/../json/list",
    "/assets/..%2fjson",
  ];
  for (const target of blocked) {
    await get(owner, target);
    await get(owner, target, page);
  }
  expect(seen.filter((url) => url !== "/" && !url.endsWith("platform=web"))).toEqual([]);
});

test("the safe interface choice serves static until the owner picks live again", async () => {
  const owner = await app(await fakeMetro([]), true);
  const choose = await get(owner, "/?interface=safe");
  expect(choose.status).toBe(302);
  // The redirect never echoes the request path, so it cannot point at another host.
  expect((await get(owner, "//evil.example?interface=safe")).location).toBe("/");
  const cookie = choose.cookie?.split(";")[0] ?? "";
  expect((await get(owner, "/", { ...page, cookie })).body).toBe("static interface");
  expect((await get(owner, "/?interface=live", { cookie })).cookie).toContain("vorteo-interface=;");
});

test("a stale mode change is refused and an unreadable record never reads as live", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "live-dev-"));
  try {
    const initial = await readLiveDevMode(stateDir);
    expect(initial.mode).toBe("reliable");
    const live = await changeLiveDevMode(stateDir, {
      expectedRevision: initial.revision,
      mode: "live",
    });
    expect(live.mode).toBe("live");
    await expect(
      changeLiveDevMode(stateDir, { expectedRevision: initial.revision, mode: "reliable" }),
    ).rejects.toBeInstanceOf(LiveDevStateError);
    await writeFile(path.join(stateDir, "live-dev.json"), '{"version":1,"mode":"live"');
    await expect(readLiveDevMode(stateDir)).rejects.toBeInstanceOf(LiveDevStateError);
    // The owner can repair it by choosing Reliable, and only Reliable.
    await expect(
      changeLiveDevMode(stateDir, { expectedRevision: "unreadable", mode: "live" }),
    ).rejects.toBeInstanceOf(LiveDevStateError);
    expect(
      (await changeLiveDevMode(stateDir, { expectedRevision: "unreadable", mode: "reliable" }))
        .mode,
    ).toBe("reliable");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
