import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";

/**
 * The installation descriptor a page receives, plus the private recovery origin its boot page
 * links to. The recovery origin is written as its own global: interfaces validate the descriptor
 * strictly, so an extra descriptor field would fail older interfaces at startup.
 */
export type ServedInstallation = ExecutionInstallation & { recoveryOrigin?: string };
import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import type { Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";

const EXCLUDED_PATH_PREFIXES = ["/api/", "/mcp/", "/public/"];
const EXCLUDED_PATHS = new Set(["/api", "/mcp", "/public"]);

function isExcludedPath(requestPath: string): boolean {
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (requestPath.startsWith(prefix)) {
      return true;
    }
  }
  return EXCLUDED_PATHS.has(requestPath);
}

// RFC 8615 well-known URIs are machine-read metadata. Clients such as MCP OAuth
// discovery (RFC 9728, RFC 8414) need a 404 for documents the daemon does not
// serve; the SPA's index.html with a 200 reads as malformed metadata.
function isWellKnownPath(requestPath: string): boolean {
  return requestPath === "/.well-known" || requestPath.startsWith("/.well-known/");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
};

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

type WebEncoding = "br" | "gzip" | "identity";
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

function acceptedEncodings(header: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const item of header.toLowerCase().split(",")) {
    const [name, ...parameters] = item.trim().split(";");
    const quality = parameters
      .map((value) => value.trim())
      .filter((value) => value.startsWith("q="));
    let weight = 1;
    if (quality.length > 1) weight = 0;
    if (quality.length === 1) {
      const value = quality[0].slice(2);
      weight = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
    }
    weights.set(name.trim(), Math.min(weights.get(name.trim()) ?? 1, weight));
  }
  return weights;
}

function selectEncoding(
  acceptEncoding: string | undefined,
  available: readonly WebEncoding[],
): WebEncoding | null {
  if (!acceptEncoding) return "identity";
  const weights = acceptedEncodings(acceptEncoding);
  let selected: WebEncoding | null = null;
  let bestWeight = 0;
  for (const encoding of available) {
    const identityDefault = weights.get("*") === 0 ? 0 : 1;
    const fallback = encoding === "identity" ? identityDefault : (weights.get("*") ?? 0);
    const weight = weights.get(encoding) ?? fallback;
    if (weight > bestWeight) {
      selected = encoding;
      bestWeight = weight;
    }
  }
  return selected;
}

function isHashedAsset(filePath: string): boolean {
  const base = path.basename(filePath);
  // Match content hashes like index-abc123def456.js or main.abc123def456.css.
  return /[-.][0-9a-f]{16,}[-.]/i.test(base);
}

function isInsideDir(targetPath: string, dirPath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedDir || resolvedTarget.startsWith(resolvedDir + path.sep);
}

interface ResolvedTarget {
  resolvedFile: string;
  isIndexHtml: boolean;
}

interface ResolveTargetFileOptions {
  distDir: string;
  requestPath: string;
  spaFallback: boolean;
}

function resolveTargetFile(options: ResolveTargetFileOptions): ResolvedTarget | null {
  const { distDir, requestPath, spaFallback } = options;
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, safePath);

  const stat = safeStat(filePath);
  if (stat?.isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  const finalStat = safeStat(filePath);
  if (!finalStat?.isFile()) {
    if (!spaFallback) {
      return null;
    }
    filePath = path.join(distDir, "index.html");
    const fallbackStat = safeStat(filePath);
    if (!fallbackStat?.isFile()) {
      return null;
    }
  }

  if (!isInsideDir(filePath, distDir)) {
    return null;
  }

  const resolvedFile = path.resolve(filePath);
  const isIndexHtml = path.basename(resolvedFile).toLowerCase() === "index.html";
  return { resolvedFile, isIndexHtml };
}

function safeStat(filePath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

interface ContentEncodingResult {
  finalFile: string;
  contentEncoding: string | null;
  acceptable: boolean;
}

function resolveContentEncoding(
  resolvedFile: string,
  acceptEncoding: string | undefined,
): ContentEncodingResult {
  const available: WebEncoding[] = [];
  if (safeStat(`${resolvedFile}.br`)?.isFile()) available.push("br");
  if (safeStat(`${resolvedFile}.gz`)?.isFile()) available.push("gzip");
  available.push("identity");
  const encoding = selectEncoding(acceptEncoding, available);
  if (encoding === "br")
    return { finalFile: `${resolvedFile}.br`, contentEncoding: "br", acceptable: true };
  if (encoding === "gzip")
    return { finalFile: `${resolvedFile}.gz`, contentEncoding: "gzip", acceptable: true };
  return { finalFile: resolvedFile, contentEncoding: null, acceptable: encoding === "identity" };
}

function setResponseCacheHeaders(res: Response, isIndexHtml: boolean, resolvedFile: string): void {
  if (isIndexHtml) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  } else if (isHashedAsset(resolvedFile)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
}

export interface WebUiMiddlewareOptions {
  enabled: boolean;
  distDir: string | null;
  label: string;
  logger: Logger;
  /** Read per page load, so owner changes such as the installation name apply on reload. */
  installation?: ServedInstallation | (() => ServedInstallation);
}

export function createWebUiMiddleware(options: WebUiMiddlewareOptions): RequestHandler {
  const { enabled, distDir, label, logger } = options;
  const childLogger = logger.child({ module: "web-ui" });

  if (!enabled || !distDir) {
    childLogger.info(
      { enabled, hasDistDir: !!distDir },
      "Daemon web UI disabled or missing dist directory",
    );
  } else {
    childLogger.info({ distDir }, "Daemon web UI mounted");
  }

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    if (isExcludedPath(req.path)) {
      next();
      return;
    }

    if (!enabled || !distDir) {
      res.status(404).end();
      return;
    }

    serveWebUiFile({
      distDir,
      requestPath: req.path,
      label,
      req,
      res,
      installation:
        typeof options.installation === "function" ? options.installation() : options.installation,
    });
  };
}

interface ServeWebUiFileOptions {
  installation?: ServedInstallation;
  distDir: string;
  requestPath: string;
  label: string;
  req: Parameters<RequestHandler>[0];
  res: Parameters<RequestHandler>[1];
}

function serveWebUiFile(options: ServeWebUiFileOptions): void {
  const { distDir, requestPath, label, req, res } = options;

  const wellKnown = isWellKnownPath(requestPath);
  const target = resolveTargetFile({ distDir, requestPath, spaFallback: !wellKnown });
  if (!target) {
    if (wellKnown) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(404).end();
    return;
  }

  const { resolvedFile, isIndexHtml } = target;
  res.setHeader("Content-Type", getContentType(resolvedFile));
  res.vary("Accept-Encoding");
  setResponseCacheHeaders(res, isIndexHtml, resolvedFile);
  if (isIndexHtml) {
    void sendIndexHtml(res, resolvedFile, req, label, options.installation);
    return;
  }
  const { finalFile, contentEncoding, acceptable } = resolveContentEncoding(
    resolvedFile,
    req.headers["accept-encoding"],
  );
  if (!acceptable) {
    res.status(406).end();
    return;
  }
  if (contentEncoding) {
    res.setHeader("Content-Encoding", contentEncoding);
  }

  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  const stream = createReadStream(finalFile);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

/**
 * `res.locals` key for HTML that an earlier middleware asks to place before `</body>` of a served
 * index page, such as the Live dev indicator on the static fallback.
 */
export const INJECTED_BODY_HTML = "vorteoInjectedBodyHtml";

export interface WebUiHtmlResponse {
  status: 200 | 406;
  body: Buffer;
  contentEncoding: "br" | "gzip" | null;
}

interface WebUiHtmlOptions {
  html: string;
  req: Pick<Request, "headers" | "protocol">;
  label: string;
  installation?: ServedInstallation;
}

/** Compress after injecting the public hint; sealed HTML encodings lack that hint. */
export async function prepareWebUiHtml(options: WebUiHtmlOptions): Promise<WebUiHtmlResponse> {
  const encoding = selectEncoding(options.req.headers["accept-encoding"], [
    "br",
    "gzip",
    "identity",
  ]);
  if (encoding === null) return { status: 406, body: Buffer.alloc(0), contentEncoding: null };
  const injected = injectConnectionHint(
    options.html,
    options.req,
    options.label,
    options.installation,
  );
  const bytes = Buffer.from(injected, "utf8");
  if (encoding === "br") {
    const body = await compressBrotli(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
    });
    return { status: 200, body, contentEncoding: "br" };
  }
  if (encoding === "gzip")
    return { status: 200, body: await compressGzip(bytes), contentEncoding: "gzip" };
  return { status: 200, body: bytes, contentEncoding: null };
}

function beforeBodyEnd(html: string, fragment: string): string {
  const end = html.lastIndexOf("</body>");
  return end === -1 ? `${html}${fragment}` : `${html.slice(0, end)}${fragment}${html.slice(end)}`;
}

async function sendIndexHtml(
  res: Response,
  filePath: string,
  req: Parameters<RequestHandler>[0],
  label: string,
  installation?: ServedInstallation,
): Promise<void> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const extra: unknown = res.locals[INJECTED_BODY_HTML];
    const html = typeof extra === "string" ? beforeBodyEnd(raw, extra) : raw;
    const result = await prepareWebUiHtml({ html, req, label, installation });
    if (res.destroyed) return;
    if (result.contentEncoding) res.setHeader("Content-Encoding", result.contentEncoding);
    res.setHeader("Content-Length", result.body.length);
    if (req.method === "HEAD") {
      res.status(result.status).end();
      return;
    }
    res.status(result.status).send(result.body);
  } catch {
    if (!res.destroyed) res.status(500).end();
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serializeInlineScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026");
}

/**
 * A Host header carries no port when the client used the scheme's default one,
 * which is what every browser sends to a proxy terminating TLS on 443. The app
 * parses `listen` with parseHostPort, which requires an explicit port and
 * rejects the value outright, so the hint has to spell the port out.
 */
function hasExplicitPort(host: string): boolean {
  if (host.startsWith("[")) {
    // IPv6 literals are bracketed: [::1] has no port, [::1]:443 does.
    const end = host.indexOf("]");
    return end !== -1 && /^:\d{1,5}$/.test(host.slice(end + 1));
  }
  const colon = host.indexOf(":");
  return colon !== -1 && colon === host.lastIndexOf(":") && /^\d{1,5}$/.test(host.slice(colon + 1));
}

function injectConnectionHint(
  html: string,
  req: Pick<Request, "headers" | "protocol">,
  label: string,
  installation?: ServedInstallation,
): string {
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const useTls = req.protocol === "https";
  let listen = host;
  if (host && !hasExplicitPort(host)) {
    let defaultPort = 80;
    if (useTls) {
      defaultPort = 443;
    }
    listen = `${host}:${defaultPort}`;
  }
  const hint = {
    listen,
    useTls,
    label,
  };
  let assignment = `window.__PASEO_INITIAL_DAEMON_CONNECTION__=${serializeInlineScriptJson(hint)}`;
  if (installation) {
    // COMPAT(recoveryOriginGlobal): added after 26.11.902; move into the descriptor once the
    // interface floor validates an optional descriptor recoveryOrigin.
    const { recoveryOrigin, ...descriptor } = installation;
    assignment = `window.__VORTEO_EXECUTION_INSTALLATION__=${serializeInlineScriptJson(descriptor)}`;
    if (recoveryOrigin)
      assignment += `;window.__VORTEO_RECOVERY_ORIGIN__=${serializeInlineScriptJson(recoveryOrigin)}`;
  }
  const script = `<script>${assignment}</script>`;
  // The tab names the installation, so two open side by side are never confused.
  // Function replacers keep `$'`, `$&` and similar in an owner-chosen name literal.
  const name = installation?.name;
  const titled = name
    ? html.replace(/<title>[^<]*<\/title>/i, () => `<title>${escapeHtml(name)}</title>`)
    : html;
  const headClose = /<\/head>/i;
  if (headClose.test(titled)) {
    return titled.replace(headClose, () => `${script}</head>`);
  }
  return script + titled;
}
