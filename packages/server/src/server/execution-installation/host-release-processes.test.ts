import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { pruneHostReleases } from "./host-release-retention.js";
import {
  jobFoldersNamedInFiles,
  linkedReleasePathsInCommands,
  pathsInListing,
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
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><array><string>${releases}-archive/${job(3)}/x</string><string>${releases}/${job(4)}0/x</string></array></plist>
`,
  );
  writeFileSync(path.join(agents, "notes.txt"), `${releases}/${job(5)}/x`);

  const persistent = await persistentReferenceFiles({ hostHome: home, launchAgents: agents });
  // Account b has no wrapper; its path is listed, and a missing file names nothing.
  expect(persistent.map((file) => path.basename(file)).sort()).toEqual([
    "chrome-native-host",
    "chrome-native-host",
    "local.example.job.plist",
    "local.example.other.plist",
  ]);
  // The wrapper is plain text and is read the same way on every platform.
  const wrappers = persistent.filter((file) => !file.endsWith(".plist"));
  expect(await jobFoldersNamedInFiles(releases, [alias], wrappers)).toEqual([
    path.join(releases, job(1)),
  ]);
  // The LaunchAgents' text, searched with parsing stubbed out, on every platform.
  expect(
    (await jobFoldersNamedInFiles(releases, [alias], persistent, async () => [])).sort(),
  ).toEqual([path.join(releases, job(1)), path.join(releases, job(2))]);
  // Real parsing is plutil on macOS. Elsewhere it is refused, so the scan fails closed and
  // the cleanup is skipped; the Host scans no LaunchAgents there.
  const scan = jobFoldersNamedInFiles(releases, [alias], persistent);
  if (process.platform === "darwin")
    expect((await scan).sort()).toEqual([path.join(releases, job(1)), path.join(releases, job(2))]);
  else await expect(scan).rejects.toThrow("Property lists cannot be parsed");
  // No account directory and no LaunchAgents: nothing to read, not a failure.
  expect(
    await persistentReferenceFiles({ hostHome: path.join(base, "none"), launchAgents: null }),
  ).toEqual([]);
});

/** A property list written by Python's plistlib, binary or UTF-16 XML, naming `target`. */
function writePlist(file: string, target: string, format: "binary" | "utf16-xml") {
  const script =
    format === "binary"
      ? "import plistlib,sys;plistlib.dump({'ProgramArguments':['/usr/bin/node',sys.argv[2]]},open(sys.argv[1],'wb'),fmt=plistlib.FMT_BINARY)"
      : "import plistlib,sys;open(sys.argv[1],'wb').write(plistlib.dumps({'ProgramArguments':['/usr/bin/node',sys.argv[2]]}).decode().replace('UTF-8','UTF-16').encode('utf-16'))";
  execFileSync("python3", ["-I", "-c", script, file, target]);
}

test("review: a binary or UTF-16 property list naming a non-ASCII path keeps its release", async () => {
  // A binary plist stores any string with a non-ASCII character as UTF-16BE, root and job ID
  // included; a byte search for the ASCII path found nothing and the release was deleted.
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "host-plist-")));
  roots.push(base);
  const releases = path.join(base, "releases");
  const job = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  for (let n = 0; n < 4; n++) mkdirSync(path.join(releases, job(n), "build"), { recursive: true });
  const target = path.join(releases, job(0), "build", "é.js");
  writeFileSync(target, "setInterval(() => {}, 1000);");
  const binary = path.join(base, "binary.plist");
  writePlist(binary, target, "binary");
  const utf16 = path.join(base, "utf16.plist");
  writePlist(utf16, path.join(releases, job(1), "build", "ü.js"), "utf16-xml");

  // The byte search alone, with parsing stubbed out, reads both UTF-16 encodings.
  expect(
    (await jobFoldersNamedInFiles(releases, [], [binary, utf16], async () => [])).sort(),
  ).toEqual([path.join(releases, job(0)), path.join(releases, job(1))]);

  // A property list that cannot be parsed skips the cleanup.
  await expect(
    jobFoldersNamedInFiles(releases, [], [binary], async () => {
      throw new Error("unparseable");
    }),
  ).rejects.toThrow("unparseable");

  // With the real parser: plutil on macOS; elsewhere parsing is refused, which is fail closed.
  const scan = jobFoldersNamedInFiles(releases, [], [binary, utf16]);
  if (process.platform !== "darwin") {
    await expect(scan).rejects.toThrow("cannot be parsed");
    return;
  }
  const referenced = await scan;
  expect(referenced.sort()).toEqual([path.join(releases, job(0)), path.join(releases, job(1))]);
  expect(
    await pruneHostReleases({
      releaseRoot: releases,
      referenced,
      keepNewest: 1,
      startedAt: new Map([0, 1, 2, 3].map((n) => [job(n), n])),
    }),
  ).toEqual([job(2)]);
  expect(readFileSync(target, "utf8")).toContain("setInterval");
});

// Root reads any file whatever its mode, so a mode-000 file is no test of a failed read.
test.skipIf(process.getuid?.() === 0)(
  "an unreadable reference file stops the cleanup instead of naming nothing",
  async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "host-unreadable-")));
    roots.push(base);
    const wrapper = path.join(base, "chrome-native-host");
    writeFileSync(wrapper, `exec "${base}/releases/00000000-0000-4000-8000-000000000001/x"`);
    chmodSync(wrapper, 0o000);
    try {
      await expect(
        jobFoldersNamedInFiles(path.join(base, "releases"), [], [wrapper]),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(wrapper, 0o600);
    }
  },
);

test("a process listing names a release its command line reaches through a link", async () => {
  // Nothing in the working directory or mapped files names the release; only argv does,
  // through the `current` link.
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "host-listing-")));
  roots.push(base);
  const releases = path.join(base, "releases");
  const release = path.join(releases, "00000000-0000-4000-8000-000000000001", "build-x");
  mkdirSync(release, { recursive: true });
  symlinkSync(release, path.join(base, "current"));
  expect(
    await pathsInListing(releases, {
      files: "p1\nfcwd\nn/\n",
      commands: `/usr/local/bin/node ${base}/current/main.js\n`,
    }),
  ).toEqual([path.join(release, "main.js")]);
});
