import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FactoryConfigV1Schema, type ReleaseRecipeV1 } from "@getpaseo/server/factory-lean";
import { createLeanStateStore } from "../state.js";
import type { OwnerApproval } from "../types.js";
import {
  createContainerStepAdapter,
  createHostStepAdapter,
  createDeliveryCheckout,
  createGitRunner,
  createVerifiedCheckout,
  type GitRunner,
  type SpawnRequest,
} from "./adapters.js";
import {
  createDeliveryExecutor,
  type DeliveryExecutor,
  cancelUnstartedBetas,
  type BranchCommit,
  type DeliveryCheckoutPort,
  type DeliveryLedger,
  type DeliveryStepAdapter,
  type SideEffect,
  type DeliveryStepRequest,
  type HostGateRecord,
  type LifecycleStatus,
  type StepOutput,
} from "./executor.js";

const projectId = "mira";

function digestOf(artifact: string): string {
  return createHash("sha256").update(artifact).digest("hex");
}
const commit = "a".repeat(40);
const secret = "SECRET-TOKEN-do-not-store";
const fixture = FactoryConfigV1Schema.parse(
  JSON.parse(readFileSync(new URL("./mira-vorteo-factory.json", import.meta.url), "utf8")),
);
function recipeOf(config: typeof fixture): ReleaseRecipeV1 {
  if (!config.release) throw new Error("The Mira fixture has no release recipe.");
  return config.release;
}
const mira = recipeOf(fixture);
type StepName =
  | "releaseNumber"
  | "deployBeta"
  | "verifyBeta"
  | "promote"
  | "verifyStable"
  | "rollback"
  | "version"
  | "install"
  | "fingerprint"
  | `gate:${string}`;
type Behavior = "hang-before-launch" | "wait-before-launch" | "hang-after-launch" | "exit-1" | "ok";

function commandOf(recipe: ReleaseRecipeV1, name: (typeof STEP_NAMES)[number]): string {
  const step: unknown = recipe.steps[name];
  if (typeof step !== "object" || step === null || !("run" in step)) return "";
  return typeof step.run === "string" ? step.run : "";
}

const STEP_NAMES = [
  "fingerprint",
  "releaseNumber",
  "deployBeta",
  "verifyBeta",
  "promote",
  "verifyStable",
  "rollback",
] as const;

function stepNameOf(command: string): StepName {
  const step = STEP_NAMES.find((name) => commandOf(mira, name) === command);
  if (step) return step;
  if (command === mira.version?.run) return "version";
  if (command === "npm ci") return "install";
  const gates = [...mira.gates.beta, ...mira.gates.stable];
  const gate = gates.find((candidate) => candidate.run === command);
  return gate ? `gate:${gate.name}` : "deployBeta";
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
  branchHead: string;
  branchCommits: BranchCommit[] | null;
  tags: string[];
  prepared: string[];
  pushes: number;
  sideEffects: SideEffect[];
  vetoPush: boolean;
  /** Overrides what the fingerprint and stable verify steps report; null reports the truth. */
  fingerprintDigest: string | null;
  stableDigest: string | null;
  notifyFails: boolean;
  localTags: Record<string, string>;
  pushedTags: string[];
  refuseTags: boolean;
  releaseLaunch(): void;
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
    branchHead: commit,
    branchCommits: [],
    tags: [],
    prepared: [],
    pushes: 0,
    sideEffects: [],
    vetoPush: false,
    fingerprintDigest: null,
    stableDigest: null,
    notifyFails: false,
    localTags: { "release-135": "old-release", "v26.11.2606": "old-calver" },
    pushedTags: [],
    refuseTags: false,
    releaseLaunch: () => undefined,
    gate: (sha) => ({
      commit: sha,
      trust: { passed: true, sha },
      verdict: { passed: true, sha },
      ownerOnly: { passed: true, sha },
    }),
  };

  function output(step: StepName, env: Record<string, string>): StepOutput {
    if (step === "releaseNumber") return { exitCode: 0, stdout: '{"number":"136"}\n' };
    if (step === "fingerprint") {
      const artifact = env.VORTEO_RELEASE_ARTIFACT ?? "";
      const digest = h.fingerprintDigest ?? digestOf(artifact);
      return { exitCode: 0, stdout: `${JSON.stringify({ artifact, digest })}\n` };
    }
    if (step === "version") {
      return { exitCode: 0, stdout: `v26.11.27${String(h.betaCount + 1).padStart(2, "0")}\n` };
    }
    if (step === "verifyBeta") {
      h.betaCount++;
      const report = {
        version: `v26.11.27${String(h.betaCount).padStart(2, "0")}`,
        commit: env.VORTEO_RELEASE_COMMIT,
        artifact: `frozen-${h.betaCount}`,
        digest: digestOf(`frozen-${h.betaCount}`),
      };
      return { exitCode: 0, stdout: `${secret}\n${JSON.stringify(report)}\n` };
    }
    if (step === "verifyStable") {
      const report = {
        version: env.VORTEO_RELEASE_TARGET_VERSION ?? env.VORTEO_RELEASE_VERSION,
        commit: null,
        artifact: env.VORTEO_RELEASE_ARTIFACT,
        digest: h.stableDigest ?? digestOf(env.VORTEO_RELEASE_ARTIFACT ?? ""),
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
        if (behavior === "wait-before-launch") {
          await new Promise<void>((resolve) => {
            h.releaseLaunch = resolve;
          });
        }
        if (!(await input.authorizeLaunch())) return null;
        h.launches.push({ step, command: input.command, env: input.env });
        if (behavior === "hang-after-launch") return new Promise(() => undefined);
        if (behavior === "exit-1") return { exitCode: 1, stdout: "failed" };
        if (step === "promote") {
          h.localTags["release-136"] = "new-release";
          h.localTags["v26.11.2701"] = "new-calver";
          h.localTags["m-factory-v26.11.2701"] = "milestone";
        }
        const result = output(step, input.env);
        await mkdir(path.dirname(input.outputPath), { recursive: true });
        await writeFile(input.outputPath, result.stdout);
        return result;
      },
    };
  }

  function checkoutPort(where: "host" | "container"): DeliveryCheckoutPort {
    return {
      path: where === "host" ? "/Users/vtn/dev/Syn3h-factory" : "/home/paseo/dev/Syn3h-factory",
      links:
        where === "host" ? [{ name: "Syn3h-stable", target: "/Users/vtn/dev/Syn3h-stable" }] : [],
      async prepare(input) {
        h.prepared.push(`${where}:${input.commit}`);
        return { head: input.commit };
      },
      blob: async () => "blob-1",
      async tags(patterns) {
        const matches = (name: string) =>
          patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
        return Object.fromEntries(Object.entries(h.localTags).filter(([name]) => matches(name)));
      },
      async pushTags(request) {
        const tags = request.names.map((name) => ({ name, object: h.localTags[name] ?? "" }));
        if (!(await request.authorizePush(tags))) return { withheld: true };
        if (h.refuseTags) return { refused: "The origin refused the tags." };
        h.pushedTags.push(...request.names);
        return { pushed: tags };
      },
      async tag(name) {
        h.tags.push(name);
        return { tagged: true };
      },
      async commitRecords(request) {
        const built = { commit: "d".repeat(40), parent: request.expectedHead };
        if (!(await request.authorizePush({ ...built, expectedHead: request.expectedHead }))) {
          return { withheld: true };
        }
        h.pushes++;
        return { ...built, paths: ["release-notes/betas.tsv"] };
      },
    };
  }

  function executor(
    behave: Partial<Record<StepName, Behavior>> = {},
    host: DeliveryStepAdapter | null = null,
  ): DeliveryExecutor {
    const steps = adapter(behave);
    return createDeliveryExecutor({
      projectId,
      installation: "srv/mira",
      state: h.store,
      adapters: { host: host ?? steps, container: steps },
      deliveryCheckouts: { host: checkoutPort("host"), container: checkoutPort("container") },
      branch: { head: async () => h.branchHead, firstParent: async () => h.branchCommits },
      async authorizeSideEffect(effect) {
        h.sideEffects.push(effect);
        return !(effect.kind === "records-push" && h.vetoPush);
      },
      lifecycle: {
        async request() {
          h.lifecycleRequests++;
          return "request-1";
        },
        async status() {
          return h.lifecycleStatus;
        },
      },
      checks: null,
      recipeAt: async () => ({ recipe: h.recipe, error: null }),
      hostGate: async (sha) => h.gate(sha),
      fence: async () => 1,
      async notify() {
        if (h.notifyFails) throw new Error("The push service is unavailable.");
      },
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

  return { h, executor, count, pastNotice, adapter };
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
    expect(t.count("deployBeta")).toBe(0);
    expect(t.h.launches.map((launch) => launch.step)).not.toContain("deployBeta");
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
    expect(legacy.count("deployBeta")).toBe(0);
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
  it("fails the beta at a failed gate before anything deploys and records the failure", async () => {
    const t = await harness();
    await shipBeta(t, t.executor({ "gate:unit suite": "exit-1" }));
    const run = await only(t.executor());
    expect(run.failure?.kind).toBe("step-failed");
    expect(t.count("deployBeta")).toBe(0);
    expect(t.count("gate:tools suite")).toBe(0);
    const failed = await latestRelease(t);
    expect(failed.kind).toBe("failed");
    expect(failed.gates.map((gate) => gate.result)).toEqual(["pass", "fail", "not-run"]);
  });

  it.each([
    { name: "the merged pull request titles", supplied: null, notes: "- Fix the jump (#12)" },
    { name: "notes supplied by the caller", supplied: "Faster boats.", notes: "Faster boats." },
  ])("reports the release number, records gates and passes $name", async ({ supplied, notes }) => {
    const t = await harness();
    const executor = t.executor();
    const contents = [{ pr: 12, issue: 3, title: "Fix the jump" }];
    const queued = await executor.queueBeta({ commit, number: null, note: null, contents });
    if (!("runId" in queued)) throw new Error(queued.refused);
    if (supplied) await executor.supplyNotes(queued.runId, supplied);
    await executor.advance();
    t.pastNotice();
    await executor.advance();

    const deploy = t.h.launches.find((launch) => launch.step === "deployBeta");
    expect(t.count("releaseNumber")).toBe(1);
    expect(deploy?.env.VORTEO_RELEASE_NUMBER).toBe("136");
    expect(deploy?.env.VORTEO_RELEASE_NOTES).toBe(notes);
    expect(deploy?.env.VORTEO_RELEASE_NOTE).toBe("Fix the jump");
    const beta = await latestRelease(t);
    expect(beta.kind).toBe("beta");
    expect(beta.gates.map((gate) => gate.result)).toEqual(["pass", "pass", "pass"]);
  });

  it.each([
    {
      name: "only release records",
      commits: [{ sha: "e".repeat(40), paths: ["release-notes/betas.tsv"] }],
      delivered: true,
    },
    {
      name: "a change outside the records",
      commits: [{ sha: "f".repeat(40), paths: ["src/game.ts", "release-notes/betas.tsv"] }],
      delivered: false,
    },
    { name: "an unprovable history", commits: null, delivered: false },
  ])(
    "accepts commits landing during the deploy only with $name",
    async ({ commits, delivered }) => {
      const t = await harness();
      t.h.branchCommits = commits;
      const executor = t.executor();
      await shipBeta(t, executor);
      const run = await only(executor);
      expect(run.state).toBe(delivered ? "delivered" : "failed");
      expect(t.count("verifyBeta")).toBe(delivered ? 1 : 0);
      expect(t.h.sideEffects[0]).toEqual({ runId: run.id, kind: "deploy", expectedHead: commit });
      if (!delivered) {
        if (commits) expect(run.failure?.reason).toContain("f".repeat(40));
        return;
      }
      const receipt = (await t.h.store.read(projectId)).delivery.receipts.at(-1);
      expect(receipt).toMatchObject({
        branch: { before: commit, after: commit, commits },
        records: { commit: "d".repeat(40), parent: commit, paths: ["release-notes/betas.tsv"] },
      });
    },
  );

  it("tags the beta with its version and holds the records push until the composition allows it", async () => {
    const t = await harness();
    t.h.vetoPush = true;
    const executor = t.executor();
    await shipBeta(t, executor);
    expect(t.h.tags).toEqual(["m-factory-v26.11.2701"]);
    expect(t.h.prepared).toEqual([`host:${commit}`]);
    const held = await only(executor);
    expect(held.state).toBe("verifying");
    expect(held.waitingOn).toContain("records push");
    expect(t.h.pushes).toBe(0);

    t.h.vetoPush = false;
    await executor.advance();
    expect((await only(executor)).state).toBe("delivered");
    expect(t.h.pushes).toBe(1);
  });

  it("installs dependencies again only when the lockfile changed", async () => {
    const t = await harness();
    const executor = t.executor();
    await shipBeta(t, executor);
    await shipBeta(t, executor);
    const betas = (await t.h.store.read(projectId)).releases.filter((e) => e.kind === "beta");
    expect(betas).toHaveLength(2);
    expect(t.count("install")).toBe(1);
  });

  it.each([
    {
      name: "after its gates ran",
      step: "deployBeta",
      behavior: "wait-before-launch",
      cancels: true,
    },
    {
      name: "while its deploy runs",
      step: "deployBeta",
      behavior: "hang-after-launch",
      cancels: false,
    },
    {
      name: "while a gate runs",
      step: "gate:unit suite",
      behavior: "hang-after-launch",
      cancels: false,
    },
  ] as const)("lets the owner's pause cancel a beta $name", async ({ step, behavior, cancels }) => {
    const t = await harness();
    const executor = t.executor({ [step]: behavior });
    await executor.queueBeta({ commit, number: "70", note: "n", contents: [] });
    await executor.advance();
    t.pastNotice();
    const pass = executor.advance();
    await vi.waitFor(() => expect(t.h.entered).toContain(step));
    if (behavior === "hang-after-launch") await vi.waitFor(() => expect(t.count(step)).toBe(1));

    const at = t.h.now.toISOString();
    const reason = "Paused by the owner.";
    const ids = await t.h.store.mutate(projectId, (ledger) =>
      cancelUnstartedBetas(ledger, { reason, at }),
    );
    expect(ids).toHaveLength(cancels ? 1 : 0);
    if (!cancels) return;
    t.h.releaseLaunch();
    await pass;
    const run = await only(executor);
    expect(run.failure?.kind).toBe("cancelled");
    expect(t.count("deployBeta")).toBe(0);
    expect((await t.h.store.read(projectId)).delivery.lock).toBeNull();
  });

  it.each([
    {
      name: "its frozen copy is unchanged",
      fingerprint: null,
      stable: null,
      strip: false,
      delivered: true,
      deployed: 1,
      because: "",
    },
    {
      name: "its frozen copy changed since the beta",
      fingerprint: "0".repeat(64),
      stable: null,
      strip: false,
      delivered: false,
      deployed: 0,
      because: "changed since its beta",
    },
    {
      name: "no beta recorded a digest",
      fingerprint: null,
      stable: null,
      strip: true,
      delivered: false,
      deployed: 0,
      because: "No delivered beta recorded a digest",
    },
    {
      name: "production serves other bytes",
      fingerprint: null,
      stable: "1".repeat(64),
      strip: false,
      delivered: false,
      deployed: 1,
      because: "digest other than",
    },
  ])(
    "promotes only when $name",
    async ({ fingerprint, stable, strip, delivered, deployed, because }) => {
      const t = await harness();
      const executor = t.executor();
      const beta = await deliverBeta(t, executor);
      if (strip) {
        await t.h.store.mutate(projectId, (ledger) => {
          for (const receipt of ledger.delivery.receipts)
            Reflect.deleteProperty(receipt, "artifact");
        });
      }
      t.h.fingerprintDigest = fingerprint;
      t.h.stableDigest = stable;
      await executor.queuePromote({
        eventId: beta.id,
        expectedProduction: null,
        approval: approval(beta.id, beta.version),
        number: "70",
        note: "n",
      });
      await executor.advance();
      const run = await only(executor);
      expect(run.state).toBe(delivered ? "delivered" : "failed");
      expect(t.count("promote")).toBe(deployed);
      expect(t.count("install")).toBe(1);
      if (!delivered) {
        expect(run.failure?.reason).toContain(because);
        return;
      }
      const ledger: DeliveryLedger = await t.h.store.read(projectId);
      const receipts = ledger.delivery.receipts;
      const digest = digestOf(beta.artifact ?? "");
      expect(receipts.map((receipt) => receipt.artifact)).toEqual([
        { id: beta.artifact, digest },
        { id: beta.artifact, digest },
      ]);
    },
  );

  it("records the notice attempt before handing it to the sender", async () => {
    const t = await harness();
    t.h.notifyFails = true;
    const executor = t.executor();
    await executor.queueBeta({ commit, number: "70", note: "n", contents: [] });
    await expect(executor.advance()).rejects.toThrow("push service");
    const attempted = (await executor.snapshot()).pendingBeta;
    expect(attempted?.noticeAttemptedAt).toBe(t.h.now.toISOString());
    expect(attempted?.noticeSentAt).toBeNull();

    t.h.notifyFails = false;
    await executor.advance();
    expect((await executor.snapshot()).pendingBeta?.noticeSentAt).toBe(t.h.now.toISOString());
  });

  it.each([
    {
      name: "a bare checkout path from older settings is refused",
      release: { checkout: "/Users/vtn/dev/Syn3h-factory" },
      refused: "Re-approve the delivery checkout",
    },
    {
      name: "a checkout whose links differ is refused",
      release: {
        checkout: {
          name: "Syn3h-factory",
          links: [{ name: "Syn3h-stable", target: "/tmp/elsewhere" }],
        },
      },
      refused: "no delivery checkout named Syn3h-factory",
    },
    {
      name: "a single install step is accepted",
      release: {
        steps: {
          ...mira.steps,
          install: { where: "host", run: "npm ci", lockfile: "package-lock.json" },
        },
      },
      refused: null,
    },
  ])("reads settings: $name", async ({ release, refused }) => {
    const t = await harness({ ...mira, ...release });
    const executor = t.executor();
    const queued = await executor.queueBeta({ commit, number: "70", note: "n", contents: [] });
    if (refused) {
      expect(queued).toEqual({ refused: expect.stringContaining(refused) });
      return;
    }
    await executor.advance();
    t.pastNotice();
    await executor.advance();
    expect((await only(executor)).state).toBe("delivered");
    expect(t.count("install")).toBe(1);
  });

  it.each([
    {
      name: "declared tags are published",
      declared: true,
      refuse: false,
      pushed: ["release-136", "v26.11.2701"],
      reason: null,
    },
    {
      name: "a refused tag push leaves the release delivered",
      declared: true,
      refuse: true,
      pushed: [],
      reason: "refused",
    },
    {
      name: "undeclared tags are never published",
      declared: false,
      refuse: false,
      pushed: [],
      reason: null,
    },
  ])("after a promotion: $name", async ({ declared, refuse, pushed, reason }) => {
    const recipe = declared ? mira : { ...mira, tags: undefined };
    const t = await harness(recipe);
    t.h.refuseTags = refuse;
    const executor = t.executor();
    const beta = await deliverBeta(t, executor);
    expect(t.h.pushedTags).toEqual([]);
    await executor.queuePromote({
      eventId: beta.id,
      expectedProduction: null,
      approval: approval(beta.id, beta.version),
      number: "136",
      note: "n",
    });
    await executor.advance();
    const run = await only(executor);
    expect(run.state).toBe("delivered");
    expect(t.h.pushedTags).toEqual(pushed);
    expect((await latestRelease(t)).kind).toBe("promote");
    const ledger: DeliveryLedger = await t.h.store.read(projectId);
    const receipt = ledger.delivery.receipts.at(-1);
    if (!declared) {
      expect(receipt).not.toHaveProperty("tags");
      return;
    }
    expect(receipt?.tags?.map((tag) => tag.name)).toEqual(pushed);
    if (reason) expect(receipt?.tagsNotPublished).toContain(reason);
    else expect(receipt?.tagsNotPublished).toBeNull();
  });
});

interface FakeProcess {
  spawned: SpawnRequest[];
  spawner: {
    spawn(
      request: SpawnRequest,
    ): Promise<{ pid: number; exited: Promise<never> | Promise<{ code: number; signal: null }> }>;
  };
}

function fakeSpawner(exit: "exit-0" | "never"): FakeProcess {
  const spawned: SpawnRequest[] = [];
  return {
    spawned,
    spawner: {
      async spawn(request) {
        spawned.push(request);
        const exited =
          exit === "never"
            ? new Promise<never>(() => undefined)
            : Promise.resolve({ code: 0, signal: null });
        return { pid: 4242, exited };
      },
    },
  };
}

function fakeGit(head: string, options: { dirty?: boolean; changed?: string } = {}): GitRunner {
  return {
    async run(_cwd, args) {
      if (args[0] === "rev-parse") return head;
      if (args[0] === "diff") return options.dirty ? (options.changed ?? "tools/ship.sh") : "";
      throw Object.assign(new Error(`unexpected git ${args.join(" ")}`), { code: 1 });
    },
  };
}

const hostile = `1"; touch /tmp/pwned; echo "$(id)`;
const later = "c".repeat(40);
const files = { tail: async () => "tail" };

function stepRequest(
  overrides: Partial<DeliveryStepRequest> = {},
): DeliveryStepRequest & { pids: number[]; authorized: number } {
  const pids: number[] = [];
  const state = { pids, authorized: 0 };
  return Object.assign(state, {
    commit,
    records: ["release-notes/betas.tsv"],
    command: 'exec tools/ship.sh "$VORTEO_RELEASE_NUMBER"',
    env: { VORTEO_RELEASE_NUMBER: hostile },
    timeoutMs: 1_000,
    heavy: false,
    outputPath: "/private/delivery-logs/run.log",
    authorizeLaunch: async () => {
      state.authorized++;
      return true;
    },
    onSpawned: async (pid: number) => {
      pids.push(pid);
    },
    ...overrides,
  });
}

describe("delivery step adapters", () => {
  it.each([
    {
      name: "at the accepted commit",
      git: fakeGit(commit),
      runs: true,
    },
    { name: "at another commit", git: fakeGit(later), runs: false },
    {
      name: "with only the release record changed",
      git: fakeGit(commit, { dirty: true, changed: "release-notes/betas.tsv" }),
      runs: true,
    },
    {
      name: "with uncommitted changes",
      git: fakeGit(commit, { dirty: true }),
      runs: false,
    },
  ] as const)("runs a Host step only in a verified checkout: $name", async ({ git, runs }) => {
    const fake = fakeSpawner("exit-0");
    const checkout = createVerifiedCheckout({ gitPath: "/mira", cwd: "/mira", git });
    const adapter = createHostStepAdapter({
      spawner: fake.spawner,
      files,
      checkout,
      baseEnv: { PATH: "/usr/bin:/bin", HOME: "/Users/owner" },
      heavyWrapper: null,
    });
    const step = stepRequest();
    const output = await adapter.run(step);

    expect(fake.spawned.length).toBe(runs ? 1 : 0);
    expect(step.authorized).toBe(runs ? 1 : 0);
    if (!runs) {
      expect(output).toHaveProperty("notStarted");
      return;
    }
    expect(output).toEqual({ exitCode: 0, stdout: "tail" });
    expect(step.pids).toEqual([4242]);
    expect(fake.spawned[0]).toMatchObject({
      file: "/bin/sh",
      args: ["-c", step.command],
      cwd: "/mira",
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/owner", VORTEO_RELEASE_NUMBER: hostile },
    });
  });

  it("names release values to docker exec without putting them in its arguments", async () => {
    const fake = fakeSpawner("exit-0");
    const adapter = createContainerStepAdapter({
      spawner: fake.spawner,
      files,
      checkout: { at: async () => ({ cwd: "/home/paseo/mira", head: commit }) },
      dockerBinary: "/usr/local/bin/docker",
      container: "vorteo-dev",
      clientEnv: { PATH: "/usr/bin:/bin" },
    });
    const step = stepRequest();
    await adapter.run(step);
    const [spawned] = fake.spawned;
    expect(spawned?.args).toEqual([
      "exec",
      "--workdir",
      "/home/paseo/mira",
      "--env",
      "VORTEO_RELEASE_NUMBER",
      "vorteo-dev",
      "/bin/sh",
      "-c",
      step.command,
    ]);
    expect(spawned?.args.join(" ")).not.toContain(hostile);
    expect(spawned?.env.VORTEO_RELEASE_NUMBER).toBe(hostile);
  });

  it("records the deploy's process id and leaves an overrun or orphaned deploy unknown", async () => {
    const t = await harness();
    const fake = fakeSpawner("never");
    const deploying = createHostStepAdapter({
      spawner: fake.spawner,
      files,
      checkout: { at: async () => ({ cwd: "/mira", head: commit }) },
      baseEnv: { PATH: "/usr/bin:/bin" },
      heavyWrapper: null,
    });
    const others = t.adapter();
    const host: DeliveryStepAdapter = {
      run: (request) =>
        request.command === commandOf(mira, "deployBeta")
          ? deploying.run(request)
          : others.run(request),
    };
    const first = t.executor({}, host);
    await first.queueBeta({ commit, number: "70", note: "n", contents: [] });
    await first.advance();
    t.pastNotice();
    void first.advance();
    await vi.waitFor(async () => expect((await only(first)).receipts.deploy?.pid).toBe(4242));

    const second = t.executor({}, host);
    await second.resume();
    await second.advance();
    const run = await only(second);
    expect(run.receipts.deploy?.status).toBe("unknown");
    expect(run.failure?.kind).toBe("unknown");
    expect(fake.spawned.length).toBe(1);
  });

  it.each([
    {
      name: "an appended row",
      working: "row-1\nrow-2\n",
      upstream: "row-1",
      other: false,
      allow: true,
      push: true,
      result: "commit",
    },
    {
      name: "an edited row",
      working: "row-x\nrow-2\n",
      upstream: "row-1",
      other: false,
      allow: true,
      push: true,
      result: "refused",
    },
    {
      name: "rows that changed upstream",
      working: "row-1\nrow-2\n",
      upstream: "row-0",
      other: false,
      allow: true,
      push: true,
      result: "refused",
    },
    {
      name: "another dirty file",
      working: "row-1\nrow-2\n",
      upstream: "row-1",
      other: true,
      allow: true,
      push: true,
      result: "refused",
    },
    {
      name: "a withheld push",
      working: "row-1\nrow-2\n",
      upstream: "row-1",
      other: false,
      allow: false,
      push: true,
      result: "withheld",
    },
    {
      name: "a rejected push",
      working: "row-1\nrow-2\n",
      upstream: "row-1",
      other: false,
      allow: true,
      push: false,
      result: "refused",
    },
  ] as const)("commits release records only as $name allows", async (c) => {
    const base = "a".repeat(40);
    const expectedHead = "e".repeat(40);
    const calls: string[][] = [];
    const git: GitRunner = {
      async run(_cwd, args) {
        calls.push(args);
        const [command, target = ""] = args;
        if (command === "diff") {
          return c.other ? "release-notes/betas.tsv\0src/game.ts\0" : "release-notes/betas.tsv\0";
        }
        if (command === "log") return "";
        if (command === "show") return target.startsWith(base) ? "row-1" : c.upstream;
        if (command === "hash-object") return "b".repeat(40);
        if (command === "write-tree") return "t".repeat(40);
        if (command === "commit-tree") return "c".repeat(40);
        if (command === "push" && !c.push) throw Object.assign(new Error("rejected"), { code: 1 });
        return "";
      },
    };
    const checkout = createDeliveryCheckout({
      pool: "/mira-pool",
      path: "/mira-factory",
      links: [],
      remoteUrl: "https://example.invalid/mira.git",
      git,
      defaultBranch: "main",
      identity: { name: "Vorteo Factory", email: "factory@example.invalid" },
      exists: async () => true,
      readWorking: async () => c.working,
    });
    const result = await checkout.commitRecords({
      base,
      expectedHead,
      records: ["release-notes/betas.tsv"],
      message: "Record Factory release v1 (run)",
      authorizePush: async () => c.allow,
    });
    const pushed = calls.some(([command]) => command === "push");
    if (c.result === "commit") {
      expect(result).toEqual({
        commit: "c".repeat(40),
        parent: expectedHead,
        paths: ["release-notes/betas.tsv"],
      });
      expect(calls.find(([command]) => command === "push")).toEqual([
        "push",
        "--quiet",
        "origin",
        `${"c".repeat(40)}:refs/heads/main`,
      ]);
      return;
    }
    expect(result).toHaveProperty(c.result);
    expect(pushed).toBe(c.result === "refused" && !c.push);
  });

  it("refuses an existing path that is not this project's delivery worktree", async () => {
    const calls: string[][] = [];
    const git: GitRunner = {
      async run(cwd, args) {
        calls.push(args);
        if (args.includes("--git-common-dir"))
          return cwd === "/mira-pool" ? "/mira-pool" : "/other/.git";
        if (args.includes("--is-bare-repository")) return "true";
        if (args[0] === "config") return "https://example.invalid/mira.git";
        return "";
      },
    };
    const checkout = createDeliveryCheckout({
      pool: "/mira-pool",
      path: "/Users/owner/dev/Syn3h-factory",
      links: [],
      remoteUrl: "https://example.invalid/mira.git",
      git,
      defaultBranch: "main",
      identity: { name: "Vorteo Factory", email: "factory@example.invalid" },
      exists: async () => true,
    });
    const prepared = await checkout.prepare({ commit, records: [], importTags: [] });
    expect(prepared).toHaveProperty("notStarted");
    expect(calls.some(([command]) => command === "checkout" || command === "worktree")).toBe(false);
  });
});

interface RealRepo {
  root: string;
  pool: string;
  stable: string;
  remote: string;
  trunk: string;
  factory: string;
  git(cwd: string, ...args: string[]): string;
  write(cwd: string, file: string, text: string): void;
  commitAll(cwd: string, message: string): string;
}

const RECORD = "release-notes/betas.tsv";
const identity = { name: "Factory Test", email: "factory-test@example.invalid" };

async function realRepo(): Promise<RealRepo> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "lean-delivery-git-")));
  const home = path.join(root, "home");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();
  }
  function write(cwd: string, file: string, text: string): void {
    const target = path.join(cwd, file);
    execFileSync("mkdir", ["-p", path.dirname(target)]);
    execFileSync("tee", [target], { input: text, stdio: ["pipe", "ignore", "inherit"] });
  }
  function commitAll(cwd: string, message: string): string {
    git(cwd, "add", "-A");
    git(cwd, "commit", "--quiet", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  }
  const remote = path.join(root, "remote.git");
  const trunk = path.join(root, "Syn3h");
  execFileSync("mkdir", ["-p", home]);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote], { env });
  execFileSync("git", ["clone", "--quiet", remote, trunk], { env });
  write(trunk, RECORD, "# version\tcommit\nv1\taaaa\n");
  write(trunk, "src/game.ts", "export const game = 1;\n");
  commitAll(trunk, "Seed");
  git(trunk, "push", "--quiet", "origin", "HEAD:main");
  const stable = path.join(root, "stable-releases");
  execFileSync("mkdir", ["-p", stable]);
  const checkouts = path.join(root, "home", "factory", "lean", "delivery-checkouts", "mira");
  return {
    root,
    pool: path.join(checkouts, "repo.git"),
    stable,
    remote,
    trunk,
    factory: path.join(checkouts, "Syn3h-factory"),
    git,
    write,
    commitAll,
  };
}

function realCheckout(repo: RealRepo, links = [{ name: "Syn3h-stable", target: repo.stable }]) {
  const gitBinary = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const home = path.join(repo.root, "home");
  return createDeliveryCheckout({
    pool: repo.pool,
    path: repo.factory,
    links,
    remoteUrl: repo.remote,
    git: createGitRunner(gitBinary, { HOME: home, GIT_CONFIG_NOSYSTEM: "1" }),
    defaultBranch: "main",
    identity,
  });
}

interface RealCase {
  name: string;
  /** Changes the checkout or the remote after prepare; returns the head the records push expects. */
  change(repo: RealRepo, prepared: string): string;
  committed: boolean;
  /** Part of the refusal sentence, so a refusal for the wrong reason fails. */
  because?: string;
}

const appendRow = (repo: RealRepo) =>
  repo.write(repo.factory, RECORD, "# version\tcommit\nv1\taaaa\nv2\tbbbb\n");

const realCases: RealCase[] = [
  {
    name: "an appended row is committed and pushed fast-forward",
    change(repo, prepared) {
      appendRow(repo);
      return prepared;
    },
    committed: true,
  },
  {
    name: "an edited row is refused",
    change(repo, prepared) {
      repo.write(repo.factory, RECORD, "# version\tcommit\nv1\tzzzz\nv2\tbbbb\n");
      return prepared;
    },
    committed: false,
    because: "other than by appended rows",
  },
  {
    name: "a dirty source file is refused",
    change(repo, prepared) {
      appendRow(repo);
      repo.write(repo.factory, "src/game.ts", "export const game = 2;\n");
      return prepared;
    },
    committed: false,
    because: "not release records",
  },
  {
    name: "rows that changed upstream are refused",
    change(repo) {
      appendRow(repo);
      repo.git(repo.trunk, "pull", "--quiet", "origin", "main");
      repo.write(repo.trunk, RECORD, "# version\tcommit\nv1\taaaa\nv9\t9999\n");
      const upstream = repo.commitAll(repo.trunk, "Someone else's record");
      repo.git(repo.trunk, "push", "--quiet", "origin", "HEAD:main");
      return upstream;
    },
    committed: false,
    because: "changed on the default branch",
  },
  {
    name: "a stale expected head is refused by the fast-forward push",
    change(repo, prepared) {
      appendRow(repo);
      repo.git(repo.trunk, "pull", "--quiet", "origin", "main");
      repo.write(repo.trunk, "src/other.ts", "export const other = 1;\n");
      repo.commitAll(repo.trunk, "An unrelated merge");
      repo.git(repo.trunk, "push", "--quiet", "origin", "HEAD:main");
      return prepared;
    },
    committed: false,
    because: "push was rejected",
  },
];

describe("delivery checkout against real git", () => {
  it.each(realCases)("$name", async ({ change, committed, because }) => {
    const repo = await realRepo();
    const checkout = realCheckout(repo);
    const base = repo.git(repo.remote, "rev-parse", "main");
    const prepared = await checkout.prepare({ commit: base, records: [RECORD], importTags: [] });
    expect(prepared).toEqual({ head: base });
    expect(repo.git(repo.factory, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
      repo.pool,
    );
    expect(await realpath(path.join(path.dirname(repo.factory), "Syn3h-stable"))).toBe(repo.stable);
    const trunkHead = repo.git(repo.trunk, "rev-parse", "HEAD");
    void trunkHead;

    const expectedHead = change(repo, base);
    const remoteBefore = repo.git(repo.remote, "rev-parse", "main");
    const result = await checkout.commitRecords({
      base,
      expectedHead,
      records: [RECORD],
      message: "Record Factory release v2 (run-1)",
      authorizePush: async () => true,
    });
    const remoteAfter = repo.git(repo.remote, "rev-parse", "main");

    if (!committed) {
      expect(result).toEqual({ refused: expect.stringContaining(because ?? "") });
      expect(repo.git(repo.trunk, "status", "--porcelain")).toBe("");
      expect(remoteAfter).toBe(remoteBefore);
      return;
    }
    expect(result).toEqual({ commit: remoteAfter, parent: base, paths: [RECORD] });
    expect(repo.git(repo.remote, "rev-parse", "main^")).toBe(base);
    expect(repo.git(repo.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main")).toBe(
      RECORD,
    );
    expect(repo.git(repo.remote, "show", `main:${RECORD}`)).toBe(
      "# version\tcommit\nv1\taaaa\nv2\tbbbb",
    );

    // The rows are upstream now, so the next prepare may discard them and move on.
    const next = await checkout.prepare({ commit: remoteAfter, records: [RECORD], importTags: [] });
    expect(next).toEqual({ head: remoteAfter });
    expect(repo.git(repo.factory, "status", "--porcelain")).toBe("");
  });

  it("refuses an existing directory that is not this repository's worktree and leaves it alone", async () => {
    const repo = await realRepo();
    execFileSync("mkdir", ["-p", path.dirname(repo.factory)]);
    execFileSync("git", ["init", "--quiet", repo.factory]);
    const before = readdirSyncNames(repo.factory);
    const prepared = await realCheckout(repo).prepare({
      commit: repo.git(repo.remote, "rev-parse", "main"),
      records: [RECORD],
      importTags: [],
    });
    expect(prepared).toHaveProperty("notStarted");
    expect(readdirSyncNames(repo.factory)).toEqual(before);
  });

  it.each([
    { name: "a link to another directory", existing: "other-link" },
    { name: "a real directory where the link belongs", existing: "directory" },
  ] as const)("refuses $name and leaves it in place", async ({ existing }) => {
    const repo = await realRepo();
    const beside = path.join(path.dirname(repo.factory), "Syn3h-stable");
    execFileSync("mkdir", ["-p", path.dirname(repo.factory)]);
    if (existing === "other-link") await symlink(repo.root, beside, "dir");
    else execFileSync("mkdir", ["-p", beside]);
    const before = existing === "other-link" ? await realpath(beside) : "directory";
    const prepared = await realCheckout(repo).prepare({
      commit: repo.git(repo.remote, "rev-parse", "main"),
      records: [RECORD],
      importTags: [],
    });
    expect(prepared).toEqual({ notStarted: expect.stringContaining("Syn3h-stable") });
    const after = existing === "other-link" ? await realpath(beside) : "directory";
    expect(after).toBe(before);
  });

  it("refuses a link target reached through another symlink", async () => {
    const repo = await realRepo();
    const chained = path.join(repo.root, "chained-stable");
    await symlink(repo.stable, chained, "dir");
    const prepared = await realCheckout(repo, [{ name: "Syn3h-stable", target: chained }]).prepare({
      commit: repo.git(repo.remote, "rev-parse", "main"),
      records: [RECORD],
      importTags: [],
    });
    expect(prepared).toEqual({ notStarted: expect.stringContaining("its own real path") });
  });

  it.each([
    { name: "a new tag is pushed atomically", remoteHasOther: false, published: true },
    {
      name: "a tag the origin holds on another object is refused",
      remoteHasOther: true,
      published: false,
    },
  ])("publishes tags without force: $name", async ({ remoteHasOther, published }) => {
    const repo = await realRepo();
    const checkout = realCheckout(repo);
    const base = repo.git(repo.remote, "rev-parse", "main");
    await checkout.prepare({ commit: base, records: [RECORD], importTags: [] });
    if (remoteHasOther) {
      repo.write(repo.trunk, "src/other.ts", "export const other = 1;\n");
      const other = repo.commitAll(repo.trunk, "Other");
      repo.git(repo.trunk, "push", "--quiet", "origin", `${other}:refs/tags/release-136`);
    }
    repo.git(repo.factory, "tag", "release-136", base);
    const before = repo.git(repo.remote, "for-each-ref", "refs/tags");
    const result = await checkout.pushTags({
      names: ["release-136"],
      authorizePush: async () => true,
    });
    const after = repo.git(repo.remote, "for-each-ref", "refs/tags");
    if (!published) {
      expect(result).toHaveProperty("refused");
      expect(after).toBe(before);
      return;
    }
    expect(result).toEqual({ pushed: [{ name: "release-136", object: base }] });
    expect(repo.git(repo.remote, "rev-parse", "refs/tags/release-136")).toBe(base);
  });

  it("imports origin release tags but never lets one retarget a local tag", async () => {
    const repo = await realRepo();
    const base = repo.git(repo.remote, "rev-parse", "main");
    repo.git(repo.trunk, "push", "--quiet", "origin", `${base}:refs/tags/release-135`);
    const checkout = realCheckout(repo);
    const first = await checkout.prepare({
      commit: base,
      records: [RECORD],
      importTags: ["release-*"],
    });
    expect(first).toEqual({ head: base });
    expect(repo.git(repo.factory, "rev-parse", "refs/tags/release-135")).toBe(base);

    repo.write(repo.trunk, "src/other.ts", "export const other = 1;\n");
    const other = repo.commitAll(repo.trunk, "Other");
    repo.git(repo.trunk, "push", "--quiet", "--force", "origin", `${other}:refs/tags/release-135`);
    const second = await checkout.prepare({
      commit: base,
      records: [RECORD],
      importTags: ["release-*"],
    });
    expect(second).toEqual({ notStarted: expect.stringContaining("release-*") });
    expect(repo.git(repo.factory, "rev-parse", "refs/tags/release-135")).toBe(base);
  });
});

function readdirSyncNames(dir: string): string[] {
  return execFileSync("ls", ["-A", dir], { encoding: "utf8" }).trim().split("\n");
}
