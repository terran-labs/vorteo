// Vorteo preview pairing. TRUSTED: top-level document on the daemon origin.
// URL: /api/previews/pair#ticket=<t>&next=<url>
// Exchanges a one-time ticket for a review key, stores it in this origin's
// localStorage, then continues to `next` only when it passes validateNext.
"use strict";

var REVIEW_KEY_STORAGE = "vorteo.previews.reviewKey";
var VIEW_PREFIX = "/api/previews/view/";

// True when the string has a backslash, whitespace, or a control character
// (U+0000 to U+001F, U+007F). A char-code loop avoids a control-character regex.
function hasUnsafeCharacter(value) {
  if (/[\\\s]/.test(value)) return true;
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// Pure: a live preview is an exact origin the preview broker reserved. Sharing this
// page's hostname is not enough: another port on it may serve anything.
function isPreviewOrigin(url, previewOrigins) {
  return Array.isArray(previewOrigins) && previewOrigins.indexOf(url.origin) !== -1;
}

// Pure: returns the URL to navigate to, or null. `loc` needs origin and hostname.
// Allowed: a same-origin path under /api/previews/view/, or an absolute https
// URL at an origin the preview broker reserved.
function validateNext(next, loc, previewOrigins) {
  if (typeof next !== "string" || !next || next.length > 2048) return null;
  if (!loc || typeof loc.origin !== "string" || typeof loc.hostname !== "string") return null;
  // Backslashes, whitespace and control characters invite parser differentials.
  if (hasUnsafeCharacter(next)) return null;
  var url;
  if (next.charAt(0) === "/") {
    if (next.charAt(1) === "/") return null; // protocol-relative
    try {
      url = new URL(next, loc.origin);
    } catch {
      return null;
    }
    if (url.origin !== loc.origin) return null;
    // Checked after parsing, so dot segments (also %2e) are already resolved.
    if (url.pathname.indexOf(VIEW_PREFIX) !== 0 || url.pathname.length <= VIEW_PREFIX.length) {
      return null;
    }
    return url.href;
  }
  try {
    url = new URL(next);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!isPreviewOrigin(url, previewOrigins)) return null;
  return url.href;
}

function startPair() {
  var message = document.getElementById("message");
  var params = new URLSearchParams(location.hash.replace(/^#/, ""));
  var ticket = params.get("ticket");
  var next = params.get("next");
  // Clear the fragment at once so the ticket does not linger in history.
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* ignore */
  }

  function show(text, tone) {
    message.textContent = text;
    message.className = tone || "";
  }

  function expired() {
    show("This link has expired. Open the preview again from the Previews gallery.", "error");
  }

  function existingKey() {
    try {
      return localStorage.getItem(REVIEW_KEY_STORAGE);
    } catch {
      return null;
    }
  }

  function proceed() {
    var listed = document.documentElement.getAttribute("data-preview-origins") || "";
    var target = validateNext(next, location, listed.split(" ").filter(Boolean));
    if (target) location.replace(target);
    else show("Paired. You can close this tab.");
  }

  if (!ticket) {
    if (existingKey()) proceed();
    else expired();
    return;
  }

  fetch("/api/previews/pair", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ticket: ticket }),
  })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      var key = data && typeof data.reviewKey === "string" ? data.reviewKey : "";
      if (!key) throw new Error("missing key");
      try {
        localStorage.setItem(REVIEW_KEY_STORAGE, key);
      } catch {
        show("This browser blocked storage for Vorteo, so comments cannot be turned on.", "error");
        return false;
      }
      proceed();
      return true;
    })
    .catch(expired);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { validateNext: validateNext };
} else if (typeof document !== "undefined") {
  startPair();
}
