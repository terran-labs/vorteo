import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import type { Request, RequestHandler, Response } from "express";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import { INJECTED_BODY_HTML, prepareWebUiHtml } from "../../web-ui.js";
import {
  injectBeforeBodyEnd,
  liveDevIndicatorHtml,
  type LiveDevIndicatorState,
} from "./indicator.js";

/**
 * Serves the live dev server to the owner's browser in live dev mode. Everything else, and
 * every failure, falls through to the static interface, which live edits never touch.
 *
 * Only paths the web app needs reach Metro. Its editor launchers, debugger and message socket
 * would let any page on this origin open files or run code on Host, so they never pass.
 */

const PAGE_TIMEOUT_MS = 5_000;
/** A cold web bundle took 74 seconds on VortLab; leave room for a slower machine. */
const ASSET_TIMEOUT_MS = 180_000;
/** After a failed page fetch the static page's own assets must not go to Metro either. */
const FALLBACK_SECONDS = 60;
export const INTERFACE_COOKIE = "vorteo-interface";
/** Request headers that never reach Metro, which runs code from the live checkout. */
const CREDENTIAL_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);

/**
 * Bundles, source maps and assets the dev page loads, judged on the raw request path. Encoded
 * characters, backslashes, empty and dot segments are refused outright, because Metro
 * normalizes them and could otherwise resolve `/assets/%2e%2e/json/list` to its debugger.
 */
export function isLiveDevAssetPath(rawPath: string): boolean {
  if (/[%\\]/.test(rawPath) || rawPath.includes("//")) return false;
  if (rawPath.split("/").some((segment) => segment === "." || segment === "..")) return false;
  if (rawPath.endsWith(".bundle") || rawPath.endsWith(".map")) return true;
  return rawPath.startsWith("/assets/");
}

function requestPath(req: Request): string {
  return req.originalUrl.split("?")[0] ?? "/";
}

/** The only WebSocket the browser needs for Fast Refresh. */
export function isLiveDevSocketPath(pathname: string): boolean {
  return pathname === "/hot";
}

function wantsPage(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (req.path.startsWith("/api/") || req.path === "/api") return false;
  // Navigations to app routes; files such as icons still come from the static interface.
  if (/\.[a-z0-9]+$/i.test(req.path)) return false;
  return (req.headers.accept ?? "").includes("text/html");
}

function interfaceCookie(req: Request): string | null {
  for (const part of req.headers.cookie?.split(";") ?? []) {
    const value = part.trim();
    if (value.startsWith(`${INTERFACE_COOKIE}=`)) return value.slice(INTERFACE_COOKIE.length + 1);
  }
  return null;
}

function choseSafeInterface(req: Request): boolean {
  const cookie = interfaceCookie(req);
  return cookie === "safe" || cookie === "fallback";
}

/** The live page carries the indicator in its live state. */
export function injectLiveDevMarker(html: string): string {
  return injectBeforeBodyEnd(html, liveDevIndicatorHtml("live"));
}

/** Which indicator a static page shows while the installation is in Live dev mode. */
function staticIndicatorState(
  req: Request,
  server: { state: string } | null,
  port: number | null,
): LiveDevIndicatorState {
  const cookie = interfaceCookie(req);
  if (cookie === "safe") return "safe";
  if (cookie === "fallback" || port !== null) return "slow";
  if (server?.state === "starting") return "starting";
  return "down";
}

export interface LiveDevProxyOptions {
  /** The ready dev server's loopback port, or null when live mode should not serve. */
  port: () => number | null;
  ownerSession: (req: Request) => boolean;
  label: string;
  installation: () => ExecutionInstallation;
  logger: Logger;
  /** Matches the owner cookie: Secure on the HTTPS public origin. */
  secureCookies: boolean;
  /** Whether the installation is in Live dev mode, so owner pages carry the indicator. */
  liveMode?: () => boolean;
  /** The dev server's state, for the indicator on static pages. */
  serverStatus?: () => { state: string; detail: string | null };
  /**
   * The Host header the dev server sees. The Expo patch admits only the canonical origin and
   * loopback, so a second origin the coordinator already authorized, the custom domain,
   * presents itself as the canonical one on this loopback hop. Absent forwards the request's own.
   */
  upstreamHost?: string;
}

function fetchPage(port: number, req: Request, upstreamHost?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        // The app is a single page; asking for "/" keeps client paths away from Metro routes.
        path: "/",
        timeout: PAGE_TIMEOUT_MS,
        headers: {
          host: upstreamHost ?? req.headers.host,
          accept: "text/html",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        if (res.statusCode !== 200 || !(res.headers["content-type"] ?? "").includes("text/html")) {
          res.resume();
          resolve(null);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve(body));
        res.on("error", () => resolve(null));
      },
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => resolve(null));
    upstream.end();
  });
}

function pipeAsset(
  port: number,
  req: Request,
  res: Response,
  next: () => void,
  upstreamHost?: string,
): void {
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.originalUrl,
      headers: {
        host: upstreamHost ?? req.headers.host,
        accept: req.headers.accept ?? "*/*",
        "accept-encoding": req.headers["accept-encoding"] ?? "identity",
      },
    },
    (upstreamRes: IncomingMessage) => {
      res.status(upstreamRes.statusCode ?? 502);
      for (const header of ["content-type", "content-encoding", "content-length", "etag"]) {
        const value = upstreamRes.headers[header];
        if (value !== undefined) res.setHeader(header, value);
      }
      res.setHeader("Cache-Control", "no-store");
      // Sibling *.ts.net hosts count as same-site; they must not embed live bundles.
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      upstreamRes.pipe(res);
    },
  );
  upstream.setTimeout(ASSET_TIMEOUT_MS, () => upstream.destroy());
  res.on("close", () => upstream.destroy());
  upstream.on("error", () => {
    if (!res.headersSent) next();
    else res.end();
  });
  upstream.end();
}

/**
 * Handles `?interface=safe|live`, then serves live pages and assets to the owner. Mount it
 * immediately before the static web UI middleware.
 */
export function createLiveDevMiddleware(options: LiveDevProxyOptions): RequestHandler {
  const lastPage: LastPage = { port: null, html: null };
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    const choice = req.query.interface;
    if (choice === "safe" || choice === "live") {
      // A session cookie: the choice lasts until this browser closes or picks live again.
      if (choice === "safe")
        res.cookie(INTERFACE_COOKIE, "safe", {
          httpOnly: true,
          sameSite: "strict",
          secure: options.secureCookies,
          path: "/",
        });
      else res.clearCookie(INTERFACE_COOKIE, { path: "/" });
      // Never echo the request path: `//evil.example?interface=safe` would be an open redirect.
      res.redirect(302, "/");
      return;
    }
    const port = options.port();
    const owner = options.ownerSession(req);
    // Every owner page in Live dev mode shows the indicator. The static page server injects this
    // one; a page served live replaces it with the live state.
    if (owner && wantsPage(req) && options.liveMode?.()) {
      const server = options.serverStatus?.() ?? null;
      res.locals[INJECTED_BODY_HTML] = liveDevIndicatorHtml(
        staticIndicatorState(req, server, port),
        server?.state === "ready" ? null : server?.detail,
      );
    }
    if (port === null || choseSafeInterface(req) || !owner) {
      next();
      return;
    }
    if (isLiveDevAssetPath(requestPath(req))) {
      pipeAsset(port, req, res, next, options.upstreamHost);
      return;
    }
    if (!wantsPage(req)) {
      next();
      return;
    }
    void servePage(port, req, res, next, options, lastPage);
  };
}

/**
 * The last page this dev server returned. Metro's page barely changes between edits, which
 * arrive through the bundle and Fast Refresh, so a slow answer under load reuses it instead of
 * falling back to the static interface. A restarted server has a new port and starts empty.
 */
interface LastPage {
  port: number | null;
  html: string | null;
}

async function servePage(
  port: number,
  req: Request,
  res: Response,
  next: () => void,
  options: LiveDevProxyOptions,
  lastPage: LastPage,
): Promise<void> {
  try {
    const fetched = await fetchPage(port, req, options.upstreamHost);
    if (fetched !== null) {
      lastPage.port = port;
      lastPage.html = fetched;
    }
    const html = fetched ?? (lastPage.port === port ? lastPage.html : null);
    if (fetched === null && html !== null)
      options.logger.info("Live dev page slow; serving the last page from this dev server");
    if (html === null) {
      options.logger.warn("Live dev page unavailable; serving the static interface");
      if (options.liveMode?.()) res.locals[INJECTED_BODY_HTML] = liveDevIndicatorHtml("slow");
      // The static page's own assets must come from the static interface too.
      res.cookie(INTERFACE_COOKIE, "fallback", {
        httpOnly: true,
        sameSite: "strict",
        secure: options.secureCookies,
        path: "/",
        maxAge: FALLBACK_SECONDS * 1000,
      });
      next();
      return;
    }
    delete res.locals[INJECTED_BODY_HTML];
    const result = await prepareWebUiHtml({
      html: injectLiveDevMarker(html),
      req,
      label: options.label,
      installation: options.installation(),
    });
    if (res.destroyed) return;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.vary("Accept-Encoding");
    if (result.contentEncoding) res.setHeader("Content-Encoding", result.contentEncoding);
    res.setHeader("Content-Length", result.body.length);
    if (req.method === "HEAD") res.status(result.status).end();
    else res.status(result.status).send(result.body);
  } catch {
    if (!res.headersSent) next();
  }
}

/**
 * Forwards the Fast Refresh socket. Upgrades bypass Express, so the caller passes the same
 * host and owner checks its HTTP middleware applies.
 */
export function forwardLiveDevUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  port: number,
  /** Presents an authorized second origin as the canonical one; see `upstreamHost`. */
  presentAs?: { host: string; origin: string },
): void {
  const upstream = connect(port, "127.0.0.1", () => {
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`];
    // Metro runs live checkout code, so it never sees the owner's session or forwarding headers.
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index] ?? "";
      const lower = name.toLowerCase();
      if (CREDENTIAL_HEADERS.has(lower) || lower.startsWith("x-forwarded-")) continue;
      let value = req.rawHeaders[index + 1];
      if (presentAs && lower === "host") value = presentAs.host;
      if (presentAs && lower === "origin") value = presentAs.origin;
      lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
}
