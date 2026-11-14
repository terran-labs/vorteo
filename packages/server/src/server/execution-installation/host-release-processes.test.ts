import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  jobFoldersNamedInFiles,
  linkedReleasePathsInCommands,
  persistentReferenceFiles,
  releasePathsInProcessListing,
} from "./host-release-processes.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const root = "/Users/owner/.local/share/host/releases/reviewed-updates";
const worker = `${root}/e62c022d-ba03-4166-9ceb-d06274c77bdf/build-PtPoSm`;
const host = `${root}/25458d74-9941-425b-b40b-a4238f6e355b/build-CPEFNj`;
const setAside = `${root}/.pruning-3ccfa555-9c86-4423-85a7-27fe999ddad6/build-0DeIbU`;

/**
 * `lsof -a -u <uid> -d cwd,txt -Fn` as macOS prints it: a `p` line per process, an `f` line per
 * descriptor, then its `n` name. Some `txt` entries have no name line at all.
 */
const files = [
  // A daemon worker: working directory `/`, found only by its mapped native module.
  "p91832",
  "fcwd",
  "n/",
  "ftxt",
  "n/Users/owner/.nvm/versions/node/v24.14.1/bin/node",
  "ftxt",
  "ftxt",
  `n${worker}/packages/server/node_modules/node-pty/prebuilds/darwin-arm64/pty.node`,
  "ftxt",
  "n/usr/lib/dyld",
  // A session host: launchd set its working directory inside the release.
  "p20417",
  "fcwd",
  `n${host}/packages/server`,
  "ftxt",
  "n/Users/owner/.nvm/versions/node/v24.14.1/bin/node",
  // A provider CLI whose executable is inside a release that was set aside while it ran.
  "p33102",
  "fcwd",
  "n/Users/owner/dev/project",
  "ftxt",
  `n${setAside}/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
  // Not this root: a sibling whose name merely starts the same way.
  "p4410",
  "fcwd",
  `n${root}-archive/e62c022d-ba03-4166-9ceb-d06274c77bdf/build`,
  "",
].join("\n");

/** `ps -axww -o command=`: one command line per process. */
const commands = [
  `/Users/owner/.nvm/versions/node/v24.14.1/bin/node ${worker}/packages/server/dist/server/server/daemon-worker.js`,
  "/Users/owner/.nvm/versions/node/v24.14.1/bin/node /Users/owner/.local/share/host/current/packages/server/dist/scripts/session-host-entrypoint.js",
  `node --import=${host}/loader.js /elsewhere/main.js --name "two words"`,
  "/usr/sbin/cfprefsd agent",
  "-zsh",
  "",
].join("\n");

test("a real process listing names releases by working directory, mapped code and command line", () => {
  expect(releasePathsInProcessListing(root, { files, commands }).sort()).toEqual(
    [
      `${setAside}/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
      `${host}/loader.js`,
      `${host}/packages/server`,
      `${worker}/packages/server/dist/server/server/daemon-worker.js`,
      `${worker}/packages/server/node_modules/node-pty/prebuilds/darwin-arm64/pty.node`,
    ].sort(),
  );
  // Neither the sibling root nor anything outside the root is reported.
  expect(releasePathsInProcessListing(root, { files: "", commands: "" })).toEqual([]);
});

test("a command line that reaches a release through a link outside the root names it", async () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "host-processes-")));
  roots.push(base);
  const releases = path.join(base, "releases");
  const release = path.join(releases, "00000000-0000-4000-8000-000000000001", "build-x");
  mkdirSync(path.join(release, "packages/server/dist/scripts"), { recursive: true });
  const current = path.join(base, "current");
  symlinkSync(release, current);
  const dangling = path.join(base, "old-current");
  symlinkSync(path.join(releases, "00000000-0000-4000-8000-000000000002", "build-y"), dangling);
  const entry = "packages/server/dist/scripts/session-host-entrypoint.js";
  const listing = [
    `/usr/local/bin/node ${current}/${entry}`,
    // A link whose release is gone, or set aside, still names the folder it points into.
    `/usr/local/bin/node --import=${dangling}/loader.js /elsewhere/main.js`,
    "/usr/local/bin/node /elsewhere/main.js",
  ].join("\n");
  expect((await linkedReleasePathsInCommands(releases, listing)).sort()).toEqual([
    path.join(release, entry),
    path.join(releases, "00000000-0000-4000-8000-000000000002", "build-y", "loader.js"),
  ]);
});

test("Chrome native host wrappers and LaunchAgents name the releases they launch", async () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "host-persistent-")));
  roots.push(base);
  const releases = path.join(base, "releases");
  const alias = path.join(base, "releases-alias");
  mkdirSync(releases);
  symlinkSync(releases, alias);
  const job = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const home = path.join(base, "state", "host");
  // The wrapper Claude Code writes: it execs the release's claude.exe by absolute path.
  const chrome = path.join(home, "claude-accounts", "claude-account-a", "chrome");
  mkdirSync(chrome, { recursive: true });
  writeFileSync(
    path.join(chrome, "chrome-native-host"),
    `#!/bin/sh\nexec "${releases}/${job(1)}/build-x/node_modules/@anthropic-ai/claude-code/bin/claude.exe" --chrome-native-host "$@"\n`,
  );
  // An account without a wrapper names nothing.
  mkdirSync(path.join(home, "claude-accounts", "claude-account-b"), { recursive: true });
  const agents = path.join(base, "LaunchAgents");
  mkdirSync(agents);
  writeFileSync(
    path.join(agents, "local.example.job.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string><string>${alias}/${job(2)}/build-y/main.js</string></array>
</dict></plist>
`,
  );
  // Neither a lookalike root nor a longer name is a job folder of this root.
  writeFileSync(
    path.join(agents, "local.example.other.plist"),
    `<string>${releases}-archive/${job(3)}/x</string><string>${releases}/${job(4)}0/x</string>`,
  );
  writeFileSync(path.join(agents, "notes.txt"), `${releases}/${job(5)}/x`);

  const persistent = await persistentReferenceFiles({ hostHome: home, launchAgents: agents });
  expect((await jobFoldersNamedInFiles(releases, [alias], persistent)).sort()).toEqual([
    path.join(releases, job(1)),
    path.join(releases, job(2)),
  ]);
  // No account directory and no LaunchAgents: nothing to read, not a failure.
  expect(
    await persistentReferenceFiles({ hostHome: path.join(base, "none"), launchAgents: null }),
  ).toEqual([]);
});
