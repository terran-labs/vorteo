import { plan } from "./dispatcher.js";
import { deriveStages } from "./issue-state.js";
import type {
  DispatchAction,
  DispatchContext,
  GitHubFacts,
  LeanStateStore,
  MergeGate,
} from "./types.js";

export interface LeanReconcilePorts {
  projectId: string;
  state: LeanStateStore;
  facts(): Promise<GitHubFacts>;
  context(): Promise<DispatchContext>;
  mergeGate: MergeGate;
  execute(action: Exclude<DispatchAction, { kind: "merge" }>): Promise<void>;
  recordMerge(issue: number, head: string, mergeSha: string): Promise<void>;
  now(): Date;
}

/** Re-read facts after each action. A concurrent wake gets another pass after the current one. */
export function createLeanReconciler(ports: LeanReconcilePorts) {
  let tail = Promise.resolve();
  async function pass(): Promise<void> {
    const [facts, ledger, context] = await Promise.all([
      ports.facts(),
      ports.state.read(ports.projectId),
      ports.context(),
    ]);
    const stages = deriveStages(facts, ledger, context.here);
    for (const action of plan(stages, ledger, context)) {
      if (action.kind === "merge") {
        const gate = await ports.mergeGate.evaluate(action.issue);
        if (
          !gate.ready ||
          gate.pr.number !== action.pr.number ||
          gate.pr.headSha !== action.pr.headSha
        )
          continue;
        const result = await ports.mergeGate.merge(
          action.issue,
          gate.pr,
          gate.verdict,
          gate.acceptance,
        );
        if ("refused" in result) continue;
        await ports.recordMerge(action.issue, gate.pr.headSha, result.mergeSha);
      } else {
        await ports.execute(action);
      }
      break;
    }
    await ports.state.mutate(ports.projectId, (current) => {
      current.loopBeat = ports.now().toISOString();
    });
  }
  return {
    reconcile(): Promise<void> {
      const result = tail.then(pass);
      tail = result.catch(() => {});
      return result;
    },
  };
}
