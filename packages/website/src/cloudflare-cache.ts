import { env, waitUntil } from "cloudflare:workers";
import type { WebsiteCacheContext } from "./github-cache";

export function getWebsiteCacheContext(): WebsiteCacheContext {
  const bindings = env as { WEBSITE_CACHE?: KVNamespace; GITHUB_API_URL?: string };
  return {
    cache: bindings.WEBSITE_CACHE ?? null,
    waitUntil,
    githubApiUrl: bindings.GITHUB_API_URL,
  };
}
