import { isProviderSelectable, isProviderDetecting } from "./provider-availability";
import {
  resolveProviderType,
  isSharedWorkflowProfile,
  type ProviderAncestry,
} from "@getpaseo/protocol/provider-preferences";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { AgentProfilePickerRow } from "./internal/use-agent-profile-picker";
import { resolveProviderLabel } from "@/utils/provider-definitions";

const accountOrder = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export interface AccountPresets {
  provider: string;
  label: string;
  rows: AgentProfilePickerRow[];
}

export function accountPresets(input: {
  rows: AgentProfilePickerRow[];
  definitions: readonly AgentProfile[];
  entries: ProviderSnapshotEntry[] | undefined;
  query: string;
  providers?: Readonly<Record<string, ProviderAncestry>>;
  accountIndependent?: boolean;
  currentProvider?: string;
}): AccountPresets[] {
  const groups = new Map<string, AccountPresets>();
  const rows = input.accountIndependent
    ? (input.entries ?? []).filter(isProviderSelectable).flatMap((entry) => {
        const type = resolveProviderType(entry.provider, input.providers ?? {});
        return input.rows
          .filter((row) =>
            isSharedWorkflowProfile(row.id)
              ? row.provider === type
              : row.provider === entry.provider,
          )
          .map((row) =>
            Object.assign({}, row, {
              provider: entry.provider,
              unavailable: entry.status !== "ready",
              localEndpoint: entry.models?.find((model) => model.id === row.modelId)?.localEndpoint,
            }),
          );
      })
    : input.rows.filter((row) => {
        const entry = input.entries?.find((item) => item.provider === row.provider);
        return !entry || isProviderSelectable(entry);
      });
  for (const row of rows) {
    let group = groups.get(row.provider);
    if (!group) {
      group = {
        provider: row.provider,
        label: resolveProviderLabel(row.provider, input.entries),
        rows: [],
      };
      groups.set(row.provider, group);
    }
    group.rows.push(row);
  }
  // Accounts exist independently of saved profiles, including on a fresh install.
  for (const entry of input.entries ?? []) {
    if (
      isProviderSelectable(entry) &&
      (!isProviderDetecting(entry) || entry.provider === input.currentProvider) &&
      !groups.has(entry.provider)
    ) {
      groups.set(entry.provider, {
        provider: entry.provider,
        label: resolveProviderLabel(entry.provider, input.entries),
        rows: [],
      });
    }
  }
  const query = input.query.trim().toLowerCase();
  // Daemons register the same accounts in different orders. Display names provide
  // a shared ordering even when environment-local provider IDs differ.
  const orderedGroups = [...groups.values()].sort(
    (left, right) =>
      accountOrder.compare(left.label, right.label) ||
      accountOrder.compare(left.provider, right.provider),
  );
  return orderedGroups.filter((group) => {
    const models = input.entries?.find((entry) => entry.provider === group.provider)?.models;
    const catalogTerms =
      group.provider === "pi" ? (models?.map((model) => `${model.label} ${model.id}`) ?? []) : [];
    const searchable = [
      group.label,
      ...catalogTerms,
      ...group.rows.map((row) => {
        const definition = input.definitions.find((profile) => profile.id === row.id);
        return `${row.name} ${row.summary} ${definition?.nickname ?? ""}`;
      }),
    ].join(" ");
    return searchable.toLowerCase().includes(query);
  });
}

export function intelligenceLabel(
  profile: AgentProfile | undefined,
  entry: ProviderSnapshotEntry | undefined,
): string {
  const id = profile?.thinkingOptionId;
  if (!id) return "Provider default";
  const model = entry?.models?.find((candidate) => candidate.id === profile.model);
  return (
    model?.thinkingOptions?.find((option) => option.id === id)?.label ??
    id.charAt(0).toUpperCase() + id.slice(1)
  );
}
