// Vorteo preview review bridge. This script runs inside an UNTRUSTED,
// agent-authored page. It holds no secrets and never sees what the owner
// types: all owner input lives in the comment frame served from the daemon
// origin (D). This script only reports what the owner picked on the page.
//
// Modes (data-vorteo-review-mode on the script element):
//   "frame" (default) live preview on another origin. Embeds {D}/api/previews/frame
//                     in a closed shadow root and talks to it with postMessage.
//   "relay"           inside the sandboxed snapshot iframe of the viewer. No
//                     iframe; the peer is window.parent (opaque origin, "*").
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector("script[data-vorteo-review]");
  if (!script || !script.src) return;
  var D;
  try {
    D = new URL(script.src).origin;
  } catch {
    return;
  }
  if (!/^https?:\/\//.test(D)) return;
  var MODE = script.getAttribute("data-vorteo-review-mode") === "relay" ? "relay" : "frame";

  // Avoid nested toolbars inside iframes of the page, and double loads.
  if (MODE === "frame" && window.top !== window.self) return;
  var LOADED = "__vorteoReviewLoaded";
  if (window[LOADED]) return;
  try {
    Object.defineProperty(window, LOADED, { value: true });
  } catch {
    return;
  }

  var MAX_Z = "2147483647";
  var COLLAPSED = { w: 148, h: 52 };
  var EXPANDED = { w: 360, h: 440 };
  var NARROW = 600;

  var CSS_TEXT = [
    ":host { all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important;",
    "  width: 0 !important; height: 0 !important; overflow: visible !important; z-index: " +
      MAX_Z +
      " !important;",
    "  display: block !important; pointer-events: none !important; }",
    "@media print { :host { display: none !important; } }",
    ".dock { position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px));",
    "  pointer-events: auto; border-radius: 26px; overflow: hidden; box-shadow: 0 6px 24px rgba(0,0,0,.25); }",
    ".dock.expanded { border-radius: 14px; }",
    ".dock.sheet { left: 0; right: 0; bottom: 0; border-radius: 14px 14px 0 0;",
    "  padding-bottom: env(safe-area-inset-bottom, 0px); background: #fff; }",
    "@media (prefers-color-scheme: dark) { .dock.sheet { background: #1c1c1e; } }",
    ".dock.hidden { display: none; }",
    "iframe { display: block; border: 0; width: 100%; height: 100%; background: transparent; color-scheme: normal; }",
    ".overlay { position: fixed; inset: 0; pointer-events: auto; touch-action: none; cursor: crosshair;",
    "  background: rgba(0,0,0,.04); }",
    ".overlay.hidden { display: none; }",
    ".box { position: fixed; pointer-events: none; box-sizing: border-box; border: 2px solid #2f6fed;",
    "  background: rgba(47,111,237,.12); border-radius: 3px; display: none; }",
    ".box.mark { border-color: #e8590c; background: rgba(232,89,12,.12); }",
    ".hint { position: fixed; top: calc(12px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%);",
    "  pointer-events: none; font: 14px/1.3 system-ui, -apple-system, sans-serif; color: #fff;",
    "  background: rgba(20,20,20,.85); padding: 8px 12px; border-radius: 8px; white-space: nowrap; }",
    ".cancel { position: fixed; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); left: 50%;",
    "  transform: translateX(-50%); pointer-events: auto; min-width: 96px; min-height: 44px; padding: 0 18px;",
    "  font: 600 15px/1 system-ui, -apple-system, sans-serif; color: #fff; background: rgba(20,20,20,.9);",
    "  border: 0; border-radius: 22px; cursor: pointer; }",
    ".cancel.hidden { display: none; }",
  ].join("\n");

  // ---- DOM (closed shadow root; nothing touches page elements) ----
  var host = document.createElement("div");
  host.setAttribute("data-vorteo-review-ui", "");
  var root = host.attachShadow({ mode: "closed" });
  applyStyles(root, CSS_TEXT);

  var overlay = el("div", "overlay hidden");
  var hint = el("div", "hint");
  overlay.appendChild(hint);
  var pickBox = el("div", "box");
  var markBox = el("div", "box mark");
  root.appendChild(markBox);
  root.appendChild(overlay);
  root.appendChild(pickBox);
  // Touch screens have no Escape key, so picking always offers a Cancel button.
  var cancelButton = el("button", "cancel hidden");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  root.appendChild(cancelButton);

  var dock = null;
  var iframe = null;
  if (MODE === "frame") {
    dock = el("div", "dock");
    iframe = document.createElement("iframe");
    iframe.title = "Vorteo comments";
    iframe.src = D + "/api/previews/frame";
    iframe.setAttribute("allowtransparency", "true");
    dock.appendChild(iframe);
    root.appendChild(dock);
  }

  var layoutState = "collapsed";
  var requestedSize = null;
  var picking = "idle";
  var regionStart = null;
  var currentTarget = null;
  var markTimer = 0;

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function applyStyles(shadow, text) {
    // Constructable sheets survive pages whose CSP blocks inline <style>.
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      shadow.adoptedStyleSheets = [sheet];
      return;
    } catch {
      /* fall back below */
    }
    var style = document.createElement("style");
    style.textContent = text;
    shadow.appendChild(style);
  }

  function mount() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // ---- peer messaging ----
  function post(type, payload) {
    var msg = { vorteoReview: 1, type: type };
    if (payload) for (var k in payload) msg[k] = payload[k];
    if (MODE === "frame") {
      if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(msg, D);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, "*");
    }
  }

  function viewport() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function sendHello() {
    post("hello", {
      url: location.href,
      title: String(document.title || "").slice(0, 300),
      viewport: viewport(),
      mode: MODE,
    });
  }

  function onMessage(event) {
    if (MODE === "frame") {
      if (event.origin !== D || !iframe || event.source !== iframe.contentWindow) return;
    } else if (event.source !== window.parent || window.parent === window) {
      return;
    }
    var data = event.data;
    if (!data || typeof data !== "object" || data.vorteoReview !== 1) return;
    if (data.type === "mode") {
      if (data.mode === "pick-element" || data.mode === "pick-region") startPick(data.mode);
      else if (data.mode === "idle") stopPick(false);
    } else if (data.type === "layout") {
      if (data.state === "collapsed" || data.state === "expanded") {
        layoutState = data.state;
        requestedSize = { w: num(data.width), h: num(data.height) };
        applyLayout();
      }
    } else if (data.type === "highlight") {
      showMark(data);
    }
  }

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // The frame asks for a state (and optionally a size). Sizes are clamped so a
  // compromised frame message cannot cover the page beyond these bounds.
  function applyLayout() {
    if (!dock) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var s = dock.style;
    dock.classList.toggle("hidden", picking !== "idle");
    var collapsed = layoutState === "collapsed";
    var narrow = vw < NARROW;
    dock.classList.toggle("expanded", !collapsed);
    dock.classList.toggle("sheet", !collapsed && narrow);
    var wantW = (requestedSize && requestedSize.w) || (collapsed ? COLLAPSED.w : EXPANDED.w);
    var wantH = (requestedSize && requestedSize.h) || (collapsed ? COLLAPSED.h : EXPANDED.h);
    if (collapsed) {
      s.width = clamp(wantW, 44, Math.min(240, vw - 32)) + "px";
      s.height = clamp(wantH, 44, 72) + "px";
    } else if (narrow) {
      s.width = "";
      s.height = clamp(wantH, 200, Math.round(vh * 0.85)) + "px";
    } else {
      s.width = clamp(wantW, 280, Math.min(440, vw - 32)) + "px";
      s.height = clamp(wantH, 200, Math.min(640, vh - 32)) + "px";
    }
  }

  // ---- picking ----
  function startPick(kind) {
    picking = kind;
    regionStart = null;
    currentTarget = null;
    hint.textContent =
      kind === "pick-element"
        ? "Tap or click an element. Esc cancels."
        : "Drag to select a region. Esc cancels.";
    overlay.classList.remove("hidden");
    cancelButton.classList.remove("hidden");
    pickBox.style.display = "none";
    applyLayout();
  }

  function stopPick(cancelled) {
    if (picking === "idle") return;
    picking = "idle";
    regionStart = null;
    currentTarget = null;
    overlay.classList.add("hidden");
    cancelButton.classList.add("hidden");
    pickBox.style.display = "none";
    applyLayout();
    if (cancelled) post("pick-cancelled", {});
  }

  function elementAt(x, y) {
    overlay.style.pointerEvents = "none";
    var hit = null;
    try {
      hit = document.elementFromPoint(x, y);
    } finally {
      overlay.style.pointerEvents = "";
    }
    if (!hit || hit === host || hit === document.documentElement) return null;
    return hit;
  }

  function drawBox(box, r) {
    box.style.left = r.x + "px";
    box.style.top = r.y + "px";
    box.style.width = Math.max(0, r.w) + "px";
    box.style.height = Math.max(0, r.h) + "px";
    box.style.display = "block";
  }

  function rectOf(node) {
    var r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function block(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function onPointerDown(event) {
    block(event);
    if (picking === "pick-region") {
      regionStart = { x: event.clientX, y: event.clientY };
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    } else if (picking === "pick-element") {
      hover(event);
    }
  }

  function hover(event) {
    var target = elementAt(event.clientX, event.clientY);
    currentTarget = target;
    if (target) drawBox(pickBox, rectOf(target));
    else pickBox.style.display = "none";
  }

  function regionRect(a, x, y) {
    return {
      x: Math.min(a.x, x),
      y: Math.min(a.y, y),
      w: Math.abs(x - a.x),
      h: Math.abs(y - a.y),
    };
  }

  function onPointerMove(event) {
    block(event);
    if (picking === "pick-element") hover(event);
    else if (picking === "pick-region" && regionStart) {
      drawBox(pickBox, regionRect(regionStart, event.clientX, event.clientY));
    }
  }

  function onPointerUp(event) {
    block(event);
    if (picking === "pick-element") {
      var target = elementAt(event.clientX, event.clientY) || currentTarget;
      if (!target) return;
      var r = rectOf(target);
      var selection = baseSelection("element", r);
      selection.selector = selectorFor(target);
      selection.tag = target.localName;
      var text = visibleText(target);
      if (text) selection.text = text;
      finish(selection);
    } else if (picking === "pick-region" && regionStart) {
      var rr = regionRect(regionStart, event.clientX, event.clientY);
      regionStart = null;
      if (rr.w < 8 || rr.h < 8) {
        pickBox.style.display = "none";
        return;
      }
      finish(baseSelection("region", rr));
    }
  }

  function finish(selection) {
    stopPick(false);
    post("selection", { selection: selection });
  }

  function baseSelection(kind, r) {
    return {
      kind: kind,
      rect: { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) },
      viewport: viewport(),
      scroll: { x: round(window.scrollX), y: round(window.scrollY) },
      url: location.href,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }

  function round(v) {
    return Math.round(v * 10) / 10;
  }

  function visibleText(node) {
    var raw = node.innerText || node.textContent || "";
    return String(raw).replace(/\s+/g, " ").trim().slice(0, 500);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\" + c;
    });
  }

  function uniqueId(node) {
    if (!node.id) return null;
    var sel = "#" + cssEscape(node.id);
    try {
      return document.querySelectorAll(sel).length === 1 ? sel : null;
    } catch {
      return null;
    }
  }

  // 1-based position of node among parent's children with the same tag, and
  // how many such children there are.
  function sameTagPosition(node, parent) {
    var index = 1;
    var count = 0;
    if (!parent) return { index: index, count: count };
    for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName !== node.localName) continue;
      count++;
      if (c === node) index = count;
    }
    return { index: index, count: count };
  }

  // Short, reasonably stable selector: a unique id, else a tag path with
  // nth-of-type only where siblings share the tag. Max 300 characters.
  function selectorFor(node) {
    var parts = [];
    var cur = node;
    while (cur && cur.nodeType === 1) {
      var id = uniqueId(cur);
      if (id) {
        parts.unshift(id);
        break;
      }
      var tag = cur.localName;
      if (cur === document.documentElement) {
        parts.unshift(tag);
        break;
      }
      var parent = cur.parentElement;
      var position = sameTagPosition(cur, parent);
      parts.unshift(position.count > 1 ? tag + ":nth-of-type(" + position.index + ")" : tag);
      cur = parent;
    }
    var out = parts.join(" > ");
    while (out.length > 300 && parts.length > 1) {
      parts.shift();
      out = parts.join(" > ");
    }
    return out.slice(0, 300);
  }

  // ---- highlight a saved selection ----
  function showMark(data) {
    clearTimeout(markTimer);
    markBox.style.display = "none";
    var r = null;
    if (typeof data.selector === "string" && data.selector) {
      var node = null;
      try {
        node = document.querySelector(data.selector.slice(0, 300));
      } catch {
        node = null;
      }
      if (node && node !== host) {
        try {
          node.scrollIntoView({ block: "center", inline: "nearest" });
        } catch {
          /* ignore */
        }
        r = rectOf(node);
      }
    }
    if (!r && data.rect && typeof data.rect === "object") {
      var x = num(data.rect.x);
      var y = num(data.rect.y);
      var w = num(data.rect.w);
      var h = num(data.rect.h);
      if (x !== null && y !== null && w !== null && h !== null) {
        // Rects are viewport relative at pick time; shift by the scroll delta.
        var sx = data.scroll ? num(data.scroll.x) || 0 : window.scrollX;
        var sy = data.scroll ? num(data.scroll.y) || 0 : window.scrollY;
        r = { x: x + sx - window.scrollX, y: y + sy - window.scrollY, w: w, h: h };
      }
    }
    if (!r) return;
    drawBox(markBox, r);
    markTimer = setTimeout(function () {
      markBox.style.display = "none";
    }, 6000);
  }

  // ---- events ----
  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("pointerup", onPointerUp);
  overlay.addEventListener("pointercancel", function (e) {
    block(e);
    regionStart = null;
    pickBox.style.display = "none";
  });
  ["click", "dblclick", "mousedown", "mouseup", "touchstart", "touchend", "contextmenu"].forEach(
    function (type) {
      overlay.addEventListener(type, block, { passive: false });
    },
  );
  // While picking, stop clicks at the window capture phase too, so page
  // listeners registered after this script never see them.
  window.addEventListener(
    "click",
    function (e) {
      // Our own shadow DOM (target retargets to host) handles its events.
      if (picking !== "idle" && e.target !== host) block(e);
    },
    true,
  );
  window.addEventListener(
    "keydown",
    function (e) {
      if (picking !== "idle" && e.key === "Escape") {
        block(e);
        stopPick(true);
      }
    },
    true,
  );
  cancelButton.addEventListener("click", function (e) {
    block(e);
    stopPick(true);
  });
  window.addEventListener("message", onMessage);
  window.addEventListener("resize", applyLayout);

  if (iframe) iframe.addEventListener("load", sendHello);

  function start() {
    mount();
    applyLayout();
    if (MODE === "relay") sendHello();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
