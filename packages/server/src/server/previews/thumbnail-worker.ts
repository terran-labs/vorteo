/**
 * Renders one page to a PNG and exits. It runs as its own short-lived process so the
 * optional browser dependency stays out of the daemon's module graph, and a renderer
 * crash or hang cannot affect the daemon.
 *
 * The renderer may load only the daemon's own loopback snapshot route for one version.
 * Every other request the page starts, including subresources and subframes, is aborted
 * and every WebSocket is closed, so a snapshot cannot make the browser read an internal
 * service into an image that is then served without daemon auth. A server redirect is
 * followed by the browser without a second check; that is safe only because the one
 * server inside the allowlist is the daemon's snapshot route, which never redirects
 * outside it. Keep it that way. Chromium runs with its sandbox on, and a launch that
 * cannot sandbox fails, which leaves the version without a thumbnail.
 *
 * Usage: node thumbnail-worker.js <url> <output.png> <allowed-prefix>
 */
import { promises as fs } from "node:fs";
import path from "node:path";

interface RouteLike {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}
interface PageLike {
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: { path: string; type: "png" }): Promise<unknown>;
}
interface BrowserLike {
  newContext(options: Record<string, unknown>): Promise<{
    newPage(): Promise<PageLike>;
    route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
    routeWebSocket(
      pattern: string,
      handler: (socket: { close(): Promise<void> }) => void,
    ): Promise<void>;
  }>;
  close(): Promise<void>;
}

/** True only for the one snapshot's own files, or inline data the document carries itself. */
export function isAllowedThumbnailRequest(requestUrl: string, allowedPrefix: string): boolean {
  if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) return true;
  let parsed: URL;
  let allowed: URL;
  try {
    parsed = new URL(requestUrl);
    allowed = new URL(allowedPrefix);
  } catch {
    return false;
  }
  // Compare parsed parts, not strings, so userinfo, dot segments and encodings cannot slip by.
  return (
    parsed.origin === allowed.origin &&
    parsed.username === "" &&
    parsed.password === "" &&
    allowed.pathname.endsWith("/") &&
    parsed.pathname.startsWith(allowed.pathname)
  );
}

async function render(url: string, outputPath: string, allowedPrefix: string): Promise<void> {
  // A variable specifier keeps bundlers and module tracers from following the optional package.
  const specifier = "playwright-core";
  const playwright = (await import(specifier)) as {
    chromium: {
      launch(options: { headless: boolean; chromiumSandbox: boolean }): Promise<BrowserLike>;
    };
  };
  const browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    // A fresh browser with an in-memory profile per render: previews share no state.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 0.5,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      if (isAllowedThumbnailRequest(route.request().url(), allowedPrefix)) await route.continue();
      else await route.abort();
    });
    await context.routeWebSocket("**/*", (socket) => {
      void socket.close();
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 20_000 });
    // Let web fonts and entry animations settle.
    await page.waitForTimeout(600);
    await page.evaluate(
      "document.querySelectorAll('[data-vorteo-review-ui]').forEach((node) => node.remove())",
    );
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await page.screenshot({ path: outputPath, type: "png" });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

const [url, outputPath, allowedPrefix] = process.argv.slice(2);
// Only run when started as the worker; importing the module for its helper does nothing.
if (process.argv[1] && /thumbnail-worker\.[cm]?[jt]s$/.test(process.argv[1])) {
  if (!url || !outputPath || !allowedPrefix || !isAllowedThumbnailRequest(url, allowedPrefix)) {
    process.stderr.write("Usage: thumbnail-worker <snapshot url> <output.png> <allowed-prefix>\n");
    process.exit(2);
  }
  try {
    await render(url, outputPath, allowedPrefix);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
