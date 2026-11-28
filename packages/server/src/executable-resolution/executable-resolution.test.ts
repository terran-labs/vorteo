import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  describeExecutableSearch,
  executableExists,
  fallbackExecutableDirs,
  findExecutable,
} from "./executable-resolution.js";
import { windowsExecutableResolution } from "./windows.js";
import { isPlatform } from "../test-utils/platform.js";

const originalEnv = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
};
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-executable-test-"));
  tempDirs.push(dir);
  return dir;
}

function prependPath(...dirs: string[]): void {
  process.env.PATH = [...dirs, originalEnv.PATH].filter(Boolean).join(path.delimiter);
}

function writeExecutable(filePath: string, content: string): string {
  writeFileSync(filePath, content);
  if (!isPlatform("win32")) {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

function writeBrokenAbsoluteFixture(dir: string): string {
  const filePath = isPlatform("win32") ? path.join(dir, "broken.exe") : path.join(dir, "broken");
  writeFileSync(filePath, "not executable");
  if (!isPlatform("win32")) {
    chmodSync(filePath, 0o644);
  }
  return filePath;
}

function expectWindowsPathsEqual(actual: string | null, expected: string): void {
  expect(actual?.toLowerCase()).toBe(expected.toLowerCase());
}

afterEach(() => {
  process.env.PATH = originalEnv.PATH;
  process.env.PATHEXT = originalEnv.PATHEXT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("findExecutable", () => {
  test.runIf(isPlatform("linux"))(
    "propagates a failed lookup process instead of reporting a missing executable",
    async () => {
      await expect(findExecutable("x".repeat(1024 * 1024))).rejects.toMatchObject({
        code: "E2BIG",
      });
    },
  );

  describe.skipIf(isPlatform("win32"))("POSIX", () => {
    test("finds an extensionless executable and skips an earlier non-executable candidate", async () => {
      const executableDir = makeTempDir();
      const nonExecutableDir = makeTempDir();
      const executable = writeExecutable(path.join(executableDir, "foo"), "#!/bin/sh\necho 0.1\n");
      const nonExecutable = path.join(nonExecutableDir, "foo");
      writeFileSync(nonExecutable, "#!/bin/sh\necho broken\n");
      chmodSync(nonExecutable, 0o644);
      prependPath(nonExecutableDir, executableDir);

      await expect(findExecutable("foo")).resolves.toBe(executable);
    });

    test("finds a CLI installed only in ~/.local/bin when opt-in fallback is enabled and leaves default PATH lookup unchanged", async () => {
      const fakeHome = makeTempDir();
      const localBin = path.join(fakeHome, ".local", "bin");
      mkdirSync(localBin, { recursive: true });
      const cli = writeExecutable(path.join(localBin, "agy-test-cli"), "#!/bin/sh\necho 1.5.18\n");
      const emptyPathDir = makeTempDir();

      await expect(
        findExecutable("agy-test-cli", { env: { PATH: emptyPathDir, HOME: fakeHome } }),
      ).resolves.toBeNull();
      await expect(
        findExecutable("agy-test-cli", {
          env: { PATH: emptyPathDir, HOME: fakeHome },
          includeFallbackDirs: true,
        }),
      ).resolves.toBe(realpathSync(cli));
    });

    test("prefers a PATH executable over a ~/.local/bin fallback", async () => {
      const fakeHome = makeTempDir();
      const localBin = path.join(fakeHome, ".local", "bin");
      mkdirSync(localBin, { recursive: true });
      writeExecutable(path.join(localBin, "agy-pref-cli"), "#!/bin/sh\necho fallback\n");
      const pathDir = makeTempDir();
      const onPath = writeExecutable(path.join(pathDir, "agy-pref-cli"), "#!/bin/sh\necho path\n");

      await expect(
        findExecutable("agy-pref-cli", {
          env: { PATH: pathDir, HOME: fakeHome },
          includeFallbackDirs: true,
        }),
      ).resolves.toBe(onPath);
    });

    test("ignores relative HOME values, dot segments, and non-executable fallback entries", async () => {
      const fakeHome = makeTempDir();
      const localBin = path.join(fakeHome, ".local", "bin");
      mkdirSync(path.join(localBin, "dir-cli"), { recursive: true });
      const nonExec = path.join(localBin, "nonexec-cli");
      writeFileSync(nonExec, "#!/bin/sh\necho nope\n");
      chmodSync(nonExec, 0o644);
      const emptyPathDir = makeTempDir();

      expect(fallbackExecutableDirs({ HOME: "relative/home", PATH: emptyPathDir })).not.toContain(
        path.join("relative/home", ".local/bin"),
      );
      await expect(
        findExecutable("dir-cli", {
          env: { PATH: emptyPathDir, HOME: fakeHome },
          includeFallbackDirs: true,
        }),
      ).resolves.toBeNull();
      await expect(
        findExecutable("nonexec-cli", {
          env: { PATH: emptyPathDir, HOME: fakeHome },
          includeFallbackDirs: true,
        }),
      ).resolves.toBeNull();
      await expect(
        findExecutable(".", { env: { PATH: emptyPathDir }, includeFallbackDirs: true }),
      ).resolves.toBeNull();
      await expect(
        findExecutable("..", { env: { PATH: emptyPathDir }, includeFallbackDirs: true }),
      ).resolves.toBeNull();
    });

    test("refuses group-writable or world-writable fallback directories, ancestors, symlinks, and binaries", async () => {
      const fakeHome = makeTempDir();
      const localDir = path.join(fakeHome, ".local");
      const localBin = path.join(localDir, "bin");
      mkdirSync(localBin, { recursive: true });
      chmodSync(localDir, 0o755);
      chmodSync(localBin, 0o755);
      const emptyPathDir = makeTempDir();
      const opts = { env: { PATH: emptyPathDir, HOME: fakeHome }, includeFallbackDirs: true };

      const worldWritableBin = writeExecutable(
        path.join(localBin, "ww-bin-cli"),
        "#!/bin/sh\necho 1.0\n",
      );
      chmodSync(worldWritableBin, 0o777);
      await expect(findExecutable("ww-bin-cli", opts)).resolves.toBeNull();

      const groupWritableBin = writeExecutable(
        path.join(localBin, "gw-bin-cli"),
        "#!/bin/sh\necho 1.0\n",
      );
      chmodSync(groupWritableBin, 0o775);
      await expect(findExecutable("gw-bin-cli", opts)).resolves.toBeNull();

      const okBin = writeExecutable(path.join(localBin, "ok-cli"), "#!/bin/sh\necho 1.0\n");
      chmodSync(okBin, 0o755);

      const targetRoot = makeTempDir();
      const targetSub = path.join(targetRoot, "sub");
      mkdirSync(targetSub, { recursive: true });
      chmodSync(targetSub, 0o755);
      const targetBin = writeExecutable(path.join(targetSub, "real-cli"), "#!/bin/sh\necho 1.0\n");
      chmodSync(targetBin, 0o755);
      const intermediateLink = path.join(targetRoot, "mid-link");
      symlinkSync(targetBin, intermediateLink);
      const symlinkBin = path.join(localBin, "sym-cli");
      symlinkSync(intermediateLink, symlinkBin);

      await expect(findExecutable("sym-cli", opts)).resolves.toBe(realpathSync(targetBin));

      // A symlink target with a trailing slash requires a directory in POSIX; pointing at a file
      // (directly or via another symlink) must be rejected.
      symlinkSync(`${targetBin}/`, path.join(localBin, "trailing-slash-file-cli"));
      await expect(findExecutable("trailing-slash-file-cli", opts)).resolves.toBeNull();
      symlinkSync(`${intermediateLink}/`, path.join(localBin, "trailing-slash-link-cli"));
      await expect(findExecutable("trailing-slash-link-cli", opts)).resolves.toBeNull();

      // Symlink containing `..` after a directory symlink must follow POSIX semantics, not lexical
      // collapse (so `dir-link/../tricky-bin` resolves inside `outside`, not `localBin`).
      const outsideRoot = makeTempDir();
      const outsideSub = path.join(outsideRoot, "sub");
      mkdirSync(outsideSub, { recursive: true });
      chmodSync(outsideRoot, 0o755);
      chmodSync(outsideSub, 0o755);
      const localDecoy = writeExecutable(
        path.join(localBin, "tricky-target"),
        "#!/bin/sh\necho local\n",
      );
      chmodSync(localDecoy, 0o755);
      const outsideTarget = writeExecutable(
        path.join(outsideRoot, "tricky-target"),
        "#!/bin/sh\necho outside\n",
      );
      chmodSync(outsideTarget, 0o775);
      symlinkSync(outsideSub, path.join(localBin, "dir-link"));
      symlinkSync("dir-link/../tricky-target", path.join(localBin, "tricky-cli"));

      await expect(findExecutable("tricky-cli", opts)).resolves.toBeNull();

      chmodSync(outsideTarget, 0o755);
      await expect(findExecutable("tricky-cli", opts)).resolves.toBe(realpathSync(outsideTarget));

      // Embedded `..` in HOME must not be lexically folded before symlink expansion.
      const homeWithDotDot = `${localBin}/dir-link/..`;
      expect(fallbackExecutableDirs({ HOME: homeWithDotDot, PATH: emptyPathDir })[0]).toBe(
        `${homeWithDotDot}/.local/bin`,
      );
      const outsideLocalBin = path.join(outsideRoot, ".local", "bin");
      mkdirSync(outsideLocalBin, { recursive: true });
      chmodSync(path.join(outsideRoot, ".local"), 0o755);
      chmodSync(outsideLocalBin, 0o755);
      const outsideHomeCli = writeExecutable(
        path.join(outsideLocalBin, "home-dotdot-cli"),
        "#!/bin/sh\necho outside-home\n",
      );
      chmodSync(outsideHomeCli, 0o775);
      await expect(
        findExecutable("home-dotdot-cli", {
          env: { PATH: emptyPathDir, HOME: homeWithDotDot },
          includeFallbackDirs: true,
        }),
      ).resolves.toBeNull();
      chmodSync(outsideHomeCli, 0o755);
      await expect(
        findExecutable("home-dotdot-cli", {
          env: { PATH: emptyPathDir, HOME: homeWithDotDot },
          includeFallbackDirs: true,
        }),
      ).resolves.toBe(realpathSync(outsideHomeCli));

      // Group-writable ancestor on symlink target rejects symlinked fallback executable.
      chmodSync(targetSub, 0o775);
      await expect(findExecutable("sym-cli", opts)).resolves.toBeNull();
      chmodSync(targetSub, 0o755);

      // World-writable symlink target is rejected.
      chmodSync(targetBin, 0o777);
      await expect(findExecutable("sym-cli", opts)).resolves.toBeNull();

      // Group-writable ancestor (~/.local) rejects binaries inside ~/.local/bin.
      chmodSync(localDir, 0o775);
      await expect(findExecutable("ok-cli", opts)).resolves.toBeNull();
      chmodSync(localDir, 0o755);

      // Group-writable or world-writable fallback directory itself is rejected.
      chmodSync(localBin, 0o775);
      await expect(findExecutable("ok-cli", opts)).resolves.toBeNull();
      chmodSync(localBin, 0o777);
      await expect(findExecutable("ok-cli", opts)).resolves.toBeNull();
    });

    test("omits searched PATH directories when describing an explicit missing binary path", () => {
      const explicitMessage = describeExecutableSearch("/opt/missing/agy", {
        env: { PATH: "/usr/bin" },
        providerId: "antigravity",
        includeFallbackDirs: true,
      });
      expect(explicitMessage).toContain('Could not find executable "/opt/missing/agy"');
      expect(explicitMessage).not.toContain("searched:");
      expect(explicitMessage).toContain("agents.providers.antigravity.command");

      const bareMessage = describeExecutableSearch("agy", {
        env: { PATH: "/usr/bin" },
        providerId: "antigravity",
        includeFallbackDirs: true,
      });
      expect(bareMessage).toContain('Could not find "agy" (searched: /usr/bin');
    });
  });

  describe.runIf(isPlatform("win32"))("Windows", () => {
    test("returns a working .cmd when an invalid .exe candidate appears first", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = [".EXE", ".CMD"].join(path.delimiter);
      const brokenExe = path.join(dir, "foo.exe");
      const cmd = writeExecutable(path.join(dir, "foo.cmd"), "@echo off\r\necho 0.1\r\n");
      writeFileSync(brokenExe, "");
      prependPath(dir);

      expectWindowsPathsEqual(await findExecutable("foo"), cmd);
    });

    test("returns null when the only candidate is a broken .exe", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = ".EXE";
      writeFileSync(path.join(dir, "foo.exe"), "");
      prependPath(dir);

      await expect(findExecutable("foo")).resolves.toBeNull();
    });

    test("returns a .cmd when it is the only candidate", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = ".CMD";
      const cmd = writeExecutable(path.join(dir, "foo.cmd"), "@echo off\r\necho 0.1\r\n");
      prependPath(dir);

      expectWindowsPathsEqual(await findExecutable("foo"), cmd);
    });

    test("finds a .cmd for an extensionless absolute path", async () => {
      const dir = makeTempDir();
      const command = path.join(dir, "codex");
      const cmd = writeExecutable(`${command}.cmd`, "@echo off\r\necho 0.1\r\n");

      expectWindowsPathsEqual(await findExecutable(command), cmd);
    });

    test("does not probe fabricated absolute path extensions that do not exist", async () => {
      const dir = makeTempDir();
      const command = path.join(dir, "missing-command");

      await expect(findExecutable(command)).resolves.toBeNull();
    });

    test("finds a winget portable executable outside PATH", async () => {
      const originalLocalAppData = process.env.LOCALAPPDATA;
      const localAppData = makeTempDir();
      const packageDir = path.join(
        localAppData,
        "Microsoft",
        "WinGet",
        "Packages",
        "Anthropic.ClaudeCode_abc",
      );
      mkdirSync(packageDir, { recursive: true });
      const claude = path.join(packageDir, "claude.exe");
      copyFileSync(process.execPath, claude);
      process.env.LOCALAPPDATA = localAppData;
      process.env.PATH = makeTempDir();
      try {
        expectWindowsPathsEqual(await findExecutable("claude"), claude);
      } finally {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    });
  });

  test("returns an invokable absolute path", async () => {
    await expect(findExecutable(process.execPath)).resolves.toBe(process.execPath);
  });

  test("returns null for an absolute path that cannot spawn", async () => {
    const dir = makeTempDir();
    const fixture = writeBrokenAbsoluteFixture(dir);

    await expect(findExecutable(fixture)).resolves.toBeNull();
  });

  test("returns null when the command is not on PATH", async () => {
    const dir = makeTempDir();
    prependPath(dir);

    await expect(findExecutable("paseo-definitely-missing-command")).resolves.toBeNull();
  });

  test("Windows resolution skips literal path candidates that do not exist", async () => {
    const probeExecutable = vi.fn(async () => true);

    await expect(
      windowsExecutableResolution.find("C:\\tools\\missing-command", {
        enumeratePathCandidates: async () => [],
        probeExecutable,
        exists: () => false,
        probeTimeoutMs: 100,
      }),
    ).resolves.toBeNull();
    expect(probeExecutable).not.toHaveBeenCalled();
  });
});

describe("executableExists", () => {
  test("returns the path when it already exists", () => {
    const exists = (candidate: string) => candidate === "/usr/local/bin/codex";

    expect(executableExists("/usr/local/bin/codex", exists)).toBe("/usr/local/bin/codex");
  });

  test("on Windows, falls back to .exe, then .cmd for extensionless paths", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    try {
      const exists = (candidate: string) => candidate === "C:\\tools\\codex.cmd";

      expect(executableExists("C:\\tools\\codex", exists)).toBe("C:\\tools\\codex.cmd");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  test("on Windows, ignores PowerShell scripts for extensionless paths", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    try {
      const exists = (candidate: string) => candidate === "C:\\tools\\codex.ps1";

      expect(executableExists("C:\\tools\\codex", exists)).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  test("returns null when no matching path exists", () => {
    expect(executableExists("/missing/codex", () => false)).toBeNull();
  });
});
