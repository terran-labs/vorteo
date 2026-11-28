import { createHash } from "node:crypto";
import { FactoryConfigV1Schema, ReleaseRecipeV1Schema } from "@getpaseo/server/factory-lean";
import { z } from "zod";
import type { FactoryGitHub } from "../project/claims.js";
import {
  cancelUnstartedBetas,
  createDeliveryExecutor,
  type BetaInput,
  type DeliveryExecutorDeps,
  type DeliveryRun,
  type RecipeAtCommit,
} from "./delivery/executor.js";
import type { MergeIntent } from "./merge-gate.js";
import type { LeanLedger } from "./types.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const object = z.object({ sha });
const tree = object.extend({
  truncated: z.literal(false),
  tree: z.array(object.extend({ path: z.string(), mode: z.string(), type: z.string() })),
});
const pull = z.object({
  number: z.number().int().positive(),
  merged: z.literal(true),
  merge_commit_sha: sha,
  title: z.string().min(1),
  head: object,
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});
const comparison = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
  merge_base_commit: object,
});
const changedPath = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().min(1).optional(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
});
const commitRecord = object.extend({ parents: z.array(object) });
const firstParentLimit = 128;
const githubComparisonFileLimit = 300;

export const deliveryReleaseSchema = z.preprocess(
  (recipe) =>
    recipe && typeof recipe === "object" && !Array.isArray(recipe) && !("trigger" in recipe)
      ? { ...recipe, trigger: { kind: "every-batch" } }
      : recipe,
  ReleaseRecipeV1Schema.safeExtend({ baselineCommit: sha.optional() }),
);
const recipeFile = FactoryConfigV1Schema.extend({ release: deliveryReleaseSchema.optional() });
const missingBaseline = "No trusted starting commit. Add it to the Factory settings file.";

interface SettledMerge {
  head: string;
  mergeSha: string;
  settled: boolean;
}
interface DeliveryInputLedger extends LeanLedger {
  runtimeMerges?: Record<string, SettledMerge>;
  mergeIntents?: Record<string, MergeIntent>;
}
type DeliveryWaitLedger = Omit<LeanLedger, "delivery"> & {
  delivery: LeanLedger["delivery"] & { waitingOn?: string; waitingForCommit?: string };
};

type Ports = Pick<
  DeliveryExecutorDeps,
  "adapters" | "deliveryCheckouts" | "lifecycle" | "notify" | "logDir" | "stepTimeoutMs"
>;
type HostDeliveryGate = NonNullable<Awaited<ReturnType<DeliveryExecutorDeps["hostGate"]>>> & {
  reason?: string;
  checkpoint?: string;
};
export type DeliveryRuntimePorts = Ports &
  Pick<DeliveryExecutorDeps, "checks"> & {
    ready?(): Promise<boolean>;
    /** Inject the historical Host gate bound to this project, never a model result or stand-in. */
    hostGate(commit: string, configuredBaseline: string | null): Promise<HostDeliveryGate | null>;
  };

interface ProjectDeliveryServices {
  projectId: string;
  repository: string;
  github: FactoryGitHub;
  state: DeliveryExecutorDeps["state"];
}

/** Trusted installation wiring; return null for projects without provisioned execution. */
export type DeliveryRuntimeProvider = (
  project: ProjectDeliveryServices & {
    readOwnerDelivery(): Promise<{
      checkout: { name: string; links: readonly { name: string; target: string }[] };
    } | null>;
  },
) => DeliveryRuntimePorts | null | Promise<DeliveryRuntimePorts | null>;

interface DeliveryRuntimeOptions extends ProjectDeliveryServices {
  installation: string;
  /** Fresh, live fixed-primary authority on the requested lane, or null. */
  laneEpoch(lane: "delivery" | "releaseBuild"): Promise<number | null>;
  /** Only the verified owner settings file on the repository default branch may supply this. */
  readBaseline(): Promise<string | null>;
  now(): Date;
  ports: DeliveryRuntimePorts;
  onError(error: unknown): void;
}

class DeliveryAuthorityLost extends Error {}

/** Only the authenticated project pause path calls this. Shares the executor's writer. */
export async function pauseProjectDelivery(
  state: DeliveryExecutorDeps["state"],
  projectId: string,
  now: () => Date,
): Promise<void> {
  await state.mutate(projectId, (ledger) =>
    cancelUnstartedBetas(ledger, {
      reason: "Held by the owner's Factory project pause.",
      at: now().toISOString(),
    }),
  );
}

function projectGitHub(github: FactoryGitHub, repository: string) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new Error("Delivery requires a configured GitHub repository.");
  const sameRepo = (name: string) => name.toLowerCase() === repository.toLowerCase();
  async function get<T>(route: string, schema: z.ZodType<T>): Promise<T> {
    const response = await github.rest("GET", `repos/${repository}${route}`);
    if (response.status !== 200) throw new Error("GitHub could not verify the delivery source.");
    return schema.parse(response.body);
  }

  async function entries(oid: string) {
    const result = await get(`/git/trees/${oid}`, tree);
    if (result.sha !== oid) throw new Error("GitHub returned a different delivery tree.");
    return result.tree;
  }

  async function recipeAt(commit: string): Promise<RecipeAtCommit> {
    try {
      const oid = sha.parse(commit);
      const source = await get(`/git/commits/${oid}`, object.extend({ tree: object }));
      if (source.sha !== oid) throw new Error("GitHub returned a different delivery commit.");
      const directory = (await entries(source.tree.sha)).find((item) => item.path === ".github");
      if (!directory) return { recipe: null, error: null };
      if (directory.type !== "tree" || directory.mode !== "040000")
        throw new Error("Delivery configuration directory is not a Git tree.");
      const file = (await entries(directory.sha)).find(
        (item) => item.path === "vorteo-factory.json",
      );
      if (!file) return { recipe: null, error: null };
      if (file.type !== "blob" || file.mode !== "100644")
        throw new Error("Delivery configuration is not a regular Git file.");
      const blob = await get(
        `/git/blobs/${file.sha}`,
        object.extend({ encoding: z.literal("base64"), content: z.string().max(128 * 1024) }),
      );
      const bytes = Buffer.from(blob.content, "base64");
      const calculated = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (blob.sha !== file.sha || calculated !== file.sha)
        throw new Error("GitHub returned a different delivery configuration blob.");
      return {
        recipe: recipeFile.parse(JSON.parse(bytes.toString("utf8"))).release ?? null,
        error: null,
      };
    } catch {
      return { recipe: null, error: "The accepted commit's release recipe could not be verified." };
    }
  }

  async function compare(base: string, head: string): Promise<"same" | "ahead" | "behind"> {
    if (base === head) return "same";
    const result = await get(`/compare/${base}...${head}?per_page=1`, comparison);
    if (result.status === "ahead" && result.merge_base_commit.sha === base) return "ahead";
    if (result.status === "behind" && result.merge_base_commit.sha === head) return "behind";
    throw new Error("Factory could not establish the order of accepted delivery commits.");
  }

  async function defaultHead(): Promise<string> {
    const repo = await get(
      "",
      z.object({ full_name: z.string(), default_branch: z.string().min(1) }),
    );
    if (!sameRepo(repo.full_name)) throw new Error("The delivery repository identity changed.");
    const branch = encodeURIComponent(repo.default_branch);
    const ref = await get(`/git/ref/heads/${branch}`, z.object({ ref: z.string(), object }));
    if (ref.ref !== `refs/heads/${repo.default_branch}`)
      throw new Error("GitHub returned a different delivery default branch.");
    return ref.object.sha;
  }

  async function releaseContent(intent: MergeIntent, commit: string) {
    const record = await get(`/pulls/${intent.number}`, pull);
    if (
      record.number !== intent.number ||
      record.merge_commit_sha !== commit ||
      record.head.sha !== intent.headSha ||
      !sameRepo(record.base.repo.full_name)
    )
      throw new Error("GitHub returned a different accepted Factory pull request.");
    return { pr: record.number, issue: intent.issue, title: record.title };
  }

  async function changedPaths(parent: string, commit: string): Promise<string[] | null> {
    const result = await get(
      `/compare/${parent}...${commit}?per_page=1`,
      comparison.extend({ files: z.array(changedPath) }),
    );
    if (
      result.status !== "ahead" ||
      result.merge_base_commit.sha !== parent ||
      result.files.length >= githubComparisonFileLimit
    )
      return null;
    const paths = new Set<string>();
    for (const entry of result.files) {
      if (paths.has(entry.filename) || (entry.status === "renamed" && !entry.previous_filename))
        return null;
      paths.add(entry.filename);
      if (entry.previous_filename) paths.add(entry.previous_filename);
    }
    return [...paths].sort();
  }

  async function firstParent(from: string, to: string) {
    const base = sha.parse(from);
    let current = sha.parse(to);
    const chain: { sha: string; paths: string[] }[] = [];
    while (current !== base && chain.length < firstParentLimit) {
      const exact = await get(`/git/commits/${current}`, commitRecord);
      const parent = exact.parents[0]?.sha;
      if (exact.sha !== current || !parent || parent === current) return null;
      const paths = await changedPaths(parent, current);
      if (!paths) return null;
      chain.push({ sha: current, paths });
      current = parent;
    }
    return current === base ? chain.toReversed() : null;
  }

  return { recipeAt, compare, defaultHead, releaseContent, firstParent };
}

/** The executor sees the shared authenticated client through this read-only branch adapter. */
export function createDeliveryBranchEvidence(
  github: FactoryGitHub,
  repository: string,
): DeliveryExecutorDeps["branch"] {
  const git = projectGitHub(github, repository);
  return { head: git.defaultHead, firstParent: git.firstParent };
}

async function batchCandidates(
  ledger: DeliveryInputLedger,
  betas: DeliveryRun[],
  git: ReturnType<typeof projectGitHub>,
  baseline: string,
) {
  const previous = ledger.releases.filter((event) => event.channel === "beta");
  const history = [...previous, ...betas];
  const seen = new Set(history.flatMap((run) => run.contents.map((entry) => entry.issue)));
  const handled = new Set(history.map((run) => run.commit));
  const candidates: { commit: string; intent: MergeIntent }[] = [];
  for (const [issueId, merge] of Object.entries(ledger.runtimeMerges ?? {})) {
    const issue = Number(issueId);
    if (!merge.settled || seen.has(issue) || handled.has(merge.mergeSha)) continue;
    sha.parse(merge.mergeSha);
    if ((await git.compare(baseline, merge.mergeSha)) !== "ahead") continue;
    const exact = Object.values(ledger.mergeIntents ?? {}).filter(
      (intent) => intent.issue === issue && intent.headSha === merge.head,
    );
    if (exact.length !== 1)
      throw new Error("The settled delivery commit has no unique merge intent.");
    candidates.push({ commit: merge.mergeSha, intent: exact[0]! });
  }
  return candidates;
}

async function nextBatch(
  ledger: DeliveryInputLedger,
  runs: DeliveryRun[],
  git: ReturnType<typeof projectGitHub>,
  baseline: string,
): Promise<BetaInput | null> {
  if (ledger.delivery.lock || runs.some((run) => !["delivered", "failed"].includes(run.state)))
    return null;
  const betas = runs.filter((run) => run.kind === "beta");
  const failed = failedBetaCommit(ledger, betas.at(-1));
  if (failed && (await git.compare(sha.parse(failed), baseline)) === "behind") return null;
  const candidates = await batchCandidates(ledger, betas, git, baseline);
  let tip = candidates[0]?.commit;
  if (!tip) return null;
  for (const next of candidates.slice(1)) {
    if ((await git.compare(tip, next.commit)) === "ahead") tip = next.commit;
  }
  if ((await git.compare(tip, await git.defaultHead())) === "behind")
    throw new Error("The accepted delivery batch is no longer on the default branch.");
  const { recipe, error } = await git.recipeAt(tip);
  if (error) throw new Error(error);
  if (!recipe || recipe.trigger.kind !== "every-batch") return null;
  const contents: BetaInput["contents"] = [];
  for (const candidate of candidates) {
    contents.push(await git.releaseContent(candidate.intent, candidate.commit));
  }
  return { commit: tip, number: null, note: null, contents };
}

function failedBetaCommit(ledger: LeanLedger, last?: DeliveryRun): string | null {
  if (last)
    return last.state === "failed" && last.failure?.kind !== "cancelled" ? last.commit : null;
  const historical = ledger.releases.findLast((event) => event.channel === "beta");
  return historical?.kind === "failed" ? historical.commit : null;
}

function deliveredBaseline(ledger: LeanLedger): string | null {
  const last = ledger.delivery.receipts.findLast((receipt) => receipt.outcome === "delivered");
  if (!last || !last.verification.trim() || !Number.isFinite(Date.parse(last.verifiedAt)))
    return null;
  return sha.safeParse(last.commits.at(-1)).data ?? null;
}

/** One registry per daemon bootstrap, including across project stop/start boundaries. */
export function createDeliveryRuntimeRegistry() {
  const passes = new Map<string, Promise<void>>();
  return (options: DeliveryRuntimeOptions) => {
    const { projectId, installation, repository, github, state, now, ports } = options;
    const git = projectGitHub(github, repository);
    let stopped = false;
    let resumed = false;
    let passEpoch: number | null = null;
    let queuingEpoch: number | null = null;

    async function fence(): Promise<number | null> {
      if (stopped || (ports.ready && !(await ports.ready()))) return null;
      const epoch = await options.laneEpoch("delivery");
      if (stopped || epoch === null || (passEpoch !== null && epoch !== passEpoch)) return null;
      return epoch;
    }
    async function requireEpoch(epoch?: number): Promise<number> {
      const current = await fence();
      if (stopped || current === null || (epoch !== undefined && current !== epoch))
        throw new DeliveryAuthorityLost("Factory lost live primary authority for delivery.");
      return current;
    }

    const fencedState: DeliveryExecutorDeps["state"] = {
      read: (id) => state.read(id),
      async mutate(id, change, revision) {
        await requireEpoch();
        if (queuingEpoch !== null && (await options.laneEpoch("releaseBuild")) !== queuingEpoch)
          throw new DeliveryAuthorityLost(
            "Factory lost live release-build authority before queuing beta.",
          );
        return state.mutate(
          id,
          (ledger) => {
            if (stopped) throw new DeliveryAuthorityLost("The Factory project stopped.");
            return change(ledger);
          },
          revision,
        );
      },
    };
    const adapters: DeliveryExecutorDeps["adapters"] = {};
    for (const where of ["host", "container"] as const) {
      const adapter = ports.adapters[where];
      if (!adapter) continue;
      adapters[where] = {
        async run(request) {
          const epoch = await requireEpoch();
          return adapter.run({
            ...request,
            async authorizeLaunch() {
              try {
                await requireEpoch(epoch);
                return (await request.authorizeLaunch()) && !stopped;
              } catch (error) {
                if (error instanceof DeliveryAuthorityLost) return false;
                throw error;
              }
            },
          });
        },
      };
    }
    const lifecycle = ports.lifecycle;
    const executor = createDeliveryExecutor({
      ...ports,
      projectId,
      installation,
      state: fencedState,
      adapters,
      branch: { head: git.defaultHead, firstParent: git.firstParent },
      async authorizeSideEffect({ kind, runId, expectedHead }) {
        try {
          const epoch = await requireEpoch();
          if (kind === "tags-push") {
            const run = (await state.read(projectId)).delivery.runs?.[runId];
            if (
              expectedHead !== null ||
              run?.kind !== "promote" ||
              !run.approval ||
              run.state !== "verifying" ||
              run.receipts.verify?.status !== "succeeded"
            )
              return false;
          } else if (expectedHead === null || (await git.defaultHead()) !== expectedHead)
            return false;
          await requireEpoch(epoch);
          return true;
        } catch (error) {
          if (error instanceof DeliveryAuthorityLost) return false;
          throw error;
        }
      },
      lifecycle: lifecycle && {
        async request(input) {
          await requireEpoch();
          return lifecycle.request(input);
        },
        status: (id) => lifecycle.status(id),
      },
      recipeAt: git.recipeAt,
      async hostGate(commit) {
        return ports.hostGate(commit, await options.readBaseline());
      },
      fence,
      now,
      async notify(notice) {
        await requireEpoch();
        return ports.notify(notice);
      },
    });

    async function baseline(): Promise<string | null> {
      const saved: DeliveryWaitLedger = await state.read(projectId);
      const delivered = deliveredBaseline(saved);
      const configured = sha.nullable().parse(await options.readBaseline());
      let checkpoint = delivered ?? configured;
      if (delivered && configured && (await git.compare(delivered, configured)) === "ahead")
        checkpoint = configured;
      if (!checkpoint) await recordWait(missingBaseline);
      else if (saved.delivery.waitingOn === missingBaseline) await recordWait();
      return checkpoint;
    }

    async function recordWait(waiting?: string, commit?: string): Promise<void> {
      const ledger: DeliveryWaitLedger = await state.read(projectId);
      if (ledger.delivery.waitingOn === waiting && ledger.delivery.waitingForCommit === commit)
        return;
      await fencedState.mutate(projectId, (data: DeliveryWaitLedger) => {
        if (waiting) data.delivery.waitingOn = waiting;
        else delete data.delivery.waitingOn;
        if (commit) data.delivery.waitingForCommit = commit;
        else delete data.delivery.waitingForCommit;
      });
      if (waiting) options.onError(new Error(waiting));
    }

    async function verifyHistory(commit: string): Promise<boolean> {
      const gate = await ports.hostGate(commit, await options.readBaseline());
      const verified =
        gate?.commit === commit &&
        [gate.trust, gate.verdict, gate.ownerOnly].every(
          (check) => check.passed && check.sha === commit,
        );
      await recordWait(
        verified
          ? undefined
          : (gate?.reason ??
              `Factory could not verify delivery history for ${commit.slice(0, 12)}.`),
        verified ? undefined : commit,
      );
      return verified;
    }

    async function queueNext(): Promise<void> {
      const releaseEpoch = await options.laneEpoch("releaseBuild");
      if (stopped || releaseEpoch === null) return;
      const checkpoint = await baseline();
      if (!checkpoint) return;
      const ledger: DeliveryWaitLedger = await state.read(projectId);
      const blockedCommit = ledger.delivery.waitingForCommit;
      if (blockedCommit && (await git.compare(checkpoint, blockedCommit)) !== "ahead") {
        if (!(await verifyHistory(checkpoint))) return;
      }
      const batch = await nextBatch(ledger, await executor.list(), git, checkpoint);
      if (!batch || stopped || (await options.laneEpoch("releaseBuild")) !== releaseEpoch) return;
      if (!(await verifyHistory(batch.commit))) return;
      await requireEpoch();
      queuingEpoch = releaseEpoch;
      try {
        const result = await executor.queueBeta(batch);
        if ("refused" in result) throw new Error(result.refused);
      } finally {
        queuingEpoch = null;
      }
    }

    async function pass(): Promise<void> {
      const epoch = await fence();
      if (epoch === null || stopped) return;
      passEpoch = epoch;
      if (!resumed) {
        await executor.resume();
        resumed = true;
      }
      if (!(await baseline())) return;
      const pending = (await executor.snapshot()).pendingBeta;
      if (pending && !(await verifyHistory(pending.commit))) return;
      try {
        await executor.advance();
      } catch (error) {
        // A port can fail after a start receipt. The next pass must recover first.
        resumed = false;
        throw error;
      }
      await queueNext();
    }

    return {
      /** Deliberately nonblocking: a long step cannot stall the issue loop or watchdog. */
      tick(): void {
        if (stopped || passes.has(projectId)) return;
        const pending = Promise.resolve()
          .then(pass)
          .catch((error: unknown) => {
            if (!(error instanceof DeliveryAuthorityLost)) options.onError(error);
          })
          .finally(() => {
            passEpoch = null;
            passes.delete(projectId);
          });
        passes.set(projectId, pending);
      },
      stop(): void {
        stopped = true;
      },
    };
  };
}
