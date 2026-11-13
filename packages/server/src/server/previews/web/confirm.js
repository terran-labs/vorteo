// Vorteo feedback confirmation. TRUSTED: top-level document on the daemon origin, served
// with frame-ancestors 'none'.
//
// The comment frame embedded in a live preview can be covered or hidden by that page, so
// it never sends feedback itself. It stores a draft in this origin's storage and opens
// this page, which shows exactly what will be sent and posts only after the owner presses
// Send here, where no other page can draw over the button.
"use strict";

var REVIEW_KEY_STORAGE = "vorteo.previews.reviewKey";
var DRAFT_PREFIX = "vorteo.previews.draft.";
var SENT_KEY = "vorteo.previews.sent";
var DRAFT_MAX_AGE_MS = 10 * 60 * 1000;

// Pure: one plain-text line saying what the comment is about, or "" for none.
function describeLocation(selection) {
  if (!selection || typeof selection !== "object") return "";
  if (selection.kind === "element")
    return "About the element: " + String(selection.text || selection.selector || "").slice(0, 200);
  if (selection.kind === "region") return "About a region you selected on the page.";
  return "About the whole page.";
}

// Pure: the comment and rating a draft carries, or null when it carries neither.
function draftContent(payload) {
  var comment = typeof payload.comment === "string" ? payload.comment : "";
  var rated = typeof payload.rating === "number" && payload.rating >= 1 && payload.rating <= 5;
  var rating = rated ? Math.round(payload.rating) : null;
  if (!comment.trim() && rating === null) return null;
  return { comment: comment, rating: rating };
}

// Pure: parse a stored draft, or null when it is malformed or older than the limit.
function parseDraft(raw, now) {
  var draft;
  try {
    draft = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!draft || typeof draft !== "object" || !draft.payload || typeof draft.payload !== "object")
    return null;
  if (typeof draft.createdAt !== "number" || now - draft.createdAt > DRAFT_MAX_AGE_MS) return null;
  var target = draft.payload.target;
  if (!target || typeof target !== "object" || typeof target.origin !== "string") return null;
  // The draft must name the exact version the owner was shown.
  if (typeof target.versionId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(target.versionId))
    return null;
  return draft;
}

// Pure: turn a stored draft into the lines shown to the owner, or null when it is not a
// usable draft. Everything shown is plain text.
function describeDraft(raw, now) {
  var draft = parseDraft(raw, now);
  var content = draft ? draftContent(draft.payload) : null;
  if (!draft || !content) return null;
  var title =
    typeof draft.title === "string" && draft.title ? draft.title.slice(0, 200) + ", " : "";
  return {
    payload: draft.payload,
    artifact:
      title +
      (typeof draft.versionNumber === "number" ? "version " + draft.versionNumber + ", " : "") +
      "live preview at " +
      draft.payload.target.origin.slice(0, 200),
    comment: content.comment,
    rating: content.rating,
    location: describeLocation(draft.payload.selection),
  };
}

function startConfirm() {
  var message = document.getElementById("message");
  var show = function (text) {
    message.textContent = text;
  };
  // Belt and braces with the frame-ancestors header: never act inside a frame.
  if (window.top !== window.self) {
    show("Open this page in its own tab.");
    return;
  }
  var id = location.hash.replace(/^#/, "");
  var key = DRAFT_PREFIX + id;
  var raw = null;
  var reviewKey = null;
  try {
    raw = /^[0-9a-f]{24}$/.test(id) ? localStorage.getItem(key) : null;
    reviewKey = localStorage.getItem(REVIEW_KEY_STORAGE);
  } catch {
    /* handled below */
  }
  var draft = raw ? describeDraft(raw, Date.now()) : null;
  if (!draft || !reviewKey) {
    show("Nothing to send. Write the comment again in the preview.");
    return;
  }
  document.getElementById("artifact").textContent = draft.artifact;
  document.getElementById("comment").textContent = draft.comment || "(rating only)";
  if (draft.rating !== null) {
    var rating = document.getElementById("rating");
    rating.textContent = "Rating: " + draft.rating + " of 5";
    rating.hidden = false;
  }
  if (draft.location) {
    var where = document.getElementById("location");
    where.textContent = draft.location;
    where.hidden = false;
  }
  var panel = document.getElementById("confirm");
  panel.hidden = false;
  var send = document.getElementById("send");
  var discard = function () {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  };
  document.getElementById("cancel").addEventListener("click", function () {
    discard();
    panel.hidden = true;
    show("Not sent. You can close this tab.");
  });
  send.addEventListener("click", function () {
    send.disabled = true;
    show("Sending…");
    fetch("/api/previews/review/annotations", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Vorteo-Review-Key": reviewKey,
      },
      body: JSON.stringify(draft.payload),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (result) {
        discard();
        try {
          localStorage.setItem(SENT_KEY, id + ":" + Date.now());
        } catch {
          /* the preview tab simply will not refresh itself */
        }
        panel.hidden = true;
        show(
          result && result.delivery === "queued"
            ? "Sent. The agent gets it now, or when its current turn ends. You can close this tab."
            : "Saved with this version, but the agent's thread could not be reached. You can close this tab.",
        );
        window.close();
        return result;
      })
      .catch(function (err) {
        send.disabled = false;
        show(
          "Could not send (" +
            (err && err.message ? err.message : "network error") +
            "). Try again.",
        );
      });
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { describeDraft: describeDraft };
} else if (typeof document !== "undefined") {
  startConfirm();
}
