import { Agent } from "undici";

/** @param {number} port */
export async function warmMetro(port) {
  // Shared runners may need longer to compile; assertion deadlines stay unchanged.
  const timeoutMs = Number(process.env.E2E_METRO_WARMUP_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("E2E_METRO_WARMUP_TIMEOUT_MS must be between 1000 and 600000");
  }
  // Node fetch otherwise caps response headers at five minutes, below this configured deadline.
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const documentResponse = await fetch(origin, {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!documentResponse.ok) {
      throw new Error(`Metro document warmup failed with HTTP ${documentResponse.status}`);
    }
    const document = await documentResponse.text();
    const scriptSources = [...document.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    if (scriptSources.length === 0) {
      throw new Error("Metro document warmup found no scripts to compile");
    }
    const lazyChunks = new Set();
    for (const source of scriptSources) {
      const bundle = await fetchBundle(new URL(source, origin));
      for (const chunk of lazyChunkSources(bundle)) lazyChunks.add(chunk);
    }
    // Lazy `import()` chunks compile on first request. The icon catalog's lucide chunk alone
    // takes about 20 seconds on a cold runner, which otherwise lands inside whichever test
    // first renders plugin icons and starves its page loads and connection deadlines.
    for (const chunk of lazyChunks) await fetchBundle(new URL(chunk, origin));
  } finally {
    await dispatcher.close();
  }

  /** @param {URL} url */
  async function fetchBundle(url) {
    if (url.origin !== origin) return "";
    const response = await fetch(url, { dispatcher, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 4000);
      throw new Error(
        `Metro bundle warmup failed for ${url.pathname}: HTTP ${response.status}\n${details}`,
      );
    }
    return response.text();
  }
}

/**
 * Metro lists each lazy chunk in its dependency map as `"paths":{"<module id>":"/<path>.bundle?…"}`.
 * @param {string} bundle
 */
function lazyChunkSources(bundle) {
  const sources = [];
  for (const [, paths] of bundle.matchAll(/"paths":(\{[^}]*\})/g)) {
    try {
      sources.push(...Object.values(JSON.parse(paths)).filter((path) => typeof path === "string"));
    } catch {
      // A source string that merely contains the marker is not a dependency map.
    }
  }
  return sources;
}
