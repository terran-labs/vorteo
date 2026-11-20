import { z } from "zod";

/**
 * Quota policy: per-account pool membership and the share of quota each priority must leave
 * unused. Storage only. Nothing admits, launches, switches or pauses agents from it yet; see
 * docs/vorteo-customizations.md.
 *
 * The wire shape stays permissive on purpose. Priority names are plain strings and percentages
 * are plain numbers, so a later priority level or a hand-edited value never makes a daemon
 * config unreadable. `quotaPolicyProblems` checks values when a daemon accepts a patch, and the
 * floor evaluator treats anything it cannot use as unresolved.
 */

export const QUOTA_POLICY_VERSION = 1;

/** Priorities the built-in ladder covers. The wire accepts any string. */
export const QUOTA_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type QuotaPriority = (typeof QUOTA_PRIORITIES)[number];

/** Percent of every usage window that must remain, owner-confirmed on 2026-11-19 (#518). */
export const BUILT_IN_QUOTA_FLOORS: Readonly<Record<QuotaPriority, number>> = {
  low: 50,
  normal: 25,
  high: 10,
  urgent: 0,
};

const FloorsSchema = z.record(z.string(), z.number());

export const QuotaPolicyAccountSchema = z
  .object({
    /** Absent means the owner has not said; consumers must not guess. */
    pool: z.boolean().optional(),
    floors: FloorsSchema.optional(),
  })
  .passthrough();
export type QuotaPolicyAccount = z.infer<typeof QuotaPolicyAccountSchema>;

export const QuotaPolicySchema = z
  .object({
    version: z.literal(QUOTA_POLICY_VERSION),
    ladder: FloorsSchema,
    /**
     * Keyed by `installationProviderReference`: `installation-account/<id>` for an installation
     * account, so every local alias of one account shares a row, or the local provider id.
     */
    accounts: z.record(z.string(), QuotaPolicyAccountSchema),
  })
  .passthrough();
export type QuotaPolicy = z.infer<typeof QuotaPolicySchema>;

/** A floor is a finite percentage from 0 to 100. */
export function isQuotaFloor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** Problems that make a daemon refuse a quota policy patch. Empty means acceptable. */
export function quotaPolicyProblems(policy: QuotaPolicy): string[] {
  const problems: string[] = [];
  const check = (floors: Record<string, number> | undefined, where: string) => {
    for (const [priority, value] of Object.entries(floors ?? {})) {
      if (priority.length === 0) problems.push(`${where} has an empty priority name`);
      else if (!isQuotaFloor(value))
        problems.push(`${where}.${priority} must be a percentage from 0 to 100`);
    }
  };
  check(policy.ladder, "ladder");
  for (const [reference, account] of Object.entries(policy.accounts)) {
    if (reference.length === 0) problems.push("accounts has an empty account reference");
    check(account.floors, `accounts[${reference}].floors`);
  }
  return problems;
}
