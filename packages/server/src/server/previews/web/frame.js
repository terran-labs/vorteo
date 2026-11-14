// Vorteo comment frame. TRUSTED: served from the daemon origin (D).
//
// Two embeddings:
//   "page"   cross-origin iframe inside an untrusted live preview (origin P).
//            The target origin is bound from event.origin of the first valid
//            `hello`, never from message contents or document.referrer.
//   "viewer" same-origin iframe inside viewer.html. versionId comes from this
//            frame's own URL query and the parent is trusted.
//
// The review key lives only in this document's localStorage and in request
// headers to D. It is never posted to the parent, put in a URL or rendered.
// Every postMessage from this file goes through sendToParent, which rebuilds
// each message from an allowlist of fields.
"use strict";

var REVIEW_KEY_STORAGE = "vorteo.previews.reviewKey";
var DRAFT_PREFIX = "vorteo.previews.draft.";
var SENT_KEY = "vorteo.previews.sent";

function newDraftId() {
  var bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.prototype.map
    .call(bytes, function (b) {
      return ("0" + b.toString(16)).slice(-2);
    })
    .join("");
}
var PAGE_TYPES = { hello: true, selection: true, "pick-cancelled": true };
var SELECTION_KINDS = { element: true, region: true, page: true };
var VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// ---------- pure helpers (exported for tests) ----------

function isHttpOrigin(value) {
  return typeof value === "string" && /^https?:\/\/[^/\s?#@\\]+$/.test(value);
}

function str(value, max) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function finite(value) {
  return typeof value === "number" && isFinite(value) ? value : 0;
}

function size(value) {
  var v = value && typeof value === "object" ? value : {};
  return { w: finite(v.w), h: finite(v.h) };
}

// Selection data comes from an untrusted page: keep only known fields with
// bounded types and lengths. It is display data, never markup or a link target.
function sanitizeSelection(sel) {
  if (!sel || typeof sel !== "object" || !SELECTION_KINDS.hasOwnProperty(sel.kind)) return null;
  var rect = sel.rect && typeof sel.rect === "object" ? sel.rect : {};
  var out = {
    kind: sel.kind,
    rect: { x: finite(rect.x), y: finite(rect.y), w: finite(rect.w), h: finite(rect.h) },
    viewport: size(sel.viewport),
    scroll: (function (s) {
      var v = s && typeof s === "object" ? s : {};
      return { x: finite(v.x), y: finite(v.y) };
    })(sel.scroll),
    devicePixelRatio: Math.min(10, Math.max(0.1, finite(sel.devicePixelRatio) || 1)),
  };
  var url = str(sel.url, 2000);
  if (url) out.url = url;
  var selector = str(sel.selector, 300);
  if (selector && sel.kind === "element") out.selector = selector;
  var text = str(sel.text, 500);
  if (text) out.text = text;
  if (typeof sel.tag === "string" && /^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(sel.tag)) {
    out.tag = sel.tag.toLowerCase();
  }
  return out;
}

function sanitizePageMessage(data) {
  if (data.type === "hello") {
    return {
      type: "hello",
      url: str(data.url, 2000) || "",
      title: str(data.title, 300) || "",
      viewport: size(data.viewport),
      mode: data.mode === "relay" ? "relay" : "frame",
    };
  }
  if (data.type === "selection") {
    var selection = sanitizeSelection(data.selection);
    return selection ? { type: "selection", selection: selection } : null;
  }
  return { type: "pick-cancelled" };
}

function createGateState(embedding, parentWindow, ownOrigin) {
  return {
    embedding: embedding === "viewer" ? "viewer" : "page",
    parent: parentWindow,
    ownOrigin: ownOrigin,
    targetOrigin: embedding === "viewer" ? ownOrigin : null,
  };
}

// Decide whether a message event from the parent is acceptable. Returns
// { state, message } with a possibly updated state, or null to drop it.
// In the "page" embedding the target origin binds once, from the event origin
// of the first valid hello. Nothing in the payload can change it.
function acceptPageMessage(state, event) {
  if (!state || !event || !state.parent || event.source !== state.parent) return null;
  var data = event.data;
  if (!data || typeof data !== "object" || data.vorteoReview !== 1) return null;
  if (typeof data.type !== "string" || !PAGE_TYPES.hasOwnProperty(data.type)) return null;
  var next = state;
  if (state.embedding === "viewer") {
    if (event.origin !== state.ownOrigin) return null;
  } else if (state.targetOrigin === null) {
    if (data.type !== "hello" || !isHttpOrigin(event.origin)) return null;
    next = {
      embedding: state.embedding,
      parent: state.parent,
      ownOrigin: state.ownOrigin,
      targetOrigin: event.origin,
    };
  } else if (event.origin !== state.targetOrigin) {
    return null;
  }
  var message = sanitizePageMessage(data);
  return message ? { state: next, message: message } : null;
}

function pickRect(r) {
  if (!r || typeof r !== "object") return undefined;
  return { x: finite(r.x), y: finite(r.y), w: finite(r.w), h: finite(r.h) };
}

// Per-type field allowlists for outgoing messages. Each copies only the
// fields its type uses from the payload into msg.
var OUTGOING_FIELDS = {
  mode: function (msg, p) {
    msg.mode = p.mode === "pick-element" || p.mode === "pick-region" ? p.mode : "idle";
  },
  layout: function (msg, p) {
    msg.state = p.state === "expanded" ? "expanded" : "collapsed";
    if (typeof p.width === "number") msg.width = finite(p.width);
    if (typeof p.height === "number") msg.height = finite(p.height);
  },
  highlight: function (msg, p) {
    var selector = str(p.selector, 300);
    if (selector) msg.selector = selector;
    var rect = pickRect(p.rect);
    if (rect) msg.rect = rect;
    if (p.scroll && typeof p.scroll === "object") {
      msg.scroll = { x: finite(p.scroll.x), y: finite(p.scroll.y) };
    }
  },
  context: function (msg, p) {
    msg.artifact = outgoingArtifact(p.artifact);
  },
};

function outgoingArtifact(a) {
  if (!a || typeof a !== "object") return null;
  return {
    title: str(a.title, 300) || "",
    versionId: str(a.versionId, 64) || "",
    versionNumber: typeof a.versionNumber === "number" ? a.versionNumber : null,
    kind: str(a.kind, 40) || "",
    live: a.live === true,
  };
}

// Build an outgoing message from an allowlist of fields per type. Anything
// else in the payload is dropped, so a stray secret cannot ride along.
function buildOutgoing(type, payload) {
  if (typeof type !== "string" || !OUTGOING_FIELDS.hasOwnProperty(type)) return null;
  var p = payload && typeof payload === "object" ? payload : {};
  var msg = { vorteoReview: 1, type: type };
  OUTGOING_FIELDS[type](msg, p);
  return msg;
}

// The only postMessage in this file. Sends nothing until a target is bound.
function sendToParent(state, type, payload) {
  if (!state || !state.parent || !state.targetOrigin) return false;
  var msg = buildOutgoing(type, payload);
  if (!msg) return false;
  state.parent.postMessage(msg, state.targetOrigin);
  return true;
}

function readReviewKey(storage) {
  try {
    var key = storage && storage.getItem(REVIEW_KEY_STORAGE);
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

function clearReviewKey(storage) {
  try {
    storage.removeItem(REVIEW_KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

function describeSelection(sel) {
  if (!sel || typeof sel !== "object") return "";
  if (sel.kind === "page") return "Whole page";
  if (sel.kind === "region") {
    var r = sel.rect || {};
    return "Region " + Math.round(finite(r.w)) + " x " + Math.round(finite(r.h)) + " px";
  }
  var text = typeof sel.text === "string" ? sel.text.slice(0, 80) : "";
  var tag = typeof sel.tag === "string" ? "<" + sel.tag + ">" : "Element";
  return text ? tag + " " + text : tag;
}

// ---------- browser wiring ----------

function startFrame() {
  var ownOrigin = location.origin;
  var embedding = "page";
  try {
    if (window.parent !== window && window.parent.location.origin === ownOrigin) {
      embedding = "viewer";
    }
  } catch {
    embedding = "page";
  }
  var versionId = null;
  if (embedding === "viewer") {
    var fromQuery = new URLSearchParams(location.search).get("versionId");
    versionId = fromQuery && VERSION_ID_PATTERN.test(fromQuery) ? fromQuery : null;
  }

  var gate = createGateState(embedding, window.parent, ownOrigin);
  var storage = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  var reviewKey = readReviewKey(storage);

  var ui = {
    expanded: embedding === "viewer",
    loaded: false,
    unpaired: !reviewKey,
    artifact: null,
    savedRating: null,
    pendingRating: null,
    selection: null,
    picking: null,
    sending: false,
    hello: null,
    annotations: [],
    loadError: "",
  };

  var $ = function (id) {
    return document.getElementById(id);
  };
  var body = document.body;
  var pill = $("pill");
  var pillRating = $("pill-rating");
  var notice = $("notice");
  var controls = $("controls");
  var titleEl = $("artifact-title");
  var versionEl = $("artifact-version");
  var starsEl = $("stars");
  var saveRating = $("save-rating");
  var pickElement = $("pick-element");
  var pickRegion = $("pick-region");
  var pickPage = $("pick-page");
  var chip = $("chip");
  var chipText = $("chip-text");
  var chipClear = $("chip-clear");
  var comment = $("comment");
  var statusEl = $("status");
  var send = $("send");
  var historyTitle = $("history-title");
  var historyList = $("history");

  var starButtons = [];
  for (var i = 1; i <= 5; i++) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "★";
    b.setAttribute("aria-label", i + (i === 1 ? " star" : " stars"));
    b.dataset.value = String(i);
    starsEl.appendChild(b);
    starButtons.push(b);
  }

  function setStatus(text, tone) {
    statusEl.textContent = text || "";
    statusEl.className = "status small" + (tone ? " " + tone : "");
  }

  function setLayout(expanded) {
    sendToParent(gate, "layout", { state: expanded ? "expanded" : "collapsed" });
    // In the viewer the panel is the viewer's to show or hide; stay expanded.
    if (embedding === "viewer") return;
    ui.expanded = expanded;
    body.classList.toggle("collapsed", !expanded);
    if (expanded) render();
  }

  function render() {
    var a = ui.artifact;
    titleEl.textContent = a && a.title ? a.title : "Comments";
    versionEl.textContent = a
      ? (typeof a.versionNumber === "number" ? "Version " + a.versionNumber : "") +
        (a.live ? " (live)" : "")
      : "";

    var noticeText = "";
    if (ui.unpaired) {
      noticeText = "Open this preview from the Previews gallery in Vorteo to turn on comments.";
    } else if (ui.loadError) {
      noticeText = ui.loadError;
    } else if (!ui.loaded) {
      noticeText = "Loading comments…";
    } else if (!a) {
      noticeText = "This preview is not in the Previews gallery, so comments are off.";
    }
    notice.textContent = noticeText;
    controls.hidden = Boolean(noticeText);

    var shown = ui.pendingRating;
    starButtons.forEach(function (btn, idx) {
      btn.classList.toggle("on", shown !== null && idx < shown);
      btn.setAttribute("aria-pressed", shown === idx + 1 ? "true" : "false");
    });
    var ratingToSend = pendingRatingToSend();
    saveRating.hidden = ratingToSend === null;
    pillRating.hidden = ui.savedRating === null;
    pillRating.textContent = ui.savedRating !== null ? "★ " + ui.savedRating : "";

    pickElement.classList.toggle("active", ui.picking === "pick-element");
    pickRegion.classList.toggle("active", ui.picking === "pick-region");
    chip.hidden = !ui.selection;
    chipText.textContent = ui.selection ? describeSelection(ui.selection) : "";

    send.disabled = ui.sending || (!comment.value.trim() && ratingToSend === null);
    saveRating.disabled = ui.sending;
    renderHistory();
  }

  function pendingRatingToSend() {
    return ui.pendingRating !== null && ui.pendingRating !== ui.savedRating
      ? ui.pendingRating
      : null;
  }

  function renderHistory() {
    while (historyList.firstChild) historyList.removeChild(historyList.firstChild);
    historyTitle.hidden = ui.annotations.length === 0;
    var recent = [];
    for (var n = ui.annotations.length - 1; n >= 0 && recent.length < 20; n--) {
      recent.push(ui.annotations[n]);
    }
    recent.forEach(function (item) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      var text = document.createElement("span");
      text.textContent = (typeof item.comment === "string" && item.comment) || "(rating only)";
      var meta = document.createElement("span");
      meta.className = "meta";
      var when = "";
      if (item.createdAt) {
        var d = new Date(item.createdAt);
        if (!isNaN(d.getTime())) when = d.toLocaleString();
      }
      var where = describeSelection(item.selection);
      meta.textContent = [where, when].filter(Boolean).join(" · ");
      btn.appendChild(text);
      btn.appendChild(meta);
      btn.disabled = !item.selection || item.selection.kind === "page";
      btn.addEventListener("click", function () {
        var sel = item.selection;
        if (!sel) return;
        sendToParent(gate, "highlight", {
          selector: sel.selector,
          rect: sel.rect,
          scroll: sel.scroll,
        });
        // A bottom sheet covers the page on phones; get out of the way.
        if (embedding === "page" && ui.hello && ui.hello.viewport.w < 600) setLayout(false);
      });
      li.appendChild(btn);
      historyList.appendChild(li);
    });
  }

  function target() {
    if (embedding === "viewer") return versionId ? { versionId: versionId } : null;
    // Live feedback is bound to the version this frame loaded and showed, not to whatever
    // is newest at that address when it is finally sent.
    if (!gate.targetOrigin) return null;
    var shown =
      ui.artifact && typeof ui.artifact.versionId === "string" ? ui.artifact.versionId : null;
    return shown ? { origin: gate.targetOrigin, versionId: shown } : { origin: gate.targetOrigin };
  }

  function becomeUnpaired() {
    clearReviewKey(storage);
    reviewKey = null;
    ui.unpaired = true;
    render();
  }

  function api(method, path, payload) {
    var init = {
      method: method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Vorteo-Review-Key": reviewKey, Accept: "application/json" },
    };
    if (payload !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(payload);
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 401) {
        becomeUnpaired();
        throw new Error("unpaired");
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function loadContext() {
    if (!reviewKey) {
      ui.unpaired = true;
      render();
      return;
    }
    var t = target();
    if (!t) return;
    var query = t.versionId
      ? "versionId=" + encodeURIComponent(t.versionId)
      : "origin=" + encodeURIComponent(t.origin);
    api("GET", "/api/previews/review/context?" + query)
      .then(function (ctx) {
        ui.loaded = true;
        ui.loadError = "";
        ui.artifact = ctx && ctx.artifact && typeof ctx.artifact === "object" ? ctx.artifact : null;
        var rating = ctx && typeof ctx.rating === "number" ? ctx.rating : null;
        if (ui.pendingRating === ui.savedRating) ui.pendingRating = rating;
        ui.savedRating = rating;
        ui.annotations = Array.isArray(ctx && ctx.annotations) ? ctx.annotations : [];
        render();
        return sendToParent(gate, "context", { artifact: ui.artifact });
      })
      .catch(function (err) {
        if (err && err.message === "unpaired") return;
        ui.loaded = true;
        ui.loadError = "Could not load comments. Check that Vorteo is running and reload.";
        render();
      });
  }

  function openConfirmation(payload) {
    var id = newDraftId();
    try {
      storage.setItem(
        DRAFT_PREFIX + id,
        JSON.stringify({
          payload: payload,
          title: ui.artifact && typeof ui.artifact.title === "string" ? ui.artifact.title : "",
          versionNumber:
            ui.artifact && typeof ui.artifact.versionNumber === "number"
              ? ui.artifact.versionNumber
              : null,
          createdAt: Date.now(),
        }),
      );
    } catch {
      setStatus("This browser blocked storage for Vorteo, so the comment cannot be sent.", "error");
      return;
    }
    var opened = window.open("/api/previews/confirm#" + id, "_blank");
    if (!opened) {
      try {
        storage.removeItem(DRAFT_PREFIX + id);
      } catch {
        /* ignore */
      }
      setStatus(
        "Your browser blocked the confirmation tab. Allow pop-ups for Vorteo, then press Send again.",
        "error",
      );
      return;
    }
    setStatus("Check the new tab and confirm there to send it.", "muted");
  }

  // The confirmation page reports a completed send through this origin's storage.
  window.addEventListener("storage", function (event) {
    if (event.key !== SENT_KEY || !event.newValue) return;
    comment.value = "";
    ui.selection = null;
    setStatus("Sent. The agent gets it now, or when its current turn ends.", "success");
    render();
    loadContext();
  });

  function submit(ratingOnly) {
    var t = target();
    if (!t || ui.sending || !reviewKey) return;
    var text = ratingOnly ? "" : comment.value.trim();
    var rating = pendingRatingToSend();
    if (!text && rating === null) return;
    // No version to bind to means this preview is not in the gallery; nothing can be sent.
    if (embedding === "page" && !t.versionId) return;
    var payload = { target: t, comment: text };
    if (rating !== null) payload.rating = rating;
    if (!ratingOnly && ui.selection) payload.selection = ui.selection;
    // Embedded in another origin, this frame can be covered, moved or made invisible by the
    // page around it, so a click or keystroke here is not proof of intent. It never posts.
    // The owner confirms on a top-level page that cannot be framed.
    if (embedding === "page") {
      openConfirmation(payload);
      return;
    }
    ui.sending = true;
    setStatus("Sending…");
    render();
    api("POST", "/api/previews/review/annotations", payload)
      .then(function (res) {
        ui.sending = false;
        if (rating !== null) ui.savedRating = rating;
        if (!ratingOnly) {
          comment.value = "";
          ui.selection = null;
        }
        if (res && res.delivery === "queued") {
          setStatus(
            ratingOnly
              ? "Rating saved and sent to the agent."
              : "Sent. The agent gets it now, or when its current turn ends.",
            "success",
          );
        } else {
          setStatus(
            "Saved with this version, but the agent's thread could not be reached, so it was not delivered.",
            "muted",
          );
        }
        render();
        loadContext();
        return res;
      })
      .catch(function (err) {
        ui.sending = false;
        if (err && err.message === "unpaired") {
          setStatus("");
          return;
        }
        setStatus(
          "Could not send (" +
            (err && err.message ? err.message : "network error") +
            "). Your text is still here.",
          "error",
        );
        render();
      });
  }

  function startPick(mode) {
    ui.picking = mode;
    setStatus("");
    sendToParent(gate, "mode", { mode: mode });
    render();
  }

  // ---- events ----
  pill.addEventListener("click", function () {
    setLayout(true);
  });
  $("collapse").addEventListener("click", function () {
    setLayout(false);
  });
  starButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var value = Number(btn.dataset.value);
      ui.pendingRating = ui.pendingRating === value ? null : value;
      render();
    });
  });
  saveRating.addEventListener("click", function () {
    submit(true);
  });
  pickElement.addEventListener("click", function () {
    startPick("pick-element");
  });
  pickRegion.addEventListener("click", function () {
    startPick("pick-region");
  });
  pickPage.addEventListener("click", function () {
    var h = ui.hello;
    var vp = h ? h.viewport : { w: 0, h: 0 };
    ui.selection = sanitizeSelection({
      kind: "page",
      rect: { x: 0, y: 0, w: vp.w, h: vp.h },
      viewport: vp,
      scroll: { x: 0, y: 0 },
      url: h ? h.url : undefined,
      devicePixelRatio: 1,
    });
    if (ui.picking) sendToParent(gate, "mode", { mode: "idle" });
    ui.picking = null;
    render();
  });
  chipClear.addEventListener("click", function () {
    ui.selection = null;
    render();
  });
  comment.addEventListener("input", render);
  comment.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit(false);
    }
  });
  send.addEventListener("click", function () {
    submit(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (ui.picking) {
      ui.picking = null;
      sendToParent(gate, "mode", { mode: "idle" });
      render();
    }
    if (ui.expanded) setLayout(false);
  });

  window.addEventListener("message", function (event) {
    var accepted = acceptPageMessage(gate, event);
    if (!accepted) return;
    var bindingNow = gate.targetOrigin === null && accepted.state.targetOrigin !== null;
    gate = accepted.state;
    var msg = accepted.message;
    if (msg.type === "hello") {
      ui.hello = msg;
      if (bindingNow) {
        // First contact: report our layout and load this preview's context.
        sendToParent(gate, "layout", { state: ui.expanded ? "expanded" : "collapsed" });
        loadContext();
      }
    } else if (msg.type === "selection") {
      ui.picking = null;
      ui.selection = msg.selection;
      setStatus("");
      setLayout(true);
    } else if (msg.type === "pick-cancelled") {
      ui.picking = null;
      setLayout(true);
    }
  });

  body.classList.toggle("collapsed", !ui.expanded);
  render();
  if (embedding === "viewer") {
    sendToParent(gate, "layout", { state: "expanded" });
    if (!versionId) {
      ui.loaded = true;
      ui.loadError = "This link is missing its preview version.";
      render();
    } else {
      loadContext();
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    REVIEW_KEY_STORAGE: REVIEW_KEY_STORAGE,
    acceptPageMessage: acceptPageMessage,
    buildOutgoing: buildOutgoing,
    clearReviewKey: clearReviewKey,
    createGateState: createGateState,
    describeSelection: describeSelection,
    readReviewKey: readReviewKey,
    sanitizeSelection: sanitizeSelection,
    sendToParent: sendToParent,
  };
} else if (typeof document !== "undefined") {
  startFrame();
}
