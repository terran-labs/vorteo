// Vorteo snapshot viewer. TRUSTED: top-level document on the daemon origin.
//
// It shows a frozen snapshot in a sandboxed iframe (opaque origin, untrusted)
// next to the same-origin comment frame, and relays a small allowlist of
// messages between them. The viewer never reads the review key.
"use strict";

var VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
var SNAPSHOT_TO_COMMENT = { hello: true, selection: true, "pick-cancelled": true };
var COMMENT_TO_SNAPSHOT = { mode: true, highlight: true };
var COMMENT_TO_VIEWER = { context: true, layout: true };

// ---------- pure helpers (exported for tests) ----------

function isValidVersionId(value) {
  return typeof value === "string" && VERSION_ID_PATTERN.test(value);
}

function versionIdFromPath(pathname) {
  var parts = String(pathname || "").split("/");
  var last = parts[parts.length - 1] || parts[parts.length - 2] || "";
  return isValidVersionId(last) ? last : null;
}

function copyFields(data, fields) {
  var out = { vorteoReview: 1, type: data.type };
  fields.forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(data, f)) out[f] = data[f];
  });
  return out;
}

// Rebuild a relayed message with only the fields its type uses. The comment
// frame sanitizes values again; this keeps unknown fields from crossing.
function rebuild(data) {
  switch (data.type) {
    case "hello":
      return copyFields(data, ["url", "title", "viewport", "mode"]);
    case "selection":
      return copyFields(data, ["selection"]);
    case "pick-cancelled":
      return copyFields(data, []);
    case "mode":
      return copyFields(data, ["mode"]);
    case "highlight":
      return copyFields(data, ["selector", "rect", "scroll"]);
    case "context":
      return copyFields(data, ["artifact"]);
    case "layout":
      return copyFields(data, ["state"]);
    default:
      return null;
  }
}

// Decide where a message goes. ctx = { snapshotWindow, commentWindow, ownOrigin }.
// Returns { to: "comment" | "snapshot" | "viewer", message } or null to drop.
function relayDecision(event, ctx) {
  if (!event || !ctx) return null;
  var data = event.data;
  if (!data || typeof data !== "object" || data.vorteoReview !== 1) return null;
  if (typeof data.type !== "string") return null;
  if (ctx.snapshotWindow && event.source === ctx.snapshotWindow) {
    // The sandbox has no allow-same-origin, so its origin is always opaque.
    if (event.origin !== "null") return null;
    if (!SNAPSHOT_TO_COMMENT.hasOwnProperty(data.type)) return null;
    return { to: "comment", message: rebuild(data) };
  }
  if (ctx.commentWindow && event.source === ctx.commentWindow) {
    if (event.origin !== ctx.ownOrigin) return null;
    if (COMMENT_TO_SNAPSHOT.hasOwnProperty(data.type)) {
      return { to: "snapshot", message: rebuild(data) };
    }
    if (COMMENT_TO_VIEWER.hasOwnProperty(data.type)) {
      return { to: "viewer", message: rebuild(data) };
    }
  }
  return null;
}

// The only postMessage calls in this file.
function deliver(decision, ctx) {
  if (!decision || !decision.message) return false;
  if (decision.to === "comment" && ctx.commentWindow) {
    ctx.commentWindow.postMessage(decision.message, ctx.ownOrigin);
    return true;
  }
  if (decision.to === "snapshot" && ctx.snapshotWindow) {
    // Opaque origin: "*" is the only possible target. Nothing secret is sent.
    ctx.snapshotWindow.postMessage(decision.message, "*");
    return true;
  }
  return false;
}

// ---------- browser wiring ----------

function startViewer() {
  var versionId = versionIdFromPath(location.pathname);
  var stage = document.getElementById("stage");
  var side = document.getElementById("side");
  var titleEl = document.getElementById("title");
  var versionEl = document.getElementById("version");
  var fullscreenBtn = document.getElementById("fullscreen");
  var commentsBtn = document.getElementById("comments");

  if (!versionId) {
    document.getElementById("invalid").hidden = false;
    commentsBtn.hidden = true;
    return;
  }

  var snapshot = document.createElement("iframe");
  // Browsers refuse to render a PDF in a sandboxed frame. The server marks PDF versions,
  // serves the file as application/pdf, and still sandboxes every HTML response by header.
  if (document.documentElement.getAttribute("data-preview-kind") !== "pdf") {
    snapshot.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
  }
  snapshot.setAttribute("referrerpolicy", "no-referrer");
  snapshot.title = "Preview";
  snapshot.src = "/api/previews/snap/" + encodeURIComponent(versionId) + "/";
  stage.appendChild(snapshot);

  var commentFrame = document.createElement("iframe");
  commentFrame.title = "Comments";
  commentFrame.src = "/api/previews/frame?versionId=" + encodeURIComponent(versionId);
  side.appendChild(commentFrame);

  var narrow = window.matchMedia("(max-width: 599px)");
  var panelOpen = !narrow.matches;
  var pickingHidPanel = false;

  function setPanel(open) {
    panelOpen = open;
    side.hidden = !open;
    commentsBtn.setAttribute("aria-pressed", open ? "true" : "false");
  }
  setPanel(panelOpen);
  commentsBtn.addEventListener("click", function () {
    setPanel(!panelOpen);
  });

  // Fullscreen API: hidden where unsupported, such as iPhone Safari.
  var canFullscreen = Boolean(
    (document.fullscreenEnabled && stage.requestFullscreen) ||
    (document.webkitFullscreenEnabled && stage.webkitRequestFullscreen),
  );
  fullscreenBtn.hidden = !canFullscreen;
  fullscreenBtn.addEventListener("click", function () {
    if (stage.requestFullscreen) stage.requestFullscreen().catch(function () {});
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
  });

  function ctx() {
    return {
      snapshotWindow: snapshot.contentWindow,
      commentWindow: commentFrame.contentWindow,
      ownOrigin: location.origin,
    };
  }

  function showContext(artifact) {
    var a = artifact && typeof artifact === "object" ? artifact : null;
    if (!a) return;
    var title = typeof a.title === "string" && a.title ? a.title.slice(0, 300) : "Preview";
    titleEl.textContent = title;
    document.title = title + " \u00b7 Vorteo";
    versionEl.textContent = typeof a.versionNumber === "number" ? "Version " + a.versionNumber : "";
  }

  function handleViewerMessage(msg) {
    if (msg.type === "context") showContext(msg.artifact);
    else if (msg.type === "layout" && msg.state === "collapsed") setPanel(false);
  }

  // On phones the comment sheet covers the snapshot; hide it while picking
  // and bring it back when the pick ends.
  function adjustPanelForPick(decision) {
    var msg = decision.message;
    var startsPick = decision.to === "snapshot" && msg.type === "mode" && msg.mode !== "idle";
    if (startsPick && narrow.matches && panelOpen) {
      pickingHidPanel = true;
      setPanel(false);
      return;
    }
    var endsPick =
      decision.to === "comment" && (msg.type === "selection" || msg.type === "pick-cancelled");
    if (endsPick && pickingHidPanel) {
      pickingHidPanel = false;
      setPanel(true);
    }
  }

  window.addEventListener("message", function (event) {
    var c = ctx();
    var decision = relayDecision(event, c);
    if (!decision) return;
    if (decision.to === "viewer") {
      handleViewerMessage(decision.message);
      return;
    }
    adjustPanelForPick(decision);
    deliver(decision, c);
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    deliver: deliver,
    isValidVersionId: isValidVersionId,
    relayDecision: relayDecision,
    versionIdFromPath: versionIdFromPath,
  };
} else if (typeof document !== "undefined") {
  startViewer();
}
