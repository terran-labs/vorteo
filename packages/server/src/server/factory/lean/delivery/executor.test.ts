import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FactoryConfigV1Schema, type ReleaseRecipeV1 } from "@getpaseo/server/factory-project";
import { createLeanStateStore } from "../state.js";
import {
  createDeliveryExecutor,
  type DeliveryExecutor,
  type DeliveryStepAdapter,
  type HostGateRecord,
  type LifecycleStatus,
  type OwnerApproval,
  type StepOutput,
} from "./executor.js";

const projectId = "mira";
const commit = "a".repeat(40);
const secret = "SECRET-TOKEN-do-not-store";
const fixture = FactoryConfigV1Schema.parse(
  JSON.parse(readFileSync(new URL("./mira-recipe.json", import.meta.url), "utf8")),
);
function recipeOf(config: typeof fixture): ReleaseRecipeV1 {
  if (!config.release) throw new Error("The Mira fixture has no release recipe.");
  return config.release;
}
const mira = recipeOf(fixture);
type StepName = "deployBeta" | "verifyBeta" | "promote" | "verifyStable" | "rollback";
type Behavior = "hang-before-launch" | "hang-after-launch" | "exit-1" | "ok";

function commandOf(recipe: ReleaseRecipeV1, name: StepName): string {
  const step: Record<string, unknown> = recipe.steps[name];
  return typeof step.run === "string" ? step.run : "";
}

function stepNameOf(command: string): StepName {
  const names: StepName[] = ["deployBeta", "verifyBeta", "promote", "verifyStable", "rollback"];
  return names.find((name) => commandOf(mira, name) === command) ?? "deployBeta";
}

interface Launch {
  step: StepName;
  command: string;
  env: Record<string, string>;
}

interface HarnessState {
  home: string;
  recipe: ReleaseRecipeV1;
  store: ReturnType<typeof createLeanStateStore>;
  now: Date;
  entered: StepName[];
  launches: Launch[];
  lifecycleRequests: number;
  lifecycleStatus: LifecycleStatus;
  betaCount: number;
  gate(sha: string): HostGateRecord | null;
}

async function harness(recipe: ReleaseRecipeV1 = mira) {
  const home = await mkdtemp(path.join(tmpdir(), "lean-delivery-"));
  const h: HarnessState = {
    home,
    recipe,
    store: createLeanStateStore(home),
    now: new Date("2026-11-27T20:00:00Z"),
    entered: [],
    launches: [],
    lifecycleRequests: 0,
    lifecycleStatus: { kind: "pending" },
    betaCount: 0,
    gate: (sha) => ({
      commit: sha,
      trust: { passed: true, sha },
      verdict: { passed: true, sha },
      ownerOnly: { passed: true, sha },
    }),
  };

  function output(step: StepName, env: Record<string, string>): StepOutput {
    if (step === "verifyBeta") {
      h.betaCount++;
      const report = {
        version: `v26.11.27${String(h.betaCount).padStart(2, "0")}`,
        commit: env.VORTEO_RELEASE_COMMIT,
        artifact: `frozen-${h.betaCount}`,
      };
      return { exitCode: 0, stdout: `${secret}\n${JSON.stringify(report)}\n` };
    }
    if (step === "verifyStable") {
      const report = {
        version: env.VORTEO_RELEASE_TARGET_VERSION ?? env.VORTEO_RELEASE_VERSION,
        commit: null,
        artifact: env.VORTEO_RELEASE_ARTIFACT,
      };
      return { exitCode: 0, stdout: JSON.stringify(report) };
    }
    return { exitCode: 0, stdout: `deployed with ${secret}` };
  }

  function adapter(behave: Partial<Record<StepName, Behavior>> = {}): DeliveryStepAdapter {
    return {
      async run(input) {
        const step = stepNameOf(input.command);
        const behavior = behave[step] ?? "ok";
        h.entered.push(step);
        if (behavior === "hang-before-launch") return new Promise(() => undefined);
        if (!(await input.authorizeLaunch())) return null;
        h.launches.push({ step, command: input.command, env: input.env });
        if (behavior === "hang-after-launch") return new Promise(() => undefined);
        if (behavior === "exit-1") return { exitCode: 1, stdout: "failed" };
        return output(step, input.env);
      },
    };
  }

  function executor(behave: Partial<Record<StepName, Behavior>> = {}): DeliveryExecutor {
    const steps = adapter(behave);
    return createDeliveryExecutor({
      projectId,
      installation: "srv/mira",
      state: h.store,
      adapters: { host: steps, container: steps },
      lifecycle: {
        async request() {
          h.lifecycleRequests++;
          return "request-1";
        },
        async status() {
          return h.lifecycleStatus;
        },
      },
      recipeAt: async () => ({ recipe: h.recipe, error: null }),
      hostGate: async (sha) => h.gate(sha),
      fence: async () => 1,
      notify: async () => undefined,
      logDir: path.join(home, "delivery-logs"),
      stepTimeoutMs: 60_000,
      now: () => h.now,
    });
  }

  function count(step: StepName): number {
    return h.launches.filter((launch) => launch.step === step).length;
  }

  function pastNotice(): void {
    h.now = new Date(h.now.getTime() + 11 * 60_000);
  }

  return { h, executor, count, pastNotice };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function approval(eventId: string, version: string): OwnerApproval {
  return {
    actionId: `owner-${eventId}`,
    eventId,
    version,
    words: "Ship it",
    at: "now",
  };
}

async function only(executor: DeliveryExecutor) {
  const run = (await executor.list()).at(-1);
  if (!run) throw new Error("No delivery run was queued.");
  return run;
}

async function latestRelease(t: Harness) {
  const event = (await t.h.store.read(projectId)).releases.at(-1);
  if (!event) throw new Error("No release was recorded.");
  return event;
}

async function shipBeta(t: Harness, executor: DeliveryExecutor): Promise<void> {
  await executor.queueBeta({
    commit,
    number: "70",
    note: "batch",
    contents: [],
  });
  await executor.advance();
  t.pastNotice();
  await executor.advance();
}

async function deliverBeta(t: Harness, executor: DeliveryExecutor) {
  await shipBeta(t, executor);
  return latestRelease(t);
}

async function deliverProduction(t: Harness, executor: DeliveryExecutor) {
  const beta = await deliverBeta(t, executor);
  const production = (await t.h.store.read(projectId)).releases.filter((e) => e.kind !== "beta");
  await executor.queuePromote({
    eventId: beta.id,
    expectedProduction: production.at(-1)?.id ?? null,
    approval: approval(beta.id, beta.version),
    number: "70",
    note: "batch",
  });
  await executor.advance();
  return latestRelease(t);
}

function seen(t: Harness, list: "entered" | "launches"): StepName[] {
  return list === "entered" ? t.h.entered : t.h.launches.map((launch) => launch.step);
}

interface RestartCase {
  name: string;
  lifecycle?: boolean;
  first: Partial<Record<StepName, Behavior>>;
  /** What the first daemon is doing when it dies; null runs the first pass to completion. */
  waitFor: { step: StepName; list: "entered" | "launches" } | null;
  afterRestart?: (executor: DeliveryExecutor, t: Harness, runId: string) => Promise<void>;
  expected: {
    state: string;
    failure?: string;
    deployBeta: number;
    verifyBeta: number;
  };
}

const restartCases: RestartCase[] = [
  {
    name: "pending in the notice window",
    first: {},
    waitFor: null,
    expected: { state: "delivered", deployBeta: 1, verifyBeta: 1 },
  },
  {
    name: "running before the deploy launched",
    first: { deployBeta: "hang-before-launch" },
    waitFor: { step: "deployBeta", list: "entered" },
    expected: { state: "delivered", deployBeta: 1, verifyBeta: 1 },
  },
  {
    name: "running with the deploy launched: never deployed twice",
    first: { deployBeta: "hang-after-launch" },
    waitFor: { step: "deployBeta", list: "launches" },
    expected: {
      state: "failed",
      failure: "unknown",
      deployBeta: 1,
      verifyBeta: 0,
    },
  },
  {
    name: "running with the deploy launched, then the owner verifies only",
    first: { deployBeta: "hang-after-launch" },
    waitFor: { step: "deployBeta", list: "launches" },
    async afterRestart(executor, _t, runId) {
      await executor.advance();
      await executor.resolve(runId, {
        action: "verify-only",
        ownerAction: "owner-1",
      });
      await executor.advance();
    },
    expected: { state: "delivered", deployBeta: 1, verifyBeta: 1 },
  },
  {
    name: "awaiting a lifecycle approval",
    lifecycle: true,
    first: {},
    waitFor: null,
    async afterRestart(executor, t) {
      await executor.advance();
      expect((await only(executor)).state).toBe("awaiting-approval");
      t.h.lifecycleStatus = { kind: "completed" };
      await executor.advance();
    },
    expected: { state: "delivered", deployBeta: 0, verifyBeta: 1 },
  },
  {
    name: "verifying before the verify launched",
    first: { verifyBeta: "hang-before-launch" },
    waitFor: { step: "verifyBeta", list: "entered" },
    expected: { state: "delivered", deployBeta: 1, verifyBeta: 1 },
  },
  {
    name: "verifying with the verify launched, then the owner reruns it",
    first: { verifyBeta: "hang-after-launch" },
    waitFor: { step: "verifyBeta", list: "launches" },
    async afterRestart(executor, _t, runId) {
      await executor.resolve(runId, {
        action: "rerun",
        ownerAction: "owner-1",
      });
      await executor.advance();
    },
    expected: { state: "delivered", deployBeta: 1, verifyBeta: 2 },
  },
  {
    name: "delivered",
    first: {},
    waitFor: null,
    expected: { state: "delivered", deployBeta: 1, verifyBeta: 1 },
  },
  {
    name: "failed",
    first: { deployBeta: "exit-1" },
    waitFor: null,
    expected: {
      state: "failed",
      failure: "step-failed",
      deployBeta: 1,
      verifyBeta: 0,
    },
  },
];

describe("delivery executor", () => {
  it.each(restartCases)("resumes after a restart: $name", async (c) => {
    const lifecycleRecipe: ReleaseRecipeV1 = {
      ...mira,
      steps: { ...mira.steps, deployBeta: { lifecycle: "host-source-update" } },
    };
    const t = await harness(c.lifecycle ? lifecycleRecipe : mira);
    const first = t.executor(c.first);
    const queued = await first.queueBeta({
      commit,
      number: "70",
      note: "n",
      contents: [],
    });
    if (!("runId" in queued)) throw new Error(queued.refused);
    await first.advance();
    const noticeOnly = c.name.startsWith("pending");
    if (!noticeOnly) t.pastNotice();
    if (c.waitFor && !noticeOnly) {
      const { step, list } = c.waitFor;
      void first.advance();
      await vi.waitFor(() => expect(seen(t, list)).toContain(step));
    } else if (!noticeOnly) {
      await first.advance();
    }

    const second = t.executor();
    await second.resume();
    await second.advance();
    if (noticeOnly) {
      expect((await only(second)).state).toBe("pending");
      expect(t.h.launches).toEqual([]);
      t.pastNotice();
      await second.advance();
    }
    await c.afterRestart?.(second, t, queued.runId);
    await second.advance();

    const run = await only(second);
    expect(`${run.state}: ${run.failure?.reason}`).toMatch(new RegExp(`^${c.expected.state}`));
    expect(run.failure?.kind).toBe(c.expected.failure);
    expect(t.count("deployBeta")).toBe(c.expected.deployBeta);
    expect(t.count("verifyBeta")).toBe(c.expected.verifyBeta);
    expect(t.h.lifecycleRequests).toBe(c.lifecycle ? 1 : 0);
  });

  it.each([
    { name: "no owner approval", approve: () => null, refused: true },
    {
      name: "approval of another version",
      approve: (id: string) => approval(id, "v0"),
      refused: true,
    },
    {
      name: "approval of another release",
      approve: (_id: string, version: string) => approval("other", version),
      refused: true,
    },
    { name: "approval of that exact beta", approve: approval, refused: false },
  ])("promote with $name", async ({ approve, refused }) => {
    const t = await harness();
    const executor = t.executor();
    const beta = await deliverBeta(t, executor);
    const result = await executor.queuePromote({
      eventId: beta.id,
      expectedProduction: null,
      approval: approve(beta.id, beta.version),
      number: "70",
      note: "n",
    });
    await executor.advance();
    expect("refused" in result).toBe(refused);
    expect(t.count("promote")).toBe(refused ? 0 : 1);
    if (!refused) {
      const promote = t.h.launches.find((launch) => launch.step === "promote");
      expect(promote?.env.VORTEO_RELEASE_APPROVAL).toBe("Ship it");
      expect(promote?.env.VORTEO_RELEASE_ARTIFACT).toBe(beta.artifact);
      expect((await only(executor)).state).toBe("delivered");
    }
  });

  it.each([
    { name: "no merge gate record", gate: () => null },
    {
      name: "a verdict for another commit",
      gate: (sha: string) => ({
        commit: sha,
        trust: { passed: true, sha },
        verdict: { passed: true, sha: "b".repeat(40) },
        ownerOnly: { passed: true, sha },
      }),
    },
    {
      name: "an owner-only file change",
      gate: (sha: string) => ({
        commit: sha,
        trust: { passed: true, sha },
        verdict: { passed: true, sha },
        ownerOnly: { passed: false, sha },
      }),
    },
  ])("refuses a Host step with $name", async ({ gate }) => {
    const t = await harness();
    t.h.gate = gate;
    const executor = t.executor();
    await shipBeta(t, executor);
    const run = await only(executor);
    expect(run.state).toBe("failed");
    expect(run.failure?.kind).toBe("refused");
    expect(t.h.launches).toEqual([]);
  });

  it("passes hostile values only through the environment and keeps output out of the ledger", async () => {
    const t = await harness();
    const executor = t.executor();
    const number = `1"; touch /tmp/pwned; echo "`;
    const note = "$(rm -rf ~) `id` ${HOME}";
    await executor.queueBeta({ commit, number, note, contents: [] });
    await executor.advance();
    t.pastNotice();
    await executor.advance();

    const deploy = t.h.launches.find((launch) => launch.step === "deployBeta");
    expect(deploy?.command).toBe(commandOf(mira, "deployBeta"));
    expect(deploy?.env.VORTEO_RELEASE_NUMBER).toBe(number);
    expect(deploy?.env.VORTEO_RELEASE_NOTE).toBe(note);
    expect((await only(executor)).state).toBe("delivered");

    const ledger = await readFile(
      path.join(t.h.home, "factory", "lean", `${projectId}.json`),
      "utf8",
    );
    expect(ledger).not.toContain(secret);
    const logs = await readdir(path.join(t.h.home, "delivery-logs"));
    const log = await readFile(path.join(t.h.home, "delivery-logs", logs[0]), "utf8");
    expect(log).toContain(secret);

    const placeholder: ReleaseRecipeV1 = {
      ...mira,
      steps: { ...mira.steps, deployBeta: { run: "tools/ship.sh {version}" } },
    };
    const legacy = await harness(placeholder);
    await shipBeta(legacy, legacy.executor());
    expect(legacy.h.launches).toEqual([]);
  });

  it("lets the owner's rollback cancel a pending beta and wait behind a running one", async () => {
    const t = await harness();
    const executor = t.executor({});
    const earlier = await deliverProduction(t, executor);
    const current = await deliverProduction(t, executor);
    const rollback = {
      targetEventId: earlier.id,
      expectedProduction: current.id,
      approval: approval(earlier.id, earlier.version),
      target: "release-69",
    };

    const pending = await executor.queueBeta({
      commit,
      number: "72",
      note: "n",
      contents: [],
    });
    const cancelling = await executor.queueRollback(rollback);
    expect(cancelling).toMatchObject({
      cancelled: ["runId" in pending ? pending.runId : ""],
    });
    await executor.advance();
    expect((await only(executor)).state).toBe("delivered");

    const hanging = t.executor({ deployBeta: "hang-after-launch" });
    const beta = await hanging.queueBeta({
      commit,
      number: "73",
      note: "n",
      contents: [],
    });
    await hanging.advance();
    t.pastNotice();
    void hanging.advance();
    await vi.waitFor(() => expect(t.count("deployBeta")).toBe(3));
    const latest = await latestRelease(t);
    const behind = await hanging.queueRollback({
      ...rollback,
      targetEventId: current.id,
      expectedProduction: latest.id,
      approval: approval(current.id, current.version),
    });
    expect(behind).toMatchObject({ behind: "runId" in beta ? beta.runId : "" });
    expect(t.count("rollback")).toBe(1);
  });
});
