import { isDeepStrictEqual } from "node:util";
import type { MergeGateDeps, MergeIntent } from "./merge-gate.js";
import type { LeanLedger, LeanStateStore } from "./types.js";

interface IntentLedger extends LeanLedger {
  mergeIntents?: Record<string, MergeIntent>;
}

function key(target: Pick<MergeIntent, "issue" | "number" | "headSha">): string {
  return JSON.stringify([target.issue, target.number, target.headSha]);
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
      const snapshot = await state.read(projectId);
      if (!(await fence(epoch))) return { done: false, reason: "The merge lane moved." };
      return state.mutate(
        projectId,
        (ledger: IntentLedger) => {
          const intents = (ledger.mergeIntents ??= {});
          const id = key(intent);
          if (intents[id] && !isDeepStrictEqual(intents[id], intent)) {
            return {
              done: false as const,
              reason: "A different approval was recorded for this merge.",
            };
          }
          intents[id] = intent;
          return { done: true as const };
        },
        snapshot.revision,
      );
    },
  };
}
