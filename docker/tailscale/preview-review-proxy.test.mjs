import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDaemonOriginResolver,
  createReviewProxy,
  rewriteCsp,
} from "./preview-review-proxy.mjs";

const REVIEW = "https://review.example.ts.net:8443";
const TAG = `<script src="${REVIEW}/api/previews/page.js" data-vorteo-review async></script>`;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

// Starts an upstream app and a proxy in front of it; both close after the test.
async function harness(t, handler, { reviewOrigin = REVIEW, ...discovery } = {}) {
  const upstream = http.createServer(handler);
  const upstreamPort = await listen(upstream);
  const proxy = createReviewProxy({
    target: { host: "127.0.0.1", port: upstreamPort },
    reviewOrigin,
    ...discovery,
  });
  const port = await listen(proxy);
  t.after(() => {
    upstream.closeAllConnections();
    proxy.closeAllConnections();
    upstream.close();
    proxy.close();
  });
  return { upstream, proxy, port };
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

// Writes a body in pieces with a pause between them so the proxy sees
// separate chunks, splitting `</head>` across a boundary.
async function writeSplit(res, body) {
  const at = body.indexOf("</he") + 3;
  const parts = [body.subarray(0, at), body.subarray(at)];
  for (const part of parts) {
    res.write(part);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  res.end();
}

test("injects the review tag into plain, gzip, br and chunked HTML with split markers", async (t) => {
  // Multi-byte text right before the split point guards byte-level handling.
  const html = Buffer.from(
    "<!doctype html><html><head><title>Ünïcødé ✓</title></head><body>hi</body></html>",
  );
  const encoders = {
    identity: (buffer) => buffer,
    gzip: zlib.gzipSync,
    br: zlib.brotliCompressSync,
  };
  const { port } = await harness(t, async (req, res) => {
    const encoding = new URL(req.url, "http://x").searchParams.get("enc");
    const body = encoders[encoding](html);
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (encoding !== "identity") headers["content-encoding"] = encoding;
    if (req.url.includes("length")) headers["content-length"] = body.length;
    res.writeHead(200, headers);
    if (encoding === "identity") await writeSplit(res, body);
    else res.end(body);
  });
  const expected = html.toString().replace("</head>", `${TAG}</head>`);
  for (const path of ["/?enc=identity", "/?enc=identity&length", "/?enc=gzip&length", "/?enc=br"]) {
    const { res, body } = await get(port, path, {
      "accept-encoding": "gzip, br",
    });
    assert.equal(body.toString("utf8"), expected, path);
    assert.equal(res.headers["content-encoding"], undefined, path);
    assert.equal(res.headers["content-length"], undefined, path);
  }
});

test("non-HTML responses and script-fetched HTML fragments pass through byte for byte", async (t) => {
  const script = zlib.gzipSync(Buffer.from("console.log('</head>');".repeat(50)));
  const fragment = "<div>fragment</div></head>";
  const { port } = await harness(t, (req, res) => {
    if (req.url === "/app.js") {
      res.writeHead(200, {
        "content-type": "text/javascript",
        "content-encoding": "gzip",
        "content-length": script.length,
        "x-app": "kept",
      });
      res.end(script);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fragment);
  });
  const asset = await get(port, "/app.js", { "accept-encoding": "gzip" });
  assert.deepEqual(asset.body, script);
  assert.equal(asset.res.headers["content-encoding"], "gzip");
  assert.equal(asset.res.headers["content-length"], String(script.length));
  assert.equal(asset.res.headers["x-app"], "kept");
  const partial = await get(port, "/partial", { "sec-fetch-dest": "empty" });
  assert.equal(partial.body.toString(), fragment);
});

test("WebSocket upgrades are spliced raw in both directions", async (t) => {
  const { upstream, port } = await harness(t, (_req, res) => res.end());
  let seenHost;
  upstream.on("upgrade", (req, socket) => {
    seenHost = req.headers.host;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
    socket.on("end", () => socket.end());
  });
  const client = net.connect(port, "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  client.write(
    "GET /_hmr HTTP/1.1\r\nHost: preview.example.ts.net:9001\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
  let received = "";
  client.on("data", (data) => {
    received += data.toString("latin1");
  });
  const waitFor = async (text) => {
    while (!received.includes(text)) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  await waitFor("\r\n\r\n");
  assert.match(received, /^HTTP\/1\.1 101/);
  const frame = Buffer.from([0x81, 0x02, 0x68, 0x69, 0xff, 0x00]);
  client.write(frame);
  await waitFor("echo:");
  await waitFor("\u0000");
  assert.ok(received.endsWith(`echo:${frame.toString("latin1")}`));
  assert.equal(seenHost, "preview.example.ts.net:9001");
});

test("server-sent events flush before the upstream stream ends", async (t) => {
  let finish;
  const { port } = await harness(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    finish = () => res.end("data: last\n\n");
  });
  const res = await new Promise((resolve) =>
    http.get({ host: "127.0.0.1", port, path: "/events", agent: false }, resolve),
  );
  const [first] = await once(res, "data");
  assert.equal(first.toString(), "data: first\n\n");
  finish();
  await once(res, "end");
});

test("rewrites CSP so the review script and frame load without loosening anything else", () => {
  const cases = [
    {
      name: "default-src only",
      csp: "default-src 'self'; img-src *",
      expected: `default-src 'self'; img-src *; script-src 'self' ${REVIEW}; frame-src 'self' ${REVIEW}`,
      nonce: null,
    },
    {
      name: "explicit script-src and frame-src",
      csp: "script-src 'self' cdn.example; frame-src 'none'; object-src 'none'",
      expected: `script-src 'self' cdn.example ${REVIEW}; frame-src ${REVIEW}; object-src 'none'`,
      nonce: null,
    },
    {
      name: "strict-dynamic with nonce, two policies",
      csp: "script-src 'nonce-abc123' 'strict-dynamic', default-src 'self'",
      expected: `script-src 'nonce-abc123' 'strict-dynamic' ${REVIEW}, default-src 'self'; script-src 'self' ${REVIEW}; frame-src 'self' ${REVIEW}`,
      nonce: "abc123",
    },
    {
      name: "no fetch directives",
      csp: "upgrade-insecure-requests",
      expected: "upgrade-insecure-requests",
      nonce: null,
    },
  ];
  for (const { name, csp, expected, nonce } of cases) {
    assert.deepEqual(rewriteCsp(csp, REVIEW), { value: expected, nonce }, name);
  }
});

test("CSP headers are rewritten on documents, report-only is untouched, nonce reaches the tag", async (t) => {
  const { port } = await harness(t, (_req, res) => {
    res.setHeader("content-type", "text/html");
    res.setHeader("content-security-policy", "script-src 'nonce-n0nce' 'strict-dynamic'");
    res.setHeader("content-security-policy-report-only", "script-src 'self'");
    res.end("<html><head></head></html>");
  });
  const { res, body } = await get(port, "/");
  assert.equal(
    res.headers["content-security-policy"],
    `script-src 'nonce-n0nce' 'strict-dynamic' ${REVIEW}`,
  );
  assert.equal(res.headers["content-security-policy-report-only"], "script-src 'self'");
  assert.match(body.toString(), /data-vorteo-review nonce="n0nce" async><\/script><\/head>/);
});

test("without a review origin the proxy is a transparent passthrough", async (t) => {
  const html = "<html><head></head><body></body></html>";
  const { port } = await harness(
    t,
    (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'",
      });
      res.end(html);
    },
    { reviewOrigin: null },
  );
  const { res, body } = await get(port, "/");
  assert.equal(body.toString(), html);
  assert.equal(res.headers["content-security-policy"], "default-src 'self'");
});

test("discovers the review origin from the daemon lazily and retries after a null answer", async (t) => {
  let answer = null;
  const daemonRequests = [];
  const daemon = http.createServer((req, res) => {
    daemonRequests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ origin: answer }));
  });
  const daemonPort = await listen(daemon);
  t.after(() => daemon.close());
  const resolveReviewOrigin = createDaemonOriginResolver(
    `http://127.0.0.1:${daemonPort}/api/terminal-activity?token=secret-token`,
  );
  const html = "<html><head></head><body></body></html>";
  const { port } = await harness(
    t,
    (_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(html);
    },
    { reviewOrigin: null, resolveReviewOrigin, retryIntervalMs: 100 },
  );
  const waitForLookups = async (count) => {
    while (daemonRequests.length < count) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  assert.equal((await get(port, "/")).body.toString(), html);
  await waitForLookups(1);
  answer = REVIEW;
  // Inside the retry window: no new lookup, still untouched.
  assert.equal((await get(port, "/")).body.toString(), html);
  assert.equal(daemonRequests.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 120));
  await get(port, "/"); // Starts the retry; this response may beat it.
  await waitForLookups(2);
  assert.equal((await get(port, "/")).body.toString(), html.replace("</head>", `${TAG}</head>`));
  // The origin is cached, and the token never reaches the daemon endpoint.
  await get(port, "/");
  assert.deepEqual(daemonRequests, ["/api/previews/review-origin", "/api/previews/review-origin"]);
});

test("wrapper mode listens on PASEO_PORT, gives the app another port, and stops on SIGTERM", async (t) => {
  const probe = net.createServer();
  const outerPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const app = `
    const http = require("node:http");
    http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<head></head>" + process.env.PASEO_PORT + "|" + process.env.PASEO_PREVIEW_ORIGIN);
    }).listen(Number(process.env.PASEO_PORT), "127.0.0.1");
    process.on("SIGTERM", () => process.exit(0));
  `;
  const proxyEntry = fileURLToPath(new URL("./preview-review-proxy.mjs", import.meta.url));
  const proxy = spawn(
    process.execPath,
    [proxyEntry, "--review-origin", REVIEW, "--", process.execPath, "-e", app],
    {
      env: {
        ...process.env,
        PASEO_PORT: String(outerPort),
        PASEO_PREVIEW_ORIGIN: "https://p.example",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  t.after(() => proxy.kill("SIGKILL"));

  let response;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      response = await get(outerPort, "/");
      if (response.res.statusCode === 200) break;
    } catch {
      // The proxy is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(response?.res.statusCode, 200);
  const [, innerPort, origin] = /<\/head>(\d+)\|(.*)$/.exec(response.body.toString());
  assert.notEqual(Number(innerPort), outerPort);
  assert.equal(origin, "https://p.example");
  assert.ok(response.body.toString().startsWith(`<head>${TAG}</head>`));
  // Bound to loopback only: a non-loopback local address must not reach it.
  const external = Object.values((await import("node:os")).networkInterfaces())
    .flat()
    .find((address) => address && address.family === "IPv4" && !address.internal);
  if (external) {
    const socket = net.connect(outerPort, external.address);
    socket.on("connect", () => socket.destroy());
    await assert.rejects(once(socket, "connect"), external.address);
  }

  proxy.kill("SIGTERM");
  const [code] = await once(proxy, "exit");
  assert.equal(code, 0);
  await assert.rejects(get(Number(innerPort), "/"));
});
