import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import { INJECTED_BODY_HTML } from "../../web-ui.js";
import { createLiveDevMiddleware } from "./proxy.js";
import { changeLiveDevMode, readLiveDevMode, LiveDevStateError } from "./state.js";
import { resolveTarget } from "./service.js";
import type { InstallationConfig } from "../config.js";

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

async function app(metroPort: number, owner: boolean, upstreamHost?: string): Promise<number> {
  const server = express();
  server.use(
    createLiveDevMiddleware({
      ...(upstreamHost ? { upstreamHost } : {}),
      port: () => metroPort,
      ownerSession: () => owner,
      label: "Vorteo",
      installation: () => ({}) as ExecutionInstallation,
      logger: pino({ level: "silent" }),
      secureCookies: false,
      liveMode: () => true,
      serverStatus: () => ({ state: "ready", detail: null }),
    }),
  );
  // Stands in for the static page server, which places the requested indicator in the page.
  server.use((_req, res) => {
    const indicator: unknown = res.locals[INJECTED_BODY_HTML];
    res.status(200).send(`static interface${typeof indicator === "string" ? indicator : ""}`);
  });
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
  // Visitors never see the owner's Live dev indicator.
  expect((await get(visitor, "/", page)).body).toBe("static interface");
  expect((await get(visitor, "/node_modules/entry.bundle?platform=web")).body).toBe(
    "static interface",
  );

  const owner = await app(metro, true);
  const live = await get(owner, "/settings/general", page);
  expect(live.body).toContain("live page");
  expect(live.body).toContain('data-state="live"');
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

test("the custom domain reaches Metro as the canonical host it admits", async () => {
  const hosts: string[] = [];
  const metro = await listen((req, res) => {
    hosts.push(req.headers.host ?? "");
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head></head><body>live page</body></html>");
  });
  const owner = await app(metro, true, "lab.tail0.ts.net:44444");
  const live = await get(owner, "/", { ...page, host: "lab.example.com" });
  expect(live.body).toContain("live page");
  expect(hosts).toEqual(["lab.tail0.ts.net:44444"]);
});

test("a slow live page reuses the last one instead of falling back to static", async () => {
  let pages = 0;
  const metro = await listen((req, res) => {
    // The first page answers; later ones fail, as a timeout under load would.
    if ((req.headers.accept ?? "").includes("text/html") && pages++ === 0) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>live page</body></html>");
      return;
    }
    res.writeHead(503).end();
  });
  const owner = await app(metro, true);
  expect((await get(owner, "/", page)).body).toContain("live page");
  const again = await get(owner, "/", page);
  expect(again.body).toContain("live page");
  expect(again.cookie).toBeNull();
});

test("the safe interface choice serves static until the owner picks live again", async () => {
  const owner = await app(await fakeMetro([]), true);
  const choose = await get(owner, "/?interface=safe");
  expect(choose.status).toBe(302);
  // The redirect never echoes the request path, so it cannot point at another host.
  expect((await get(owner, "//evil.example?interface=safe")).location).toBe("/");
  const cookie = choose.cookie?.split(";")[0] ?? "";
  // The static page still carries the indicator, in its safe state.
  const safe = (await get(owner, "/", { ...page, cookie })).body;
  expect(safe).toContain("static interface");
  expect(safe).toContain('data-state="safe"');
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
    // Delivery mode follows the installation type, so its record is the one that matters.
    await writeFile(path.join(stateDir, "installation-type.json"), '{"version":1,"type":"lab"');
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

test("live dev uses the .ts.net address whether it is canonical or the recovery origin", () => {
  const base = {
    stateDir: "/state",
    deployment: { hostReleaseLink: "/host/current", sourceDirectory: "/host/source" },
  };
  const tsnet = "https://machine.tail123.ts.net:44444";
  const custom = "https://vorteo.example.com";
  const resolve = (origins: { public: string; recoveryOrigin?: string }) =>
    resolveTarget({
      ...base,
      public: { origin: origins.public },
      recoveryOrigin: origins.recoveryOrigin,
    } as unknown as InstallationConfig);
  expect(resolve({ public: tsnet, recoveryOrigin: custom })).toMatchObject({ origin: tsnet });
  // A custom-domain canonical address keeps its .ts.net address as the recovery origin.
  expect(resolve({ public: custom, recoveryOrigin: tsnet })).toMatchObject({ origin: tsnet });
  expect(typeof resolve({ public: custom })).toBe("string");
});
