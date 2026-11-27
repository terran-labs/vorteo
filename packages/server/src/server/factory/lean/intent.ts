import { randomUUID } from "node:crypto";
import { matchesGlob } from "node:path";
import type { IntentStore, LeanStateStore } from "./types.js";

export function createIntentStore(
  projectId: string,
  state: LeanStateStore,
  now: () => Date = () => new Date(),
): IntentStore {
  return {
    async setIntent(record) {
      await state.mutate(projectId, (ledger) => {
        ledger.intent[record.issue] = {
          ...record,
          quotes: [...record.quotes],
          updatedAt: now().toISOString(),
        };
      });
    },
    async addRule(rule) {
      if (rule.scope !== "all" && !/^(label|path):.+$/.test(rule.scope)) {
        throw new Error("Use all, label:<name>, or path:<glob> for the rule scope.");
      }
      const added = { ...rule, id: randomUUID(), addedAt: now().toISOString() };
      await state.mutate(projectId, (ledger) => {
        ledger.rules.push(added);
      });
      return added;
    },
    async removeRule(id) {
      return state.mutate(projectId, (ledger) => {
        const index = ledger.rules.findIndex((rule) => rule.id === id);
        if (index < 0) return false;
        ledger.rules.splice(index, 1);
        return true;
      });
    },
    async rulesFor({ labels, paths }) {
      const { rules } = await state.read(projectId);
      return rules.filter(({ scope }) => {
        if (scope === "all") return true;
        if (scope.startsWith("label:")) return labels.includes(scope.slice(6));
        return scope.startsWith("path:") && paths.some((path) => matchesGlob(path, scope.slice(5)));
      });
    },
  };
}
