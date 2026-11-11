import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  dependencyKey,
  installDependencies,
  installModes,
  pruneDependencyCache,
} from "./lib/dependency-cache.mjs";
import {
  EXCLUDE_ATTRIBUTE,
  checkoutRegenerables,
  checkoutsUnder,
  excludeFromTimeMachine,
  nodeModulesUnder,
} from "./lib/time-machine-exclusions.mjs";

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-cache-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function checkout(parent, name, lock = "1") {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, "packages/a"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"workspaces":["packages/a"]}');
  fs.writeFileSync(path.join(root, "packages/a/package.json"), '{"name":"@getpaseo/a"}');
  fs.writeFileSync(
    path.join(root, "packages/a/index.js"),
    `module.exports = ${JSON.stringify(name)};`,
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      revision: lock,
      packages: {
        "": {},
        "packages/a": {},
        "node_modules/@getpaseo/a": { link: true, resolved: "packages/a" },
      },
    }),
  );
  return root;
}

/** Writes the tree npm would: hoisted packages, a workspace link and a nested install. */
function fakeNpm(calls) {
  return (command, args, cwd) => {
    calls.push([command, ...args]);
    if (args[0] !== "ci") return;
    fs.mkdirSync(path.join(cwd, "node_modules/@getpaseo"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "node_modules/left-pad.js"), "module.exports = 1;");
    fs.symlinkSync("../../packages/a", path.join(cwd, "node_modules/@getpaseo/a"));
    fs.mkdirSync(path.join(cwd, "packages/a/node_modules/nested"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "packages/a/node_modules/nested/index.js"), "");
    fs.writeFileSync(path.join(cwd, "node_modules/.package-lock.json"), "{}");
  };
}

const copy = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
const options = {
  supported: true,
  queue: false,
  platform: "darwin",
  npmVersion: "11.0.0",
  clone: copy,
  log: () => {},
};

test("unsupported platforms run a plain install", (t) => {
  const parent = temporary(t);
  const root = checkout(parent, "one");
  const calls = [];
  const result = installDependencies({
    ...options,
    root,
    mode: "build",
    cache: path.join(parent, "cache"),
    run: fakeNpm(calls),
    supported: false,
  });
  assert.deepEqual(result, { source: "install" });
  assert.deepEqual(calls, [["npm", ...installModes.build]]);
  assert.equal(fs.existsSync(path.join(parent, "cache")), false);
});

test("an opted-in full install waits for the heavy-job slot", (t) => {
  const parent = temporary(t);
  const calls = [];
  installDependencies({
    ...options,
    root: checkout(parent, "one"),
    mode: "build",
    run: (command, args) => calls.push([command, ...args]),
    supported: false,
    queue: true,
  });
  const [[queuedCommand, script, ...rest]] = calls;
  assert.equal(queuedCommand, process.execPath);
  assert.equal(path.basename(script), "heavy-job.mjs");
  assert.deepEqual(rest, [
    "run",
    "--label",
    "dependency install",
    "--",
    "npm",
    ...installModes.build,
  ]);

  // Builds' commands can run while its gate holds the slot, so they install at once.
  process.env.VORTEO_BUILDS = "1";
  t.after(() => delete process.env.VORTEO_BUILDS);
  calls.length = 0;
  installDependencies({
    ...options,
    root: checkout(parent, "two"),
    mode: "build",
    run: (command, args) => calls.push([command, ...args]),
    supported: false,
    queue: true,
  });
  assert.deepEqual(calls, [["npm", ...installModes.build]]);

  // Linux installs load the fs.cpSync workaround for the Dev container's virtiofs mount.
  calls.length = 0;
  installDependencies({
    ...options,
    root: checkout(parent, "three"),
    mode: "build",
    run: (command, args) => calls.push([command, ...args]),
    supported: false,
    platform: "linux",
  });
  const [[env, nodeOptions, ...npm]] = calls;
  assert.equal(env, "env");
  assert.match(nodeOptions, /^NODE_OPTIONS=.*--require ".*cp-sync-js\.cjs"$/);
  assert.deepEqual(npm, ["npm", ...installModes.build]);
});

test("a second checkout clones the cached install and keeps its own workspace links", (t) => {
  const parent = temporary(t);
  const cache = path.join(parent, "cache");
  const first = checkout(parent, "one");
  const second = checkout(parent, "two");
  const calls = [];
  const run = fakeNpm(calls);
  assert.equal(
    installDependencies({ ...options, root: first, mode: "build", cache, run }).source,
    "install",
  );
  // Stale dependencies are replaced, as npm ci would.
  fs.mkdirSync(path.join(second, "node_modules/stale"), { recursive: true });
  const result = installDependencies({ ...options, root: second, mode: "build", cache, run });
  assert.equal(result.source, "clone");
  assert.deepEqual(calls, [["npm", ...installModes.build]]);
  assert.equal(fs.existsSync(path.join(second, "node_modules/stale")), false);
  assert.ok(fs.existsSync(path.join(second, "packages/a/node_modules/nested/index.js")));
  const linked = fs.realpathSync(path.join(second, "node_modules/@getpaseo/a"));
  assert.equal(linked, fs.realpathSync(path.join(second, "packages/a")));
  // Changing the clone never reaches the cache or the first checkout.
  fs.writeFileSync(path.join(second, "node_modules/left-pad.js"), "changed");
  assert.equal(
    fs.readFileSync(path.join(first, "node_modules/left-pad.js"), "utf8"),
    "module.exports = 1;",
  );
});

test("worktree clones run the prepare hook that a full install would have run", (t) => {
  const parent = temporary(t);
  const cache = path.join(parent, "cache");
  const calls = [];
  const run = fakeNpm(calls);
  installDependencies({ ...options, root: checkout(parent, "one"), mode: "worktree", cache, run });
  installDependencies({ ...options, root: checkout(parent, "two"), mode: "worktree", cache, run });
  assert.deepEqual(calls, [
    ["npm", ...installModes.worktree],
    ["npm", "run", "prepare", "--if-present"],
  ]);
});

test("lockfile, mode and toolchain changes select another install", (t) => {
  const parent = temporary(t);
  const one = checkout(parent, "one", "1");
  const two = checkout(parent, "two", "2");
  const base = dependencyKey(one, "build", { npmVersion: "11.0.0" });
  assert.notEqual(base, dependencyKey(two, "build", { npmVersion: "11.0.0" }));
  assert.notEqual(base, dependencyKey(one, "worktree", { npmVersion: "11.0.0" }));
  assert.notEqual(base, dependencyKey(one, "build", { npmVersion: "11.1.0" }));
  fs.writeFileSync(path.join(one, "packages/a/package.json"), '{"name":"@getpaseo/a","x":1}');
  assert.notEqual(base, dependencyKey(one, "build", { npmVersion: "11.0.0" }));
});

test("our own version bumps keep the same install", (t) => {
  const parent = temporary(t);
  const root = checkout(parent, "one");
  const write = (relative, value) =>
    fs.writeFileSync(path.join(root, relative), JSON.stringify(value));
  // What the version hook rewrites: workspace versions and internal pins.
  const release = (version, extra = {}) => {
    const dependencies = { "@getpaseo/a": version, ...extra };
    write("packages/a/package.json", { name: "@getpaseo/a", version });
    write("package.json", { workspaces: ["packages/a"], version, dependencies });
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    lock.version = version;
    lock.packages[""] = { version, dependencies };
    lock.packages["packages/a"] = { version };
    write("package-lock.json", lock);
    return dependencyKey(root, "build", { npmVersion: "11.0.0" });
  };
  const base = release("1.0.0");
  assert.equal(release("2.0.0"), base);
  assert.notEqual(release("2.0.0", { "left-pad": "1.0.0" }), base);
});

test("a failed clone falls back to a clean install", (t) => {
  const parent = temporary(t);
  const cache = path.join(parent, "cache");
  const calls = [];
  const run = fakeNpm(calls);
  installDependencies({ ...options, root: checkout(parent, "one"), mode: "build", cache, run });
  const second = checkout(parent, "two");
  const result = installDependencies({
    ...options,
    root: second,
    mode: "build",
    cache,
    run,
    clone: () => {
      throw new Error("clone refused");
    },
  });
  assert.equal(result.source, "install");
  assert.equal(calls.length, 2);
  assert.ok(fs.existsSync(path.join(second, "node_modules/.package-lock.json")));
});

test("pruning keeps recent installs and removes old ones and abandoned staging", (t) => {
  const cache = temporary(t);
  const now = Date.now();
  const day = 24 * 60 * 60_000;
  for (const [name, age] of [
    ["a", 0],
    ["b", day],
    ["c", 2 * day],
    ["d", 3 * day],
    ["e", 4 * day],
    ["f", 30 * 60_000], // beyond the newest four by order, but used in the last hour
  ]) {
    fs.mkdirSync(path.join(cache, name));
    const manifest = path.join(cache, name, "manifest.json");
    fs.writeFileSync(manifest, "{}");
    const time = new Date(now - age);
    fs.utimesSync(manifest, time, time);
  }
  fs.mkdirSync(path.join(cache, ".staging-old"));
  fs.utimesSync(path.join(cache, ".staging-old"), new Date(now - 2 * day), new Date(now - 2 * day));
  fs.mkdirSync(path.join(cache, ".staging-new"));
  const removed = pruneDependencyCache(cache, { now, keep: 4 });
  assert.deepEqual(removed.sort(), [".staging-old", "d", "e"]);
});

test(
  "macOS clones share storage with the cached install",
  { skip: process.platform !== "darwin" },
  (t) => {
    const parent = temporary(t);
    const cache = path.join(parent, "cache");
    const run = fakeNpm([]);
    const { clone: _ignored, ...native } = options;
    installDependencies({ ...native, root: checkout(parent, "one"), mode: "build", cache, run });
    const second = checkout(parent, "two");
    assert.equal(
      installDependencies({ ...native, root: second, mode: "build", cache, run }).source,
      "clone",
    );
    assert.equal(
      fs.realpathSync(path.join(second, "node_modules/@getpaseo/a")),
      fs.realpathSync(path.join(second, "packages/a")),
    );
  },
);

// Real Git without the developer's global configuration or hooks.
const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

test("Time Machine exclusions mark only ignored, untracked regenerable folders", (t) => {
  const parent = temporary(t);
  const repo = path.join(parent, "worktrees", "hash", "task");
  const write = (relative, text = "x") => {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), text);
  };
  write(".gitignore", "node_modules/\nbuild/\nBuild/\npackages/a/dist/\npackages/c/dist/\n");
  write(
    "package.json",
    JSON.stringify({ workspaces: [".", "./*", "../escape", "packages/*", "!packages/c"] }),
  );
  for (const name of ["a", "b", "c", "desktop"]) write(`packages/${name}/package.json`, "{}");
  write("packages/a/dist/caf\u00e9.js");
  write("src/index.js");
  write("node_modules/dep/index.js");
  write("packages/a/dist/out.js");
  write("packages/a/node_modules/dep/index.js");
  write("packages/b/Build/out.js");
  write("packages/c/dist/out.js");
  write("packages/desktop/build/icon.png");
  // Ignored by contents only, with one user file re-included: not regenerable.
  write("packages/keep/package.json", "{}");
  write("packages/keep/.gitignore", "dist/*\n!dist/notes.md\n");
  write("packages/keep/dist/out.js");
  write("packages/keep/dist/notes.md");
  // A nested repository that commits its own build folder.
  write("packages/nested/package.json", "{}");
  write("packages/nested/build/out.js");
  execFileSync("git", ["init", "-q", path.join(repo, "packages/nested")], { env: gitEnvironment });
  // A link named like a build folder must not lead the marker to source.
  fs.symlinkSync(path.join(repo, "src"), path.join(repo, "packages/a/build"));
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", env: gitEnvironment });
  git("init", "-q");
  git("add", ".gitignore", "package.json", "src", "packages/a", "packages/b", "packages/c");
  git(
    "add",
    "packages/desktop/package.json",
    "packages/keep/package.json",
    "packages/keep/.gitignore",
  );
  // Tracked although ignored, as packages/desktop/build is in this repository.
  git("add", "-f", "packages/desktop/build/icon.png");

  assert.deepEqual(checkoutsUnder(path.join(parent, "worktrees"), 2), [repo]);
  assert.deepEqual(
    checkoutRegenerables(repo)
      .map((file) => path.relative(repo, file))
      .sort(),
    ["node_modules", "packages/a/dist", "packages/a/node_modules"],
  );
  // Outside a repository, or with a null manifest, nothing qualifies.
  const plain = path.join(parent, "plain");
  fs.mkdirSync(path.join(plain, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(plain, "package.json"), "null");
  assert.deepEqual(checkoutRegenerables(plain), []);

  // Only paths still missing the attribute are written, never through a link; Linux does nothing.
  const writes = [];
  const run = (command, args) => {
    assert.equal(args[0], "-s");
    if (args[1] === "-p" && args.at(-1).endsWith("packages/a/node_modules")) return "";
    if (args[1] === "-p") throw new Error("missing");
    assert.equal(args[2], EXCLUDE_ATTRIBUTE);
    writes.push(path.relative(repo, args.at(-1)));
  };
  const folders = checkoutRegenerables(repo);
  assert.deepEqual(excludeFromTimeMachine(folders, { platform: "darwin", run }), {
    checked: 3,
    added: 2,
    failed: [],
  });
  assert.deepEqual(writes.sort(), ["node_modules", "packages/a/dist"]);
  assert.equal(excludeFromTimeMachine(folders, { platform: "linux", run }).checked, 0);
});

test("named node_modules exclusion takes only exact node_modules folders inside its root", (t) => {
  const parent = temporary(t);
  const root = path.join(parent, "artifacts");
  const folder = (relative) => fs.mkdirSync(path.join(root, relative), { recursive: true });
  folder("task/source/node_modules/dep/node_modules/inner");
  folder("task/source/packages/a/node_modules");
  folder("task/source/dist");
  folder("task/source/Node_Modules");
  folder("task/.git/node_modules");
  folder("evidence/screens");
  fs.mkdirSync(path.join(parent, "outside", "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(parent, "outside", "node_modules"),
    path.join(root, "evidence", "node_modules"),
  );
  assert.deepEqual(
    nodeModulesUnder(root)
      .map((file) => path.relative(root, file))
      .sort(),
    ["task/source/node_modules", "task/source/packages/a/node_modules"],
  );
  assert.deepEqual(nodeModulesUnder(path.join(parent, "missing")), []);
});
