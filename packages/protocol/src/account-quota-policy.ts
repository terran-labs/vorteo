import { z } from "zod";

/**
 * Account quota policy: per-account pool membership and the share of quota each priority must
 * leave unused. Storage only. Nothing admits, launches, switches or pauses agents from it yet;
 * see docs/vorteo-customizations.md. Not to be confused with the schedule quota governor's
 * `quotaPolicy`.
 *
 * Two shapes. The wire and persisted shape checks only that the policy is an object with a
 * numeric `version`, so a later version or a non-number entry still loads and stays readable to
 * clients. A missing or non-number `version`, or an array or null as the policy, fails that
 * check and stops a daemon from starting, like any other invalid config entry. A daemon accepts
 * a patch only in the strict, bounded version 1 shape below, before writing anything; readers
 * treat any other version, or a version 1 policy that fails that shape, as unusable.
 */

export const ACCOUNT_QUOTA_POLICY_VERSION = 1;

/** Priorities the built-in ladder covers. Stored policies may name others. */
export const QUOTA_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type QuotaPriority = (typeof QUOTA_PRIORITIES)[number];

/** Percent of every usage window that must remain, owner-confirmed on 2026-11-19 (#518). */
export const BUILT_IN_QUOTA_FLOORS: Readonly<Record<QuotaPriority, number>> = {
  low: 50,
  normal: 25,
  high: 10,
  urgent: 0,
};

export const AccountQuotaPolicyWireSchema = z.object({ version: z.number() }).passthrough();
export type AccountQuotaPolicyWire = z.infer<typeof AccountQuotaPolicyWireSchema>;

/*
 * Patch limits. An installation has a handful of accounts and the ladder has four levels, so
 * these leave generous room while keeping the policy small enough to ride in every config
 * response: at most about 64 * 16 floor entries.
 */
export const ACCOUNT_QUOTA_POLICY_MAX_ACCOUNTS = 64;
export const ACCOUNT_QUOTA_POLICY_MAX_PRIORITIES = 16;

/**
 * Exactly what `installationProviderReference` produces: `installation-account/<uuid>`, with
 * hex in either case as the installation account id schema allows, or a local provider id,
 * which provider config restricts to `^[a-z][a-z0-9-]*$` (capped here at 64).
 */
const AccountRefSchema = z
  .string()
  .regex(
    /^(?:installation-account\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[a-z][a-z0-9-]{0,63})$/u,
  );
/** Lowercase names such as `normal`; room for later levels without free-form text. */
const PriorityNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);
const FloorSchema = z.number().finite().min(0).max(100);

const boundedRecord = <K extends z.ZodString, V extends z.ZodType>(key: K, value: V, max: number) =>
  z
    .record(key, value)
    .refine((record) => Object.keys(record).length <= max, `at most ${max} entries`);

const FloorsV1Schema = boundedRecord(
  PriorityNameSchema,
  FloorSchema,
  ACCOUNT_QUOTA_POLICY_MAX_PRIORITIES,
);

/**
 * The only shape a daemon stores. Strict: an unknown field is refused, not dropped, so a newer
 * client never loses data silently. A new field therefore requires a new version.
 */
export const AccountQuotaPolicyV1Schema = z.strictObject({
  version: z.literal(ACCOUNT_QUOTA_POLICY_VERSION),
  ladder: FloorsV1Schema,
  accounts: boundedRecord(
    AccountRefSchema,
    z.strictObject({ pool: z.boolean().optional(), floors: FloorsV1Schema.optional() }),
    ACCOUNT_QUOTA_POLICY_MAX_ACCOUNTS,
  ),
});
export type AccountQuotaPolicy = z.infer<typeof AccountQuotaPolicyV1Schema>;

/** Checks a patched policy; throws a readable error, so the caller refuses before writing. */
export function parseAccountQuotaPolicyPatch(value: unknown): AccountQuotaPolicy {
  const parsed = AccountQuotaPolicyV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`);
  throw new Error(`Invalid account quota policy: ${problems.join("; ")}`);
}
