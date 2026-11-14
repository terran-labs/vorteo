import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { installCommand } from "./command.mjs";

for (const existing of ["missing", "owned", "unrelated"]) {
  test(`Host command repair: ${existing}`, () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "command-test-"));
    try {
      const source = path.join(home, "release with spaces");
      const directory = path.join(home, ".local/bin");
      mkdirSync(directory, { recursive: true });
      mkdirSync(path.join(source, "scripts/installer"), { recursive: true });
      writeFileSync(
        path.join(source, "scripts/installer/vorteo.sh"),
        'printf "%s\\n" "$VORTEO_ROOT" "$VORTEO_NODE" "$@"',
      );
      const target = path.join(directory, "vorteo");
      if (existing !== "missing")
        writeFileSync(target, existing === "owned" ? "# vorteo-command-shim\nold" : "unrelated");
      const message = installCommand({
        home,
        root: home,
        source,
        node: process.execPath,
        env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
        platform: "darwin",
      });
      if (existing === "unrelated") {
        assert.equal(readFileSync(target, "utf8"), "unrelated");
        assert.match(message, /Left .* alone/);
        return;
      }
      assert.equal(statSync(target).mode & 0o777, 0o755);
      assert.match(message, /not on your PATH.*~\/.zshrc/);
      for (const args of [["factory", "project", "show", "id"], ["status"]]) {
        const result = spawnSync("bash", [target, ...args], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, [home, process.execPath, ...args, ""].join("\n"));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
