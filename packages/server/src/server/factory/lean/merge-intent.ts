import { isDeepStrictEqual } from "node:util";
import type { MergeGateDeps, MergeIntent } from "./merge-gate.js";
import type { LeanLedger, LeanStateStore } from "./types.js";

interface IntentLedger extends LeanLedger {
  mergeIntents?: Record<string, MergeIntent>;
}

function key(target: Pick<MergeIntent, "issue" | "number" | "headSha">): string {
  return JSON.stringify([target.issue, target.number, target.headSha]);
}

function sameIntent(saved: MergeIntent, candidate: MergeIntent): boolean {
  if (isDeepStrictEqual(saved, candidate)) return true;
  if (
    saved.approval.reviewPolicy ||
    saved.approval.foreignReview ||
    candidate.approval.foreignReview
  )
    return false;
  const { reviewPolicy: _policy, ...approval } = candidate.approval;
  return isDeepStrictEqual(saved, { ...candidate, approval });
}

export function createMergeIntentStore(
  state: LeanStateStore,
  projectId: string,
  fence: MergeGateDeps["fenceMerge"],
): Pick<MergeGateDeps, "readIntent" | "recordIntent"> {
  return {
    async readIntent(target) {
      const ledger: IntentLedger = await state.read(projectId);
      return ledger.mergeIntents?.[key(target)] ?? null;
    },
    async recordIntent(intent, epoch) {
      const approval = structuredClone(intent);
      const snapshot = await state.read(projectId);
      if (!(await fence(epoch))) return { done: false, reason: "The merge lane moved." };
      return state.mutate(
        projectId,
        (ledger: IntentLedger) => {
          const intents = (ledger.mergeIntents ??= {});
          const id = key(approval);
          const existing = intents[id];
          if (existing && !sameIntent(existing, approval)) {
            return {
              done: false as const,
              reason: "A different approval was recorded for this merge.",
            };
          }
          intents[id] = existing ?? approval;
          return { done: true as const };
        },
        snapshot.revision,
      );
    },
  };
}
