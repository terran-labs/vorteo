# Previews gallery and review toolbar

Agents publish what they build to a Previews gallery. You rate it, pick between options and comment on it, and the feedback goes back to the agent that made it. This guide covers how it works, what protects your feedback from forgery, and how to run it. For starting a private preview link, see [private workspace previews](../docker/tailscale/AGENT-INSTRUCTIONS.md).

## Publish from an agent

Every agent has two tools when the daemon advertises `features.previews`:

- `publish_preview` takes a `title`, a `kind` (`web`, `deck`, `image`, `pdf` or `url`), a `lineage` key and a `path` or `url`. Publishing again with the same lineage adds a version to the same gallery entry. `variantSet` groups several options so you can pick a winner with a reason.
- `get_preview_feedback` returns ratings, approvals, variant picks and comments, filtered by lineage or version.

Publish built output, not a project directory. A directory is copied without `node_modules`, `.git`, environment files or symlinks, up to 300 MB or 10,000 files.

## Versions are frozen

Each published version is copied into `$PASEO_HOME/previews/versions/<id>/` and never changes, so a rating always refers to what you saw. A `url` version is the exception: it points at a live page, such as a running preview, and is labeled live.

Retention keeps the newest version of every artifact and the eight most recent untouched versions. A version you rated, approved or commented on is never pruned, and neither is an option in a set you have not picked from, or the winner of a set.

## Review in the browser

The gallery card opens a version in your normal browser through a pairing link. The link carries a single-use ticket that expires after two minutes. The pairing page exchanges it for a review key and stores the key in that browser for the daemon's address.

- A frozen version opens in the viewer at `/api/previews/view/<id>` on the daemon. The snapshot runs in a sandboxed frame beside the comment panel.
- A live preview shows a floating comment frame when the preview service runs behind the injecting proxy described below.

In both, you pick an element, select a region or comment on the whole page. Each comment records the page address, the version, the element selector and text, the viewport size and the scroll position. It arrives in the authoring thread headed "Preview feedback from the owner" through the same durable queue as Open question answers: once, now or when the agent's turn ends.

## What stops a page from forging your feedback

Previewed pages are agent-authored and untrusted. These rules hold the boundary:

- **Comment entry lives on the daemon's origin.** The comment box, stars and Send button are in a document the daemon serves. The page only reports what was picked.
- **The review key is in origin-scoped storage, not a cookie.** Browser storage is isolated per port. Cookies ignore ports, so a cookie would be sent to every preview backend on the same hostname.
- **Snapshots get an opaque origin.** Snapshot responses carry `Content-Security-Policy: sandbox`, so their scripts cannot read the daemon origin's storage or call it as the same origin. PDFs are served without the sandbox because browsers refuse to render a sandboxed PDF.
- **Posts must come from the daemon's own origin.** The annotation and pairing routes check the `Origin` header before the key.
- **Location data is fenced.** The message to the agent marks the selector and element text as untrusted data reported by the page.

One limit remains: a page can cover or move the comment frame, so it could trick you into sending a comment you typed. It cannot type one for you.

## Run a live preview behind the injecting proxy

`docker/tailscale/preview-review-proxy.mjs` wraps a service command. It listens on `$PASEO_PORT`, starts your app on another loopback port and adds one script tag to HTML documents. WebSocket upgrades, including live reload, pass through byte for byte.

```json
{
  "scripts": {
    "preview": {
      "type": "service",
      "command": "node /path/to/vorteo/docker/tailscale/preview-review-proxy.mjs --review-origin https://HOST:DAEMON_PORT -- npm run dev -- --host 127.0.0.1 --port $PASEO_PORT --strictPort"
    }
  }
}
```

Without a review origin the proxy passes everything through unchanged. It rewrites `Content-Security-Policy` response headers to allow the review origin for scripts and frames; a policy set in a `<meta>` tag is not rewritten. The preview broker needs no change, because the proxy is the managed terminal's single loopback listener.

Publish the running preview with `kind: "url"` so comments on it route to your thread.

## Limits

- Thumbnails need the optional `playwright-core` package and a Chromium build (`npm run browser:setup`). Without them the gallery shows a placeholder.
- A PDF has no element or region picker; comment on the whole document.
- Each daemon keeps its own gallery. Host and Dev agents publish to their own daemon.
- A relay connection has no HTTP route to the daemon, so thumbnails, zoom and Open in browser need a direct connection.
- Guest access outside the tailnet is not supported.
