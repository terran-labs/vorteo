import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { IssueGateInputs } from "../gate-runtime.js";
import { createLeanStateStore } from "../state.js";
import { createLocalHostBatches } from "./host-batch-runtime.js";

const head = "a".repeat(40);
const configCommit = "b".repeat(40);
const primary = "primary/project";
const repository = "owner/repo";
const now = new Date("2026-11-27T20:00:00Z");
const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vorteo-host-batches-"));
  directories.push(directory);
  const state = createLeanStateStore(directory);
  const input: IssueGateInputs = {
    issue: 3,
    repository,
    head,
    configCommit,
    commands: [],
    hostedChecks: "passing",
    trusted: true,
    protectedPaths: [],
  };
  const recipe = {
    heavyGateBatches: {
      linux: {
        machine: "old-secondary/project",
        commands: [{ argv: ["npm", "test"], where: "container" }],
      },
      integration: { commands: [{ argv: ["npm", "run", "integration"], where: "container" }] },
    },
  };
  const readConfig = vi.fn<() => Promise<unknown>>(async () => recipe);
  const holdsPrimary = vi.fn(async () => true);
  const execute = vi.fn<Parameters<typeof createLocalHostBatches>[0]["execute"]>(
    async (target, command, authorizeLaunch) => {
      if (!(await authorizeLaunch())) return null;
      return {
        head: target.head,
        tree: "c".repeat(40),
        machine: primary,
        where: command.where,
        exitCode: 0,
        outputMatched: true,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
      };
    },
  );
  const runtime = () =>
    createLocalHostBatches({
      projectId: "project",
      repository,
      primary,
      now: () => now,
      state,
      readInputs: async () => input,
      readConfig,
      holdsPrimary,
      execute,
    });
  return { runtime, input, execute, readConfig, holdsPrimary };
}

it("runs all pinned heavy batches on the primary and reuses exact durable receipts", async () => {
  const f = fixture();
  expect(await f.runtime().readyForAcceptance(3, head)).toBe(true);
  expect(
    f.execute.mock.calls.map(([target, command]) => [target.head, target.primary, command.argv]),
  ).toEqual([
    [head, primary, ["npm", "test"]],
    [head, primary, ["npm", "run", "integration"]],
  ]);
  expect(await f.runtime().readyForAcceptance(3, head)).toBe(true);
  expect(await f.runtime().reconcileSecondary()).toBe(false);
  expect(f.execute).toHaveBeenCalledTimes(2);
});

it("fails closed if the commit, authority, recipe or trusted executor cannot be verified", async () => {
  const f = fixture();
  expect(await f.runtime().readyForAcceptance(3, "d".repeat(40))).toBe(false);
  f.holdsPrimary.mockResolvedValueOnce(false);
  expect(await f.runtime().readyForAcceptance(3, head)).toBe(false);
  f.readConfig.mockResolvedValueOnce({ heavyGateBatches: { invalid: { commands: [] } } });
  expect(await f.runtime().readyForAcceptance(3, head)).toBe(false);
  expect(f.execute).not.toHaveBeenCalled();
  f.execute.mockResolvedValueOnce(null);
  expect(await f.runtime().readyForAcceptance(3, head)).toBe(false);
  f.readConfig.mockResolvedValueOnce({});
  expect(await f.runtime().readyForAcceptance(3, head)).toBe(true);
});
