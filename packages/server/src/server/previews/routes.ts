import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type Router } from "express";
import {
  PreviewSelectionSchema,
  PreviewVersionIdSchema,
  type PreviewVersion,
} from "@getpaseo/protocol/previews";
import { z } from "zod";
import { listReservedPreviewOrigins } from "../workspace-preview-origin.js";
import type { PreviewsService } from "./service.js";
import { PreviewError, resolveSnapshotPath } from "./store.js";

/**
 * HTTP surface of the Previews gallery, mounted at /api/previews ahead of the daemon
 * password middleware. Every route authenticates itself:
 *
 * - Static review pages and the page script are public code with no data.
 * - Snapshots and thumbnails are addressed by an unguessable version id.
 * - Review routes need the review key a paired browser holds in this origin's storage.
 *   Storage is isolated per port, so a previewed page on another port cannot read it;
 *   a cookie would not be, because cookies ignore ports and would reach preview backends.
 */

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const REVIEW_KEY_HEADER = "x-vorteo-review-key";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Snapshots are agent-authored. This policy gives every snapshot document an opaque
 * origin, so its scripts cannot read this origin's storage, where the review key lives,
 * or call the daemon as the same origin.
 */
export const SNAPSHOT_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals";

const AnnotationBodySchema = z
  .object({
    target: z.union([
      z.object({ versionId: PreviewVersionIdSchema }).strict(),
      // Live previews: the version the owner was shown, and the origin it was shown on.
      z.object({ origin: z.string().max(300), versionId: PreviewVersionIdSchema }).strict(),
    ]),
    comment: z.string().max(4000).default(""),
    rating: z.number().int().min(1).max(5).optional(),
    selection: PreviewSelectionSchema.optional(),
  })
  .strict();

const PairBodySchema = z.object({ ticket: z.string().min(1).max(200) }).strict();

function pageScriptTag(mode: "relay"): string {
  // Relative to this origin; the snapshot document is served from it.
  return `<script src="/api/previews/page.js" data-vorteo-review data-vorteo-review-mode="${mode}" async></script>`;
}

/** Insert the review script into a snapshot document without touching anything else. */
export function injectPageScript(html: string, tag: string): string {
  if (html.includes("data-vorteo-review")) return html;
  for (const marker of ["</head>", "</body>"]) {
    const at = html.toLowerCase().indexOf(marker);
    if (at !== -1) return html.slice(0, at) + tag + html.slice(at);
  }
  return html + tag;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A request that changes state must come from a page on this origin. Browsers set Origin
 * on cross-origin POSTs and page scripts cannot override it, so a previewed page on
 * another port is refused here even before the review key is checked.
 */
export function isSameOriginRequest(req: Pick<Request, "headers">): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // The daemon sits behind a TLS-terminating proxy and cannot see its own scheme. The
  // owner's browser always reaches it over https; plain http is accepted for loopback only.
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return false;
  // URL.host carries the port unless it is the scheme default, exactly as a Host header does.
  return parsed.origin === origin && parsed.host === host;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof PreviewError) {
    res.status(error.code === "not_found" ? 404 : 400).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "The preview request failed." });
}

/** Express 4 does not await handlers; run an async one and turn a rejection into a 500. */
function route(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: "The preview request failed." });
      else res.destroy();
    });
  };
}

export interface PreviewsRouterOptions {
  /** Origins the preview broker has reserved. Previews may live on another hostname. */
  previewOrigins?: () => Promise<string[]>;
}

/**
 * An origin safe to place in a header or attribute: scheme, host and optional port only.
 * Plain http is accepted for loopback alone, which development and tests use.
 */
function isPlainOrigin(value: string): boolean {
  return (
    /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(value) ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(value)
  );
}

export function createPreviewsRouter(
  previews: PreviewsService,
  options: PreviewsRouterOptions = {},
): Router {
  const previewOrigins = async (): Promise<string[]> =>
    (await (options.previewOrigins ?? listReservedPreviewOrigins)()).filter(isPlainOrigin);
  const router = express.Router();
  const json = express.json({ limit: "64kb" });

  const sendWebFile = async (
    res: Response,
    name: string,
    headers: Record<string, string>,
    attributes: Record<string, string> = {},
  ): Promise<void> => {
    try {
      let body = await fs.readFile(path.join(WEB_ROOT, name), "utf8");
      for (const [attribute, value] of Object.entries(attributes))
        body = body.replace(/<html/i, `<html data-${attribute}="${value}"`);
      res.setHeader("Content-Type", MIME[path.extname(name)] ?? "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Referrer-Policy", "no-referrer");
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
      res.send(body);
    } catch {
      res.status(404).end();
    }
  };

  const trustedPagePolicy = (frameAncestors: string): Record<string, string> => ({
    "Content-Security-Policy": `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors ${frameAncestors}`,
  });

  // The page script runs inside untrusted pages on other origins.
  router.get("/page.js", (_req, res) => {
    void sendWebFile(res, "page.js", { "Cross-Origin-Resource-Policy": "cross-origin" });
  });
  for (const name of ["frame.js", "viewer.js", "pair.js", "confirm.js", "shared.css"])
    router.get(`/web/${name}`, (_req, res) => void sendWebFile(res, name, {}));

  // The comment frame is embedded by live previews. A page that embeds it can cover or
  // hide it, so the embedded frame never posts feedback; it hands a draft to the
  // unframeable /confirm page instead.
  router.get(
    "/frame",
    route(async (_req, res) => {
      // Only this origin and the exact origins the preview broker reserved may embed the
      // frame. There is no hostname-wide allowance: a port on this daemon's own hostname
      // that the broker did not reserve is not a preview.
      const ancestors = ["'self'", ...(await previewOrigins())].join(" ");
      await sendWebFile(res, "frame.html", trustedPagePolicy(ancestors));
    }),
  );
  // Top-level pages that hold the review key must never be framed.
  router.get(
    "/pair",
    route(async (_req, res) => {
      // The page may continue only to a reserved preview origin or this daemon's viewer.
      await sendWebFile(res, "pair.html", trustedPagePolicy("'none'"), {
        "preview-origins": (await previewOrigins()).join(" "),
      });
    }),
  );
  // Feedback written in an embedded frame is confirmed here, where no page can cover the
  // button. See web/confirm.js.
  router.get(
    "/confirm",
    (_req, res) => void sendWebFile(res, "confirm.html", trustedPagePolicy("'none'")),
  );
  router.get(
    "/view/:versionId",
    route(async (req, res) => {
      const version = await previews.store.getVersion(req.params.versionId);
      if (!version) {
        res.status(404).type("text/plain").send("This preview no longer exists.");
        return;
      }
      void sendWebFile(res, "viewer.html", trustedPagePolicy("'none'"), {
        "preview-kind": version.kind,
      });
    }),
  );

  router.post(
    "/pair",
    json,
    route(async (req, res) => {
      const body = PairBodySchema.safeParse(req.body);
      if (!isSameOriginRequest(req) || !body.success) {
        res.status(403).json({ error: "Pairing must start from the Previews gallery." });
        return;
      }
      // Same-origin was just checked, so Origin is this daemon as the owner's browser sees it.
      const reviewKey = await previews.store.redeemTicket(
        body.data.ticket,
        Date.now(),
        new URL(String(req.headers.origin)).origin,
      );
      if (!reviewKey) {
        res.status(403).json({ error: "This pairing link has expired." });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ reviewKey });
    }),
  );

  // The injecting proxy asks where to load the toolbar from. Not secret: every page the
  // proxy serves carries it in a script tag.
  router.get(
    "/review-origin",
    route(async (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ origin: await previews.store.reviewOrigin() });
    }),
  );

  const requireReviewKey = async (req: Request, res: Response): Promise<boolean> => {
    const key = req.headers[REVIEW_KEY_HEADER];
    if (await previews.store.isReviewKeyValid(typeof key === "string" ? key : undefined))
      return true;
    res.status(401).json({ error: "This browser is not paired with Vorteo." });
    return false;
  };

  router.get(
    "/review/context",
    route(async (req, res) => {
      if (!(await requireReviewKey(req, res))) return;
      const { versionId, origin } = req.query;
      let version: PreviewVersion | null = null;
      if (typeof versionId === "string" && PreviewVersionIdSchema.safeParse(versionId).success)
        version = await previews.store.getVersion(versionId);
      else if (typeof origin === "string")
        version = await previews.store.findLiveVersionByOrigin(origin);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        artifact: version
          ? {
              title: version.title,
              versionId: version.id,
              versionNumber: version.number,
              kind: version.kind,
              live: Boolean(version.liveUrl),
            }
          : null,
        rating: version?.rating ?? null,
        approved: version?.approved ?? false,
        annotations: (version?.annotations ?? []).map((annotation) => ({
          id: annotation.id,
          comment: annotation.comment,
          createdAt: annotation.createdAt,
          selection: annotation.selection ?? null,
        })),
      });
    }),
  );

  router.post(
    "/review/annotations",
    json,
    route(async (req, res) => {
      // Origin first: a forged cross-origin post is refused without consulting the key.
      if (!isSameOriginRequest(req)) {
        res.status(403).json({ error: "Feedback must be sent from the Vorteo review frame." });
        return;
      }
      if (!(await requireReviewKey(req, res))) return;
      const body = AnnotationBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "The feedback was not in the expected form." });
        return;
      }
      try {
        res.json(await previews.annotate(body.data));
      } catch (error) {
        sendError(res, error);
      }
    }),
  );

  router.get(
    "/thumb/:versionId",
    route(async (req, res) => {
      const version = await previews.store.getVersion(req.params.versionId);
      if (!version?.hasThumbnail) {
        res.status(404).end();
        return;
      }
      const file =
        version.kind === "image" && version.entry
          ? resolveSnapshotPath(previews.store.filesDir(version.id), version.entry)
          : previews.store.thumbnailPath(version.id);
      if (!file) {
        res.status(404).end();
        return;
      }
      await streamFile(res, file, {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Security-Policy": SNAPSHOT_CSP,
      });
    }),
  );

  router.get(
    "/snap/:versionId/*",
    route(async (req, res) => {
      const version = await previews.store.getVersion(req.params.versionId);
      if (!version?.entry) {
        res.status(404).type("text/plain").send("This preview no longer exists.");
        return;
      }
      const root = previews.store.filesDir(version.id);
      const requested = (req.params as Record<string, string>)["0"] ?? "";
      const bare = req.query.bare === "1";
      const headers = {
        "Content-Security-Policy": SNAPSHOT_CSP,
        "Cache-Control": "private, max-age=3600",
        "Referrer-Policy": "no-referrer",
      };
      // An image gets a small wrapper document so the same picker works on it.
      if (requested === "" && version.kind === "image") {
        res.set(headers).type("html");
        res.send(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(version.title)}</title>${bare ? "" : pageScriptTag("relay")}</head><body style="margin:0;background:#111"><img src="${escapeHtml(encodeURI(version.entry))}" alt="${escapeHtml(version.title)}" style="max-width:100%;height:auto;display:block;margin:0 auto"></body></html>`,
        );
        return;
      }
      const file = resolveSnapshotPath(root, requested === "" ? version.entry : requested);
      if (!file) {
        res.status(400).end();
        return;
      }
      const extension = path.extname(file).toLowerCase();
      if ((extension === ".html" || extension === ".htm") && !bare) {
        try {
          const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          const html = await handle.readFile("utf8").finally(() => handle.close());
          res
            .set(headers)
            .type("html")
            .send(injectPageScript(html, pageScriptTag("relay")));
        } catch {
          res.status(404).end();
        }
        return;
      }
      // Browsers refuse to show a PDF inside a sandboxed document, and their PDF viewers do
      // not give the file access to this origin, so PDFs are served without the sandbox.
      const { "Content-Security-Policy": _sandbox, ...unsandboxed } = headers;
      await streamFile(res, file, extension === ".pdf" ? unsandboxed : headers);
    }),
  );

  // The entry document, so relative links inside the snapshot resolve under the version.
  router.get("/snap/:versionId", (req, res) => {
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    res.redirect(302, `${req.baseUrl}/snap/${encodeURIComponent(req.params.versionId)}/${query}`);
  });

  return router;
}

async function streamFile(
  res: Response,
  file: string,
  headers: Record<string, string>,
): Promise<void> {
  try {
    // No symlinks are ever copied into a snapshot; refusing to follow one is a second guard.
    const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      res.status(404).end();
      return;
    }
    res.set(headers);
    res.setHeader(
      "Content-Type",
      MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Length", String(stat.size));
    // The stream owns the handle from here and closes it when it ends or is destroyed.
    const stream = handle.createReadStream();
    stream.once("error", () => res.destroy());
    res.once("close", () => stream.destroy());
    stream.pipe(res);
  } catch {
    res.status(404).end();
  }
}
