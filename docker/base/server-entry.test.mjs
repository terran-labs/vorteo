// Dev must keep starting when the release mount is empty, missing or holds a release built
// for another Node: those fall back to the image's own daemon. Run: node --test <this file>
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { resolveServerEntry, RECEIPT, ENTRY } = createRequire(import.meta.url)(
  "./rootfs/usr/local/lib/paseo/server-entry.cjs",
);
const COMMIT = "c".repeat(40);

test("Dev runs a valid selected release and falls back to the image otherwise", () => {
  const box = mkdtempSync(path.join(tmpdir(), "server-entry-"));
  try {
    const pointer = path.join(box, "paseo-server-entry");
    writeFileSync(pointer, "/usr/local/lib/node_modules/baked.js\n");
    const root = path.join(box, "releases");
    const release = path.join(root, COMMIT);
    mkdirSync(path.join(release, path.dirname(ENTRY)), { recursive: true });
    writeFileSync(path.join(release, ENTRY), "");
    const receipt = { format: 1, sourceCommit: COMMIT, modules: "127", arch: "arm64" };
    writeFileSync(path.join(release, RECEIPT), JSON.stringify(receipt));
    const choose = (modules = "127") =>
      resolveServerEntry({ root, pointer, modules, arch: "arm64" });

    // No release selected, as on a first install or a deployment without the mount.
    assert.equal(choose().entry, "/usr/local/lib/node_modules/baked.js");
    assert.equal(choose().release, null);

    symlinkSync(COMMIT, path.join(root, "current"));
    assert.equal(choose().release, COMMIT);
    assert.ok(choose().bin.endsWith(path.join(COMMIT, "bin")));

    // A new image with another Node cannot load the release's native modules.
    assert.equal(choose("137").release, null);
    assert.match(choose("137").reason, /Node ABI 127/);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});
