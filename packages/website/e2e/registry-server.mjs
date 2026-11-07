import { createServer } from "node:http";
import registry from "./registry.fixture.json" with { type: "json" };

import securityPlugin from "./overview.fixture.json" with { type: "json" };

import overviewCorpus from "../../protocol/tests/fixtures/plugin-overview.json" with { type: "json" };
securityPlugin.readme +=
  "\n\n" +
  overviewCorpus
    .map(({ markdown }) => markdown + "\n\n```html\n" + markdown + "\n```")
    .join("\n\n");

// One ready release in GitHub's REST shape. Every page's root loader reads releases and stars,
// and the preview server has no KV cache, so live GitHub calls would hit CI's shared rate limit.
const VERSION = "1.2.3";
const releases = [
  {
    tag_name: `v${VERSION}`,
    prerelease: false,
    draft: false,
    assets: [
      `Paseo-${VERSION}-arm64.dmg`,
      "Paseo-x86_64.AppImage",
      `Paseo-Setup-${VERSION}-x64.exe`,
      `Paseo-Setup-${VERSION}-arm64.exe`,
      `paseo-v${VERSION}-android.apk`,
    ].map((name) => ({ name })),
  },
];

// Serve the published registry contract so SSR and browser navigation use the same data,
// and stand in for the GitHub REST API (GITHUB_API_URL in playwright.config.ts).
createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  const githubPath = request.url?.split("?")[0];
  if (githubPath === "/repos/getpaseo/paseo/releases") {
    response.end(JSON.stringify(releases));
    return;
  }
  if (githubPath === "/repos/getpaseo/paseo") {
    response.end(JSON.stringify({ stargazers_count: 1234 }));
    return;
  }
  if (request.url === "/index.json") {
    response.end(JSON.stringify(registry));
    return;
  }
  const plugin = [securityPlugin, ...registry.plugins].find(
    (entry) => request.url === `/plugins/${entry.id}.json`,
  );
  response.statusCode = plugin ? 200 : 404;
  response.end(JSON.stringify(plugin ?? { error: "Plugin not found" }));
}).listen(8188, "127.0.0.1");
