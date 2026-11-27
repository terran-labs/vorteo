import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FactoryGitHub, GitHubResponse } from "../project/claims.js";

const exec = promisify(execFile);

function githubUrl(route: string): URL {
  const url = new URL(route.replace(/^\//u, ""), "https://api.github.com/");
  if (url.origin !== "https://api.github.com" || url.username || url.password)
    throw new Error("Invalid GitHub API destination.");
  return url;
}

function readsOnly(method: string, url: URL, body: unknown): boolean {
  if (method === "GET") return true;
  if (
    url.pathname !== "/graphql" ||
    method !== "POST" ||
    !body ||
    typeof body !== "object" ||
    !("query" in body)
  )
    return false;
  return (
    typeof body.query === "string" &&
    /^\s*query\b/u.test(body.query) &&
    !/\bmutation\b/u.test(body.query)
  );
}

/** Share this instance across the daemon's projects that use the same authenticated account. */
export function createLeanGitHubClient(): FactoryGitHub {
  const cache = new Map<string, { etag: string; response: GitHubResponse }>();
  const writes: number[] = [];
  let cooldown = 0;
  let credential: Promise<string> | undefined;
  let expiresAt = 0;
  function reserveWrite(now: number) {
    while (writes.length && writes[0] <= now - 3_600_000) writes.shift();
    if (writes.length >= 500 || writes.filter((at) => at > now - 60_000).length >= 80)
      throw new Error("Factory reached its GitHub write budget.");
    writes.push(now);
    cache.clear();
  }
  async function token(now: number) {
    if (!credential || now >= expiresAt) {
      credential = exec("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 10_000 })
        .then(({ stdout }) => stdout.trim())
        .catch(() => {
          credential = undefined;
          throw new Error("GitHub authentication is unavailable.");
        });
      expiresAt = now + 300_000;
    }
    return credential;
  }
  return {
    async rest(method, route, body) {
      const url = githubUrl(route);
      const auth = await token(Date.now());
      const now = Date.now();
      if (now < cooldown)
        throw new Error("GitHub requested a cooldown until " + new Date(cooldown).toISOString());
      if (!readsOnly(method, url, body)) {
        reserveWrite(now);
      }
      const saved = method === "GET" ? cache.get(url.href) : undefined;
      const headers: Record<string, string> = {
        Authorization: "Bearer " + auth,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      };
      if (saved) headers["If-None-Match"] = saved.etag;
      const response = await fetch(url, {
        method,
        headers,
        redirect: "error",
        ...(method !== "GET" && body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 304 && saved) return saved.response;
      if (response.status === 401) credential = undefined;
      const retry = response.headers.get("retry-after");
      if (response.status === 429 || retry)
        cooldown = now + Math.max(60, Number(retry) || 60) * 1_000;
      const raw = await response.text();
      const result = { status: response.status, body: raw ? JSON.parse(raw) : null };
      const etag = response.headers.get("etag");
      if (method === "GET" && response.ok && etag) {
        if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
        cache.set(url.href, { etag, response: result });
      }
      return result;
    },
  };
}
