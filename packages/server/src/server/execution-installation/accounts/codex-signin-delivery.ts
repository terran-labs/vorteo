import { createHash } from "node:crypto";
import { z } from "zod";
import {
  HostProjectionService,
  ProjectionBindingRequestSchema,
  ProjectionReceiptSchema,
  projectionDeliverySchema,
  type HostProjectionPorts,
} from "./host-owned-projection.js";

/**
 * Host-owned Codex sign-in: the Host account's own CODEX_HOME keeps the only refresh grant and
 * the official Host Codex is its only refresh writer. Dev receives access-only projections in
 * its account's `auth.json`. Codex reloads that file before it tries a refresh after a rejected
 * request, so a newer projection reaches running Dev agents without a Dev refresh.
 *
 * Strict: a `refreshToken` field fails validation and the delivery is refused.
 */
export const CodexAccessProjectionSchema = z.strictObject({
  accessToken: z.string().min(1).max(65536),
  /** Codex reads the plan and account from this JWT; it is not a refresh credential. */
  idToken: z.string().min(1).max(65536),
  accountId: z.string().min(1).max(256).nullable(),
  /** The access token's own expiry, in milliseconds. */
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** The Host's `last_refresh`, copied so Dev never believes its copy is newer. */
  lastRefresh: z.string().datetime({ offset: true }).nullable(),
});
export type CodexAccessProjection = z.infer<typeof CodexAccessProjectionSchema>;

/** Daemon routes, behind daemon bearer authentication. */
export const CODEX_SIGNIN_BINDING_ROUTE = "/api/installation/codex/signin/binding";
export const CODEX_SIGNIN_PROJECTION_ROUTE = "/api/installation/codex/signin/projection";
/** Host only, behind `codexAccountAdoption`: a short lease for one coordinator refresh. */
export const CODEX_SIGNIN_LEASE_ROUTE = "/api/installation/codex/signin/lease";

export const CodexSignInBindingRequestSchema = ProjectionBindingRequestSchema.extend({
  /**
   * An adopted legacy definition (an `accountId`, no `accountSetup`): the requested binding must
   * already be the definition's managed Host binding for that same account. Requires
   * `codexAccountAdoption`; older daemons refuse the unknown field.
   */
  legacy: z.literal(true).optional(),
});
export type CodexSignInBindingRequest = z.infer<typeof CodexSignInBindingRequestSchema>;
/** The binding's exact CODEX_HOME on the Host. Never a credential. */
export const CodexSignInBindingResponseSchema = z.strictObject({
  providerId: z.string().min(1),
  codexHome: z.string().startsWith("/"),
});

export const CodexSignInLeaseRequestSchema = z.discriminatedUnion("operation", [
  CodexSignInBindingRequestSchema.extend({ operation: z.literal("acquire") }),
  CodexSignInBindingRequestSchema.extend({
    operation: z.literal("release"),
    leaseId: z.string().uuid(),
  }),
]);
export type CodexSignInLeaseRequest = z.infer<typeof CodexSignInLeaseRequestSchema>;
/** `granted: false` while a Host session on the account starts or runs a turn, or another lease is held. */
export const CodexSignInLeaseResponseSchema = z.discriminatedUnion("granted", [
  z.strictObject({
    granted: z.literal(true),
    leaseId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
    /** A Host session on the account is loaded but idle. */
    loaded: z.boolean(),
  }),
  z.strictObject({ granted: z.literal(false) }),
]);

/**
 * Dev only, behind `codexAccountAdoption`: pinning and restoring an adopted legacy home. The
 * `inspect` operation and the restore's `persons` need `codexLegacyPinByPath`.
 */
export const CODEX_SIGNIN_LEGACY_ROUTE = "/api/installation/codex/signin/legacy";

/**
 * An adopted legacy home, as Dev reported it when the owner adopted the account: its real path
 * and the directory's device and inode, as decimal strings because they can exceed 2^53. Dev
 * daemons with `codexLegacyPinByPath` identify the home by its real path alone, because inode
 * numbers on a virtiofs mount change without any change to the directory; they still report
 * the device and inode, which older daemons require.
 */
export const CodexLegacyTargetSchema = z.strictObject({
  realpath: z.string().startsWith("/").max(4096),
  dev: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  ino: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
});
export type CodexLegacyTarget = z.infer<typeof CodexLegacyTargetSchema>;

/** SHA-256 of a sign-in's ChatGPT workspace and person; see codexSignInKeyDigest. */
const PersonDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const Hmac = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * The Host sign-in's login session under a single-use nonce: HMAC-SHA256 of the person with the
 * session ID, and with the authentication time, each present only when the ID token names it.
 * Never a token or a claim. See codexOtherSession for the rule.
 */
export const CodexSessionCheckSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sid: Hmac.optional(),
  authTime: Hmac.optional(),
});

export type CodexSessionCheck = z.infer<typeof CodexSessionCheckSchema>;

export const CodexSignInLegacyRequestSchema = z.discriminatedUnion("operation", [
  ProjectionBindingRequestSchema.extend({ operation: z.literal("pin") }),
  /** Whether a Codex session runs, or is being started, on this provider ID. */
  ProjectionBindingRequestSchema.extend({ operation: z.literal("sessions") }),
  /**
   * Requires `codexLegacySessionHold`, for an early refusal the owner can act on: whether the
   * home's refresh sign-in is certainly another login session than the Host's, and the threads
   * on the home that start or run a turn. The write decides again by itself.
   */
  ProjectionBindingRequestSchema.extend({
    operation: z.literal("session-check"),
    sessionCheck: CodexSessionCheckSchema.optional(),
  }),
  /** Puts the saved local sign-in back as `auth.json`, after the projection is withdrawn. */
  ProjectionBindingRequestSchema.extend({
    operation: z.literal("restore"),
    target: CodexLegacyTargetSchema,
    /**
     * Requires `codexLegacyPinByPath`: the people the saved sign-in may belong to. Dev restores
     * nothing for anyone else. Older daemons refuse the unknown field.
     */
    persons: z.array(PersonDigestSchema).max(4).optional(),
  }),
  /**
   * Requires `codexLegacyPinByPath`: pins the home as `pin` does and says what its `auth.json`
   * holds, so the coordinator can resume a paused adoption without asking the owner.
   */
  ProjectionBindingRequestSchema.extend({ operation: z.literal("inspect") }),
  /** Deletes the saved local sign-in when its retention ends. */
  ProjectionBindingRequestSchema.extend({
    operation: z.literal("forget-copy"),
    target: CodexLegacyTargetSchema,
  }),
]);
export type CodexSignInLegacyRequest = z.infer<typeof CodexSignInLegacyRequestSchema>;
export const CodexLegacyPinResponseSchema = z.strictObject({ target: CodexLegacyTargetSchema });
/**
 * `projection`: a projection written for this definition; `none`: no `auth.json`; `other`:
 * anything else, such as a sign-in made in Dev or another account's projection.
 */
export const CodexLegacyInspectResponseSchema = z.strictObject({
  target: CodexLegacyTargetSchema,
  signIn: z.enum(["projection", "none", "other"]),
});
export type CodexLegacyInspection = z.infer<typeof CodexLegacyInspectResponseSchema>;
export const CodexLegacySessionsResponseSchema = z.strictObject({ active: z.boolean() });
/** Busy threads' titles, plain text: at most three, with how many more are busy. Never IDs. */
export const CODEX_BUSY_TITLE_MAX = 80;
export const CodexLegacyBusyResponseSchema = z.strictObject({
  active: z.boolean(),
  titles: z
    .array(
      z
        .string()
        .min(1)
        .max(CODEX_BUSY_TITLE_MAX)
        .regex(/^[^\p{Cc}\u2028\u2029]+$/u),
    )
    .max(3),
  more: z.number().int().nonnegative(),
});
export type CodexLegacyBusy = z.infer<typeof CodexLegacyBusyResponseSchema>;
/** `different`: Dev holds no sign-in that could renew the Host's grant. */
export const CodexLegacySessionCheckResponseSchema = CodexLegacyBusyResponseSchema.extend({
  different: z.boolean(),
});
export const CodexLegacyRestoreResponseSchema = z.discriminatedUnion("restored", [
  z.strictObject({ restored: z.literal(false) }),
  z.strictObject({ restored: z.literal(true), copyAgeMs: z.number().int().nonnegative() }),
]);
export const CodexLegacyForgetResponseSchema = z.strictObject({ forgotten: z.literal(true) });

export const CodexSignInProjectionDeliverySchema = projectionDeliverySchema(
  CodexAccessProjectionSchema,
).extend({
  /**
   * Present only for an adopted legacy binding, which keeps its own CODEX_HOME. Dev refuses the
   * delivery unless that home is still the pinned target: by real path on daemons with
   * `codexLegacyPinByPath`, by real path, device and inode on older ones. Older daemons refuse it.
   */
  adoption: z
    .strictObject({
      target: CodexLegacyTargetSchema,
      /** Save the local sign-in this projection replaces, so un-adopt can restore it. */
      keepLocalSignIn: z.boolean(),
      /**
       * Requires `codexLegacySessionHold`: the Host sign-in's login session, with a nonce new
       * for this delivery. Dev replaces a refresh sign-in without holding its sessions only when
       * this shows it is another login session; absent means hold. Older daemons refuse it.
       */
      sessionCheck: CodexSessionCheckSchema.optional(),
    })
    .optional(),
});
export type CodexSignInProjectionDelivery = z.infer<typeof CodexSignInProjectionDeliverySchema>;
export const CodexSignInProjectionReceiptSchema = ProjectionReceiptSchema.extend({
  /** Only for an adopted legacy home: Dev had written a sign-in there since the last delivery. */
  replacedLocally: z.literal(true).optional(),
});
export type CodexSignInProjectionReceipt = z.infer<typeof CodexSignInProjectionReceiptSchema>;

export class CodexSignInDeliveryError extends Error {
  constructor() {
    super("Codex sign-in synchronization is pending. Retry after reconnecting the environment.");
  }
}

/** A daemon answered and refused, as opposed to being unreachable. Carries a fixed code only. */
export class CodexSignInRefused extends CodexSignInDeliveryError {
  constructor(readonly reason: "target_changed" | "existing_sign_in" | null) {
    super();
  }
}

/** Reads the fixed refusal code from a 409 body; anything else is no code. */
export function codexRefusalReason(body: unknown): CodexSignInRefused["reason"] {
  const parsed = z
    .object({ reason: z.enum(["target_changed", "existing_sign_in"]) })
    .safeParse(body);
  return parsed.success ? parsed.data.reason : null;
}

/** Key order is fixed so the coordinator and Dev compute the same digest. */
export function codexProjectionDigest(access: CodexAccessProjection | null): string {
  const canonical = access && {
    accessToken: access.accessToken,
    idToken: access.idToken,
    accountId: access.accountId,
    expiresAt: access.expiresAt,
    lastRefresh: access.lastRefresh,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** One serialized writer per Dev binding. Its journal holds digests, never tokens. */
export class CodexSignInProjectionService extends HostProjectionService<
  CodexAccessProjection,
  CodexSignInProjectionDelivery
> {
  constructor(ports: HostProjectionPorts<CodexAccessProjection, CodexSignInProjectionDelivery>) {
    super(ports, {
      schema: CodexSignInProjectionDeliverySchema,
      digest: codexProjectionDigest,
      error: () => new CodexSignInDeliveryError(),
    });
  }
}
