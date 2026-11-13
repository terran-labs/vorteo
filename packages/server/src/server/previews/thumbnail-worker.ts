/**
 * Renders one page to a PNG and exits. It runs as its own short-lived process so the
 * optional browser dependency stays out of the daemon's module graph, and a renderer
 * crash or hang cannot affect the daemon.
 *
 * Usage: node thumbnail-worker.js <url> <output.png>
 */
import { promises as fs } from "node:fs";
import path from "node:path";

interface PageLike {
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: { path: string; type: "png" }): Promise<unknown>;
}
interface BrowserLike {
  newContext(options: Record<string, unknown>): Promise<{ newPage(): Promise<PageLike> }>;
  close(): Promise<void>;
}

async function render(url: string, outputPath: string): Promise<void> {
  // A variable specifier keeps bundlers and module tracers from following the optional package.
  const specifier = "playwright-core";
  const playwright = (await import(specifier)) as {
    chromium: { launch(options: { headless: boolean }): Promise<BrowserLike> };
  };
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    // A fresh browser with an in-memory profile per render: previews share no state.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 0.5,
      acceptDownloads: false,
      serviceWorkers: "block",
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

const [url, outputPath] = process.argv.slice(2);
if (!url || !outputPath || !/^https?:\/\//.test(url)) {
  process.stderr.write("Usage: thumbnail-worker <http(s) url> <output.png>\n");
  process.exit(2);
}
try {
  await render(url, outputPath);
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
