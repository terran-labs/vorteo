// Security checks for the preview review pages. These files are classic
// browser scripts, so each is evaluated in a node:vm context that provides a
// CommonJS-style `module` object; the scripts export their pure helpers there
// and skip all DOM wiring.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Runs under `node --test` and also under the server's vitest run, whose
// default include matches *.test.mjs and whose config sets globals: true.
const { test } = globalThis.vi ? globalThis : await import("node:test");

function load(name, extraGlobals = {}) {
  const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  const sandbox = { module: { exports: {} }, URL, URLSearchParams, ...extraGlobals };
  vm.runInNewContext(source, sandbox, { filename: name });
  return { exports: sandbox.module.exports, source };
}

const SENTINEL = "SENTINEL-review-key-6f1c2a";

function fakeStorage(key) {
  const map = new Map([["vorteo.previews.reviewKey", key]]);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function fakeWindow() {
  const posted = [];
  return { posted, postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }) };
}

test("pair: next accepts only viewer paths and same-hostname https URLs", () => {
  const { validateNext } = load("pair.js").exports;
  const loc = { origin: "https://vorteo.example.ts.net", hostname: "vorteo.example.ts.net" };
  const accepted = [
    [
      "/api/previews/view/abcdefghijklmnop1234",
      "https://vorteo.example.ts.net/api/previews/view/abcdefghijklmnop1234",
    ],
    ["https://vorteo.example.ts.net:8443/deck/", "https://vorteo.example.ts.net:8443/deck/"],
  ];
  for (const [input, expected] of accepted) {
    assert.equal(validateNext(input, loc), expected, input);
  }
  const rejected = [
    "https://evil.example/api/previews/view/abcdefghijklmnop1234",
    "http://vorteo.example.ts.net:8443/",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//evil.example/api/previews/view/abcdefghijklmnop1234",
    "/\\evil.example/api/previews/view/abcdefghijklmnop1234",
    "https:\\\\evil.example",
    "https://vorteo.example.ts.net@evil.example/",
    "https://user:pw@vorteo.example.ts.net/",
    "/api/previews/pair",
    "/api/previews/view/../frame",
    "/api/previews/view/%2e%2e/frame",
    "/api/previews/view/",
    "",
    undefined,
  ];
  for (const input of rejected) {
    assert.equal(validateNext(input, loc), null, String(input));
  }
});

test("frame: the target origin binds once from the first hello's event origin", () => {
  const { acceptPageMessage, createGateState } = load("frame.js").exports;
  const parent = fakeWindow();
  const other = fakeWindow();
  const P = "https://vorteo.example.ts.net:8443";
  const D = "https://vorteo.example.ts.net";
  let state = createGateState("page", parent, D);
  const msg = (data, origin, source = parent) => ({ data, origin, source });

  // Before hello: non-hello types and malformed shapes are dropped.
  assert.equal(
    acceptPageMessage(
      state,
      msg({ vorteoReview: 1, type: "selection", selection: { kind: "page" } }, P),
    ),
    null,
  );
  assert.equal(acceptPageMessage(state, msg({ type: "hello" }, P)), null);
  assert.equal(acceptPageMessage(state, msg("hello", P)), null);
  assert.equal(acceptPageMessage(state, msg({ vorteoReview: 1, type: "hello" }, P, other)), null);

  // A hello whose payload claims another origin still binds the event origin.
  const first = acceptPageMessage(
    state,
    msg(
      {
        vorteoReview: 1,
        type: "hello",
        origin: "https://evil.example",
        targetOrigin: "https://evil.example",
      },
      P,
    ),
  );
  assert.ok(first);
  state = first.state;
  assert.equal(state.targetOrigin, P);

  // Later messages from a second origin, even a second hello, are ignored.
  assert.equal(
    acceptPageMessage(state, msg({ vorteoReview: 1, type: "hello" }, "https://evil.example")),
    null,
  );
  assert.equal(
    acceptPageMessage(
      state,
      msg(
        { vorteoReview: 1, type: "selection", selection: { kind: "page" } },
        "https://evil.example",
      ),
    ),
    null,
  );
  const again = acceptPageMessage(
    state,
    msg({ vorteoReview: 1, type: "hello", origin: "https://evil.example" }, P),
  );
  assert.equal(again.state.targetOrigin, P);

  // Unknown types and invalid selections from the bound origin are dropped.
  assert.equal(
    acceptPageMessage(state, msg({ vorteoReview: 1, type: "send", comment: "x" }, P)),
    null,
  );
  assert.equal(
    acceptPageMessage(
      state,
      msg({ vorteoReview: 1, type: "selection", selection: { kind: "script" } }, P),
    ),
    null,
  );
});

test("viewer: relay forwards only allowlisted types from the expected sources", () => {
  const { relayDecision } = load("viewer.js").exports;
  const snapshotWindow = fakeWindow();
  const commentWindow = fakeWindow();
  const stranger = fakeWindow();
  const ownOrigin = "https://vorteo.example.ts.net";
  const ctx = { snapshotWindow, commentWindow, ownOrigin };
  const ev = (type, source, origin, extra = {}) => ({
    data: { vorteoReview: 1, type, ...extra },
    source,
    origin,
  });

  assert.equal(relayDecision(ev("selection", snapshotWindow, "null"), ctx).to, "comment");
  assert.equal(
    relayDecision(ev("mode", commentWindow, ownOrigin, { mode: "pick-element" }), ctx).to,
    "snapshot",
  );
  assert.equal(relayDecision(ev("context", commentWindow, ownOrigin), ctx).to, "viewer");

  // The snapshot cannot drive the comment frame's outgoing types or the viewer.
  assert.equal(relayDecision(ev("mode", snapshotWindow, "null"), ctx), null);
  assert.equal(relayDecision(ev("context", snapshotWindow, "null"), ctx), null);
  // Unknown types, wrong sources and wrong origins are dropped.
  assert.equal(relayDecision(ev("annotate", snapshotWindow, "null"), ctx), null);
  assert.equal(relayDecision(ev("selection", stranger, "null"), ctx), null);
  assert.equal(relayDecision(ev("selection", snapshotWindow, "https://evil.example"), ctx), null);
  assert.equal(relayDecision(ev("mode", commentWindow, "https://evil.example"), ctx), null);
  assert.equal(
    relayDecision({ data: { type: "selection" }, source: snapshotWindow, origin: "null" }, ctx),
    null,
  );
});

test("frame and viewer never post the review key", () => {
  const storage = fakeStorage(SENTINEL);
  const frame = load("frame.js", { localStorage: storage });
  const viewer = load("viewer.js", { localStorage: storage });
  const key = frame.exports.readReviewKey(storage);
  assert.equal(key, SENTINEL);

  // Every postMessage call goes through the audited helpers.
  assert.equal(frame.source.match(/\.postMessage\(/g).length, 1);
  assert.equal(viewer.source.match(/\.postMessage\(/g).length, 2);

  // frame.js: send every outgoing type with the key smuggled into payloads.
  const parent = fakeWindow();
  const state = {
    ...frame.exports.createGateState("page", parent, "https://d"),
    targetOrigin: "https://p",
  };
  const smuggle = { reviewKey: key, key, headers: { "X-Vorteo-Review-Key": key } };
  frame.exports.sendToParent(state, "mode", { mode: "pick-element", ...smuggle });
  frame.exports.sendToParent(state, "layout", { state: "expanded", ...smuggle });
  frame.exports.sendToParent(state, "highlight", {
    selector: "#a",
    rect: { x: 1, y: 2, w: 3, h: 4, key },
    ...smuggle,
  });
  frame.exports.sendToParent(state, "context", {
    artifact: { title: "Deck", versionId: "v", reviewKey: key },
    ...smuggle,
  });
  frame.exports.sendToParent(state, "review-key", { key });
  assert.equal(parent.posted.length, 4);

  // viewer.js: relay messages from both sides carrying the key in extra fields.
  const snapshotWindow = fakeWindow();
  const commentWindow = fakeWindow();
  const ctx = { snapshotWindow, commentWindow, ownOrigin: "https://d" };
  for (const [type, source, origin] of [
    ["hello", snapshotWindow, "null"],
    ["selection", snapshotWindow, "null"],
    ["mode", commentWindow, "https://d"],
    ["highlight", commentWindow, "https://d"],
  ]) {
    const decision = viewer.exports.relayDecision(
      { data: { vorteoReview: 1, type, ...smuggle }, source, origin },
      ctx,
    );
    assert.ok(viewer.exports.deliver(decision, ctx), type);
  }

  const everything = JSON.stringify([parent.posted, snapshotWindow.posted, commentWindow.posted]);
  assert.ok(!everything.includes(SENTINEL), "a posted message contained the review key");
});

test("frame: embedded in another origin, feedback goes to the confirmation page, never a post", () => {
  const { source } = load("frame.js");
  const submit = source.slice(source.indexOf("function submit("));
  const handOff = submit.indexOf('if (embedding === "page")');
  const post = submit.indexOf('api("POST"');
  // The hand-off must sit before the only post in the submit path, and return.
  assert.ok(handOff > 0 && post > handOff);
  assert.match(submit.slice(handOff, post), /openConfirmation\(payload\);\s*return;/);
  assert.equal(source.split('api("POST"').length - 1, 1);
});

test("confirm: only a fresh, well-formed draft for a live preview is offered", () => {
  const { describeDraft } = load("confirm.js").exports;
  const now = 1_000_000;
  const draft = (overrides = {}) =>
    JSON.stringify({
      payload: {
        target: { origin: "https://host:32777", versionId: "abcDEF0123456789abcd" },
        comment: "Tighter spacing",
        rating: 4,
      },
      versionNumber: 3,
      title: "Site",
      createdAt: now - 1000,
      ...overrides,
    });
  const shown = describeDraft(draft(), now);
  assert.equal(shown.comment, "Tighter spacing");
  assert.equal(shown.rating, 4);
  assert.match(shown.artifact, /version 3/);
  // A draft that does not name the reviewed version is never offered.
  assert.equal(
    describeDraft(
      draft({ payload: { target: { origin: "https://host:32777" }, comment: "x" } }),
      now,
    ),
    null,
  );
  assert.equal(describeDraft("not json", now), null);
  assert.equal(describeDraft(draft({ createdAt: now - 11 * 60 * 1000 }), now), null);
  assert.equal(describeDraft(draft({ payload: { target: {}, comment: "x" } }), now), null);
  assert.equal(
    describeDraft(draft({ payload: { target: { origin: "https://h" }, comment: " " } }), now),
    null,
  );
});
