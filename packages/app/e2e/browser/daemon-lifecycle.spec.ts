import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test as base, daemonTest as cleanupTest } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  openDaemonOverview,
  restartDaemonInSettings,
  expectDaemonRestartComplete,
  expectDaemonRestartFailed,
  plantUnclosableTerminalProgram,
  readWorkerPid,
  openLongLivedTerminal,
  listTerminalIds,
  suspendDaemonProcess,
  resumeDaemonProcess,
  daemonProcessCanWrite,
  readTerminalProcessIds,
} from "../support/helpers/daemon-lifecycle";

type LifecycleMode = "normal" | "terminal" | "unclosable" | "slow-provider";
interface LifecycleReady {
  daemon: Awaited<ReturnType<typeof startIsolatedHostDaemon>>;
  supervisor: number | undefined;
  previousWorker?: number;
  terminalId?: string;
  program?: Awaited<ReturnType<typeof plantUnclosableTerminalProgram>>;
}
interface LifecycleOwner {
  prepare: (mode: LifecycleMode) => Promise<LifecycleReady>;
}

const test = base.extend<{
  lifecycleMode: LifecycleMode;
  lifecycleOwner: LifecycleOwner;
  ready: LifecycleReady;
}>({
  lifecycleMode: ["normal", { option: true }],
  // No explicit timeout here: cleanup uses Playwright's fresh after-hooks slot,
  // rather than the prerequisite fixture's shared setup/teardown timeout slot.
  lifecycleOwner: async ({ page }, provide, testInfo) => {
    let daemon: LifecycleReady["daemon"] | undefined;
    let program: LifecycleReady["program"];
    let slowHome: string | undefined;
    let closing = false;
    let setupSettled = false;
    let pendingSetup: Promise<LifecycleReady> | undefined;
    const assertOpen = () => {
      if (closing) throw new Error("Lifecycle fixture is closing; setup cannot continue");
    };
    const failures: unknown[] = [];
    try {
      await provide({
        prepare: (mode) => {
          assertOpen();
          if (pendingSetup) throw new Error("Lifecycle setup may only run once");
          // Retain the entire acquisition chain before its first await resumes.
          // A timeout does not cancel JavaScript or the underlying helpers.
          pendingSetup = (async () => {
            if (mode === "slow-provider") {
              await createHomeWithSlowProvider(
                1_800,
                (home) => {
                  slowHome = home;
                  assertOpen();
                },
                assertOpen,
              );
              assertOpen();
            }
            daemon = await startIsolatedHostDaemon(
              randomUUID(),
              slowHome ? { paseoHome: slowHome } : undefined,
            );
            assertOpen();
            const supervisor = daemon.getPid();
            let previousWorker: number | undefined;
            let terminalId: string | undefined;
            if (mode === "unclosable") {
              program = await plantUnclosableTerminalProgram(daemon);
              if (closing) program.release();
              assertOpen();
            } else {
              if (mode === "terminal") {
                terminalId = await openLongLivedTerminal(daemon);
                assertOpen();
              }
              previousWorker = await readWorkerPid(daemon);
              assertOpen();
            }
            await openDaemonOverview(page, daemon);
            assertOpen();
            return { daemon, supervisor, previousWorker, terminalId, program };
          })().finally(() => {
            setupSettled = true;
          });
          return pendingSetup;
        },
      });
    } catch (error) {
      failures.push(error);
    } finally {
      closing = true;
      // Interrupt pending browser operations before joining timed-out setup.
      // Normal completion keeps the page alive through daemon shutdown.
      if (!setupSettled || testInfo.status === "timedOut") {
        try {
          await page.close();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await pendingSetup;
      } catch (error) {
        failures.push(error);
      }
      try {
        program?.release();
      } catch (error) {
        failures.push(error);
      }
      try {
        if (daemon) await daemon.close();
        else if (slowHome) await rm(slowHome, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      // A helper that outlives the teardown budget is a failure, never a
      // successfully abandoned cleanup. Preserve all settled cleanup failures.
    }
    if (failures.length) throw new AggregateError(failures, "Lifecycle fixture cleanup failed");
  },
  ready: [
    async ({ lifecycleOwner, lifecycleMode }, provide) => {
      test.skip(
        process.platform === "win32" && lifecycleMode === "unclosable",
        "The unclosable program is a POSIX zombie",
      );
      test.skip(
        process.platform === "win32" && lifecycleMode === "slow-provider",
        "The slow provider stub is a POSIX script",
      );
      await provide(await lifecycleOwner.prepare(lifecycleMode));
    },
    { timeout: 120_000 },
  ],
});
const terminalTest = test.extend({ lifecycleMode: "terminal" });
const unclosableTest = test.extend({ lifecycleMode: "unclosable" });
const slowProviderTest = test.extend({ lifecycleMode: "slow-provider" });

test("settings restart waits for a replacement worker while retaining the supervisor", async ({
  page,
  ready: { daemon, supervisor, previousWorker },
}, testInfo) => {
  await restartDaemonInSettings(page);
  await expectDaemonRestartComplete(page);
  expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
  expect(daemon.getPid()).toBe(supervisor);
  await page.screenshot({ path: testInfo.outputPath("restart-confirmed.png"), fullPage: true });
});

terminalTest(
  "settings restart keeps a terminal",
  async ({ page, ready: { daemon, previousWorker, terminalId } }) => {
    await restartDaemonInSettings(page);
    await expectDaemonRestartComplete(page);
    expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
    expect(await listTerminalIds(daemon)).toContain(terminalId);
  },
);

terminalTest(
  "settings restart and close terminals closes the terminal",
  async ({ page, ready: { daemon, previousWorker } }) => {
    await restartDaemonInSettings(page, { closeTerminals: true });
    await expectDaemonRestartComplete(page);
    expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
    expect(await listTerminalIds(daemon)).toEqual([]);
  },
);

unclosableTest(
  "settings restart and close terminals shows the processes it could not close",
  async ({ page, ready: { program } }, testInfo) => {
    if (!program) throw new Error("Unclosable fixture did not provide its planted program");
    try {
      await restartDaemonInSettings(page, { closeTerminals: true });
      await expectDaemonRestartFailed(page, `pid ${program.pid}`);
      await page.screenshot({
        path: testInfo.outputPath("restart-cleanup-failed.png"),
        fullPage: true,
      });
    } finally {
      program.release();
    }
  },
);

slowProviderTest(
  "settings restart replaces the worker when a provider CLI answers --version slowly",
  async ({ page, ready: { daemon, previousWorker } }) => {
    await restartDaemonInSettings(page);
    await expectDaemonRestartComplete(page);
    expect(await readWorkerPid(daemon)).not.toBe(previousWorker);
  },
);

async function createHomeWithSlowProvider(
  versionDelayMs: number,
  ownHome: (home: string) => void,
  assertOpen: () => void,
): Promise<string> {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-e2e-slow-provider-"));
  ownHome(paseoHome);
  const provider = path.join(paseoHome, "slow-provider");
  await writeFile(
    provider,
    `#!${process.execPath}\nsetTimeout(() => console.log("provider 1.0.0"), ${versionDelayMs});\n`,
    { mode: 0o700 },
  );
  assertOpen();
  await writeFile(
    path.join(paseoHome, "config.json"),
    `${JSON.stringify({
      version: 1,
      agents: { providers: { claude: { command: { mode: "replace", argv: [provider] } } } },
    })}\n`,
  );
  return paseoHome;
}

// Cleanup has no renderer demand: drive the same isolated daemon owner directly.
// A stopped worker deterministically outlives the old helper's five-second
// supervisor-only kill and logs into its deleted home when resumed.
cleanupTest(
  "isolated cleanup prevents a stopped worker from recreating its deleted home",
  async () => {
    cleanupTest.skip(process.platform === "win32", "POSIX stopped-process failure injection");
    const daemon = await startIsolatedHostDaemon(randomUUID());
    const workerPid = await readWorkerPid(daemon);
    try {
      suspendDaemonProcess(workerPid);
      await daemon.close();
      resumeDaemonProcess(workerPid);
      await expect.poll(() => daemonProcessCanWrite(workerPid)).toBe(false);
      expect(existsSync(daemon.paseoHome)).toBe(false);
    } finally {
      resumeDaemonProcess(workerPid);
      await daemon.close();
      await rm(daemon.paseoHome, { recursive: true, force: true });
    }
  },
);

cleanupTest(
  "isolated cleanup force-stops a frozen supervisor and its detached terminal writers",
  async () => {
    cleanupTest.skip(process.platform === "win32", "POSIX stopped-process failure injection");
    const daemon = await startIsolatedHostDaemon(randomUUID());
    const supervisorPid = daemon.getPid()!;
    const workerPid = await readWorkerPid(daemon);
    try {
      await openLongLivedTerminal(daemon);
      const terminalProcesses = await readTerminalProcessIds(daemon);
      expect(terminalProcesses.length).toBeGreaterThanOrEqual(2);
      suspendDaemonProcess(supervisorPid);
      await daemon.close();
      const writerStates = await Promise.all(
        [supervisorPid, workerPid, ...terminalProcesses].map(daemonProcessCanWrite),
      );
      expect(writerStates).toEqual(Array(terminalProcesses.length + 2).fill(false));
      expect(existsSync(daemon.paseoHome)).toBe(false);
    } finally {
      resumeDaemonProcess(supervisorPid);
      await daemon.close();
    }
  },
);
