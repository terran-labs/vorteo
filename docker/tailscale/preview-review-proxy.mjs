#!/usr/bin/env node
// Preview review proxy.
//
// Sits between `tailscale serve` and a preview app on loopback and injects one
// script tag into HTML documents so the Vorteo review toolbar can load. All
// other traffic (assets, API calls, server-sent events, WebSocket upgrades for
// live reload) passes through unchanged and is streamed, never buffered.
//
// Usage:
//   node preview-review-proxy.mjs [--review-origin https://host:port] -- <command> [args...]
//
// The proxy listens on 127.0.0.1:$PASEO_PORT, picks a free loopback port for
// the app, and runs the command with PASEO_PORT set to that port.
//
// Review origin, in order of precedence:
// 1. --review-origin, then VORTEO_REVIEW_ORIGIN: fixed explicit overrides.
// 2. Discovery from the Vorteo daemon. The daemon gives every managed terminal
//    PASEO_TERMINAL_ACTIVITY_URL (a loopback URL carrying a token in its query).
//    The proxy keeps only its port and asks
//    http://127.0.0.1:<port>/api/previews/review-origin, which answers
//    { "origin": "https://host:port" | null }. The origin is null until the
//    owner pairs a browser, so discovery is lazy: an HTML document request
//    starts a lookup (1 second timeout), a found origin is cached for the life
//    of the process, and after a null or failed answer the proxy waits 15
//    seconds before asking again. A document whose response headers arrive
//    before the origin is known passes through uninjected; no request ever
//    waits on discovery. The activity URL's query is never sent or logged.
// Without any origin the proxy is a transparent passthrough, so a missing
// review service never breaks the preview.
//
// Limitations:
// - Only Content-Security-Policy response headers are rewritten. A policy
//   delivered through <meta http-equiv="Content-Security-Policy"> is not, so
//   such a page may block the review script.
// - Policies using 'strict-dynamic' with only hashes (no nonce) cannot admit
//   the injected tag.
// - A response with stacked content codings (for example "gzip, br") or an
//   encoding this Node build cannot decode passes through without injection.

import http from "node:http";
import net from "node:net";
import os from "node:os";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { Transform, pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const MARKER_ATTRIBUTE = "data-vorteo-review";

// Hop-by-hop headers (RFC 9110 section 7.6.1) plus the legacy proxy-connection.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Returns the normalized review origin, or null when the value is not an
 * https origin (or an http loopback origin, which tests use).
 */
export function normalizeReviewOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)) {
    return url.origin;
  }
  return null;
}

export function reviewScriptTag(reviewOrigin, nonce) {
  const nonceAttribute = nonce ? ` nonce="${nonce.replace(/[^A-Za-z0-9+/=_-]/g, "")}"` : "";
  return `<script src="${reviewOrigin}/api/previews/page.js" ${MARKER_ATTRIBUTE}${nonceAttribute} async></script>`;
}

function parsePolicy(policy) {
  return policy
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/);
      return { name: name.toLowerCase(), sources };
    });
}

function withOrigin(sources, origin) {
  const kept = sources.filter((source) => source.toLowerCase() !== "'none'");
  if (!kept.some((source) => source.toLowerCase() === origin.toLowerCase())) kept.push(origin);
  return kept;
}

/**
 * Rewrites one Content-Security-Policy header value (which may hold several
 * comma-joined policies) so `origin` may load scripts and frames. Returns the
 * new value and, when a policy relies on 'strict-dynamic', the first nonce the
 * injected tag must carry. Policies with neither the directive nor default-src
 * already allow the origin and are left alone. Nothing else is loosened.
 */
export function rewriteCsp(value, origin) {
  let nonce = null;
  const policies = String(value)
    .split(",")
    .map((policy) => {
      if (policy.trim() === "") return policy;
      const directives = parsePolicy(policy);
      const find = (name) => directives.find((directive) => directive.name === name);
      const defaultSrc = find("default-src");

      const ensure = (name, fallback) => {
        const existing = find(name);
        if (existing) {
          existing.sources = withOrigin(existing.sources, origin);
          return existing;
        }
        if (!fallback) return null;
        const created = {
          name,
          sources: withOrigin([...fallback.sources], origin),
        };
        directives.push(created);
        return created;
      };

      const scriptSrc = ensure("script-src", defaultSrc);
      const scriptSrcElem = find("script-src-elem") ? ensure("script-src-elem") : null;
      // Frames fall back to child-src, then default-src. Copy the nearest
      // fallback so a frame-src we add is never broader than what applied.
      const childSrc = find("child-src") ? ensure("child-src") : null;
      ensure("frame-src", childSrc ?? defaultSrc);

      const governing = scriptSrcElem ?? scriptSrc;
      if (!nonce && governing) {
        const lower = governing.sources.map((source) => source.toLowerCase());
        if (lower.includes("'strict-dynamic'")) {
          const nonceSource = governing.sources.find((source) => /^'nonce-.+'$/i.test(source));
          if (nonceSource) nonce = nonceSource.slice(7, -1);
        }
      }
      return directives
        .map((directive) => [directive.name, ...directive.sources].join(" "))
        .join("; ");
    });
  return { value: policies.join(", "), nonce };
}

/**
 * Streaming injector. Operates on bytes (markers are ASCII), so multi-byte
 * characters split across chunks are never cut or re-encoded. Holds back only
 * enough bytes to detect a marker split across chunk boundaries.
 */
export function createInjector(tag) {
  const tagBytes = Buffer.from(tag, "utf8");
  const pattern = /<\/(?:head|body)[\s>]/;
  const holdBack = MARKER_ATTRIBUTE.length - 1;
  let pending = Buffer.alloc(0);
  let done = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (done) return callback(null, chunk);
      const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // latin1 maps bytes one to one, so string offsets are byte offsets.
      const text = buffer.toString("latin1").toLowerCase();
      const match = pattern.exec(text);
      const existing = text.indexOf(MARKER_ATTRIBUTE);
      if (existing !== -1 && (!match || existing < match.index)) {
        done = true;
        pending = Buffer.alloc(0);
        return callback(null, buffer);
      }
      if (match) {
        done = true;
        pending = Buffer.alloc(0);
        this.push(buffer.subarray(0, match.index));
        this.push(tagBytes);
        return callback(null, buffer.subarray(match.index));
      }
      const emit = Math.max(0, buffer.length - holdBack);
      pending = Buffer.from(buffer.subarray(emit));
      callback(null, emit > 0 ? buffer.subarray(0, emit) : undefined);
    },
    flush(callback) {
      if (done) return callback();
      if (pending.length) this.push(pending);
      // No </head> or </body>: append so the toolbar still loads.
      callback(null, tagBytes);
    },
  });
}

/**
 * Inject into a complete HTML string. Convenience for tests and callers that
 * already hold the document; the proxy itself uses createInjector.
 */
export function injectIntoHtml(html, tag) {
  const lower = html.toLowerCase();
  const match = /<\/(?:head|body)[\s>]/.exec(lower);
  const existing = lower.indexOf(MARKER_ATTRIBUTE);
  if (existing !== -1 && (!match || existing < match.index)) return html;
  if (!match) return html + tag;
  return html.slice(0, match.index) + tag + html.slice(match.index);
}

function createDecoder(encoding) {
  // Generous flush settings tolerate apps that end a stream without a final block.
  const options = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  switch (encoding) {
    case "":
    case "identity":
      return { stream: null };
    case "gzip":
    case "x-gzip":
      return { stream: zlib.createGunzip(options) };
    case "deflate":
      return { stream: zlib.createInflate(options) };
    case "br":
      return {
        stream: zlib.createBrotliDecompress({
          finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
        }),
      };
    case "zstd":
      return typeof zlib.createZstdDecompress === "function"
        ? { stream: zlib.createZstdDecompress() }
        : null;
    default:
      return null;
  }
}

function connectionTokens(rawHeaders) {
  const tokens = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === "connection") {
      for (const token of rawHeaders[i + 1].split(",")) tokens.add(token.trim().toLowerCase());
    }
  }
  return tokens;
}

function filterHeaders(rawHeaders, { keep = [], drop = [] } = {}) {
  const listed = connectionTokens(rawHeaders);
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (drop.includes(name)) continue;
    if ((HOP_BY_HOP.has(name) || listed.has(name)) && !keep.includes(name)) continue;
    out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return out;
}

function headerValue(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function isHtmlDocumentRequest(req) {
  if (req.method !== "GET") return false;
  if (req.headers.range) return false;
  if (headerValue(req.headers, "x-requested-with").toLowerCase() === "xmlhttprequest") return false;
  if (headerValue(req.headers, "sec-fetch-dest").toLowerCase() === "empty") return false;
  return true;
}

function isInjectableResponse(upRes) {
  const status = upRes.statusCode ?? 0;
  if (status === 204 || status === 206 || status === 304) return false;
  if (!(status >= 200 && status < 300) && !(status >= 400 && status < 600)) return false;
  return /^\s*text\/html\s*(?:;|$)/i.test(headerValue(upRes.headers, "content-type"));
}

function sendBadGateway(res) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = "Preview app is not accepting connections yet. Retry in a moment.\n";
  res.writeHead(502, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Derives the daemon's review-origin endpoint from PASEO_TERMINAL_ACTIVITY_URL.
 * Only the port survives; the path and token-bearing query are discarded.
 * Returns null unless the URL is plain http on a loopback host.
 */
export function daemonReviewOriginUrl(activityUrl) {
  if (typeof activityUrl !== "string" || activityUrl === "") return null;
  let url;
  try {
    url = new URL(activityUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) return null;
  return `http://127.0.0.1:${url.port || "80"}/api/previews/review-origin`;
}

/**
 * Returns an async function that asks the daemon for its review origin, or
 * null when the activity URL is unusable. The function resolves to the raw
 * origin string or null; callers validate it.
 */
export function createDaemonOriginResolver(activityUrl) {
  const endpoint = daemonReviewOriginUrl(activityUrl);
  if (!endpoint) return null;
  return ({ signal } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.get(endpoint, { agent: false, signal }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16 * 1024) req.destroy(new Error("review origin response too large"));
          else chunks.push(chunk);
        });
        res.on("end", () => resolve(parseOriginAnswer(Buffer.concat(chunks))));
        res.on("error", reject);
      });
      req.on("error", reject);
    });
}

function parseOriginAnswer(body) {
  try {
    const origin = JSON.parse(body.toString("utf8"))?.origin;
    return typeof origin === "string" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Lazy, cached review-origin lookup. `current()` never waits; `request()`
 * starts a lookup unless one is running, an origin is cached, or the last
 * empty answer is younger than retryIntervalMs.
 */
function createOriginSource({
  reviewOrigin,
  resolveReviewOrigin,
  retryIntervalMs = 15_000,
  lookupTimeoutMs = 1_000,
}) {
  let origin = normalizeReviewOrigin(reviewOrigin ?? "");
  let pending = false;
  let lastEmptyAt = -Infinity;
  const request = () => {
    if (origin || pending || typeof resolveReviewOrigin !== "function") return;
    if (Date.now() - lastEmptyAt < retryIntervalMs) return;
    pending = true;
    void lookup().finally(() => {
      pending = false;
    });
  };
  const lookup = async () => {
    const controller = new AbortController();
    let timer;
    // Race the timeout too, in case a resolver ignores the abort signal.
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, lookupTimeoutMs);
      timer.unref?.();
    });
    let found = null;
    try {
      const value = await Promise.race([
        resolveReviewOrigin({ signal: controller.signal }),
        timeout,
      ]);
      found = controller.signal.aborted ? null : normalizeReviewOrigin(value ?? "");
    } catch {
      found = null;
    } finally {
      clearTimeout(timer);
    }
    if (found) origin = found;
    else lastEmptyAt = Date.now();
  };
  return { current: () => origin, request };
}

function handleRequest(req, res, { target, origins }) {
  const isDocument = isHtmlDocumentRequest(req);
  if (isDocument) origins.request();
  // Transfer-Encoding stays on requests: Node re-frames a chunked body itself.
  const headers = filterHeaders(req.rawHeaders, {
    keep: ["transfer-encoding"],
  });
  const upReq = http.request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers,
    setHost: false,
  });

  res.on("close", () => {
    if (!res.writableFinished) upReq.destroy();
  });
  req.on("error", () => upReq.destroy());

  upReq.on("error", () => sendBadGateway(res));
  upReq.on("response", (upRes) => {
    // Read the origin only now: a lookup still in flight never delays the page.
    const reviewOrigin = isDocument ? origins.current() : null;
    const wantsInjection = Boolean(reviewOrigin);
    const encoding = headerValue(upRes.headers, "content-encoding").trim().toLowerCase();
    const decoder = wantsInjection && isInjectableResponse(upRes) ? createDecoder(encoding) : null;

    if (!decoder) {
      res.writeHead(upRes.statusCode, upRes.statusMessage, filterHeaders(upRes.rawHeaders));
      res.flushHeaders();
      pipeline(upRes, res, () => {});
      return;
    }

    let nonce = null;
    const outHeaders = [];
    const filtered = filterHeaders(upRes.rawHeaders, {
      drop: ["content-length", "content-encoding", "content-md5", "digest", "content-digest"],
    });
    for (let i = 0; i < filtered.length; i += 2) {
      let value = filtered[i + 1];
      if (filtered[i].toLowerCase() === "content-security-policy") {
        const rewritten = rewriteCsp(value, reviewOrigin);
        value = rewritten.value;
        nonce ??= rewritten.nonce;
      }
      outHeaders.push(filtered[i], value);
    }
    res.writeHead(upRes.statusCode, upRes.statusMessage, outHeaders);
    res.flushHeaders();
    const stages = [upRes];
    if (decoder.stream) stages.push(decoder.stream);
    stages.push(createInjector(reviewScriptTag(reviewOrigin, nonce)), res);
    pipeline(...stages, (error) => {
      if (error) res.destroy();
    });
  });

  pipeline(req, upReq, () => {});
}

function handleUpgrade(req, socket, head, { target }) {
  // Raw passthrough: replay the request head exactly as parsed, then splice
  // the two sockets. Nothing past the handshake is inspected.
  const upstream = net.connect({ host: target.host, port: target.port });
  const destroyBoth = () => {
    socket.destroy();
    upstream.destroy();
  };
  let connected = false;
  socket.on("error", destroyBoth);
  upstream.on("error", () => {
    if (!connected) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      upstream.destroy();
      return;
    }
    destroyBoth();
  });
  upstream.on("connect", () => {
    connected = true;
    let requestHead = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      requestHead += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(requestHead + "\r\n");
    if (head?.length) upstream.write(head);
    // pipe() propagates half-close; once either side is fully closed nothing
    // more can be delivered, so release the other one.
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
}

/**
 * Creates the proxy server (not yet listening). Pass a fixed `reviewOrigin`,
 * or a `resolveReviewOrigin({ signal })` async function for lazy discovery
 * (retryIntervalMs and lookupTimeoutMs tune it). With neither it is a
 * transparent passthrough.
 */
export function createReviewProxy({
  target,
  reviewOrigin = null,
  resolveReviewOrigin = null,
  retryIntervalMs,
  lookupTimeoutMs,
}) {
  const options = {
    target,
    origins: createOriginSource({
      reviewOrigin,
      resolveReviewOrigin,
      retryIntervalMs,
      lookupTimeoutMs,
    }),
  };
  const server = http.createServer((req, res) => handleRequest(req, res, options));
  // A transparent proxy must not cut off long uploads or slow streams.
  server.requestTimeout = 0;
  server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head, options));
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export function parseCliArgs(argv) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  let reviewOrigin;
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--review-origin") {
      reviewOrigin = own[i + 1];
      i += 1;
    } else if (own[i].startsWith("--review-origin=")) {
      reviewOrigin = own[i].slice("--review-origin=".length);
    } else {
      throw new Error(`Unknown option: ${own[i]}`);
    }
  }
  return { reviewOrigin, command };
}

async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`preview-review-proxy: ${error.message}\n`);
    process.exit(2);
  }
  const usage = "Usage: preview-review-proxy.mjs [--review-origin URL] -- <command> [args...]";
  if (parsed.command.length === 0) {
    process.stderr.write(`preview-review-proxy: missing command. ${usage}\n`);
    process.exit(2);
  }
  const outerPort = Number(process.env.PASEO_PORT);
  if (!Number.isInteger(outerPort) || outerPort < 1 || outerPort > 65535) {
    process.stderr.write("preview-review-proxy: PASEO_PORT must be an integer port.\n");
    process.exit(2);
  }

  const rawOrigin = parsed.reviewOrigin ?? process.env.VORTEO_REVIEW_ORIGIN;
  const reviewOrigin = normalizeReviewOrigin(rawOrigin ?? "");
  // An explicit but invalid override still falls back to discovery.
  const resolveReviewOrigin = reviewOrigin
    ? null
    : createDaemonOriginResolver(process.env.PASEO_TERMINAL_ACTIVITY_URL);
  if (rawOrigin && !reviewOrigin) {
    process.stderr.write("preview-review-proxy: ignoring invalid review origin override.\n");
  }
  if (!reviewOrigin && resolveReviewOrigin) {
    process.stderr.write(
      "preview-review-proxy: review injection is waiting for the daemon's review origin.\n",
    );
  } else if (!reviewOrigin) {
    process.stderr.write(
      "preview-review-proxy: no review origin and no daemon to ask; review injection is off.\n",
    );
  }

  const appPort = await freeLoopbackPort();
  const server = createReviewProxy({
    target: { host: "127.0.0.1", port: appPort },
    reviewOrigin,
    resolveReviewOrigin,
  });
  await new Promise((resolve) => {
    server.once("error", (error) => {
      process.stderr.write(
        `preview-review-proxy: cannot listen on 127.0.0.1:${outerPort}: ${error.message}\n`,
      );
      process.exit(1);
    });
    server.listen(outerPort, "127.0.0.1", resolve);
  });

  const useShell = parsed.command.length === 1 && /\s/.test(parsed.command[0]);
  const [file, args] = useShell
    ? ["sh", ["-c", parsed.command[0]]]
    : [parsed.command[0], parsed.command.slice(1)];
  const child = spawn(file, args, {
    stdio: "inherit",
    env: { ...process.env, PASEO_PORT: String(appPort) },
  });

  const killChild = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.on("exit", killChild);
  process.on("uncaughtException", (error) => {
    process.stderr.write(`preview-review-proxy: ${error.stack ?? error}\n`);
    killChild();
    process.exit(1);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  }

  child.on("error", (error) => {
    process.stderr.write(`preview-review-proxy: cannot start command: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    server.close();
    if (code !== null) process.exit(code);
    process.exit(128 + (os.constants.signals[signal] ?? 1));
  });
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
