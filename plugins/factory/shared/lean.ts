import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Lean Factory wire contracts: the repository configuration file, release records and the
 * `factory.lean.*` RPCs. Contracts only; no daemon serves these until the lean mode ships and
 * advertises `factoryLean`. Design: docs in the lean architecture (W1 contracts, Nov 27).
 *
 * Compatibility rules for this file (docs/protocol-compatibility.md):
 * - Every field added later is optional; nothing here is removed or narrowed once released.
 * - Output fields whose set of values will grow (stages, event kinds, outcomes) are strings,
 *   documented with their current values, so an older client never fails to parse a newer
 *   daemon. Inputs use enums, so a daemon refuses what it does not understand.
 * - Schemas are pure: no transforms or defaults that change values on the wire.
 */

const projectId = z.string().min(1);
/** `<serverId>/<projectId>`, the non-secret name `vorteo factory project show` prints. */
export const InstallationSchema = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/, "Use <serverId>/<projectId>.");
const sha = z.string().regex(/^[0-9a-f]{40}$/, "Use a full commit SHA.");
const iso = z.string().min(1);

export const FACTORY_MODES = ["crew", "lean"] as const;
export const FactoryModeSchema = z.enum(FACTORY_MODES);
export const FACTORY_LANES = ["intake", "merge", "delivery", "releaseBuild", "mechanic"] as const;
export const FactoryLaneSchema = z.enum(FACTORY_LANES);

/** Lean ledger protocol. A peer whose lease or presence carries a higher major stops dispatch. */
export const LEAN_PROTOCOL = 1;

// ---------------------------------------------------------------------------------------------
// Repository configuration: `.github/vorteo-factory.json`
// ---------------------------------------------------------------------------------------------

/** Path of the unified configuration on the default branch. Owner-only; never merged by Factory. */
export const FACTORY_CONFIG_PATH = ".github/vorteo-factory.json";
/** The newest configuration major this release understands. */
export const FACTORY_CONFIG_VERSION = 1;

/**
 * One installation; an ordered preference list; or the object form, whose `pinned` marks a
 * machine-bound lane (an install onto one machine) that never moves to another holder.
 */
const laneHolders = z.union([
  InstallationSchema,
  z.array(InstallationSchema).min(1),
  z.looseObject({ holders: z.array(InstallationSchema).min(1), pinned: z.boolean().optional() }),
]);

const gateRef = z.looseObject({
  where: z.enum(["container", "host"]).optional(),
  name: z.string().min(1),
  /** A command the delivery runner runs, or */
  run: z.string().min(1).optional(),
  /** a GitHub check name that must pass on the commit. */
  check: z.string().min(1).optional(),
  /** Runs through the machine's heavy-job queue. */
  heavy: z.boolean().optional(),
});
/** A recipe step: a command, or an installation lifecycle request (Vorteo source installs). */
const releaseLocation = z.enum(["container", "host"]).optional();
const releaseStep = z.union([
  z.looseObject({ run: z.string().min(1), where: releaseLocation }),
  z.looseObject({ lifecycle: z.literal("host-source-update") }),
]);

/**
 * The executor passes values in the environment. VORTEO_RELEASE_ variables include VERSION,
 * COMMIT, ARTIFACT, PREVIOUS_VERSION, TARGET_VERSION, NUMBER, NOTE, APPROVAL and TARGET.
 */
export const ReleaseRecipeV1Schema = z.looseObject({
  channels: z.looseObject({
    beta: z.looseObject({
      tag: z.string().min(1),
      noticeMinutes: z.number().nonnegative().optional(),
    }),
    stable: z.looseObject({ tag: z.string().min(1) }),
  }),
  /**
   * What must be identical between a beta and its promotion: the source commit (installs
   * built from source, CI-signed builds) or a frozen artifact (Syn3h's fingerprinted builds).
   */
  identity: z.enum(["commit", "artifact"]),
  /** Prints the next version; absent when the prepare step sets it. */
  version: z.looseObject({ run: z.string().min(1) }).optional(),
  steps: z.looseObject({
    /** A version commit; with `viaPullRequest` it lands through the merge lane before the beta. */
    prepare: z.looseObject({ run: z.string().min(1), viaPullRequest: z.boolean() }).optional(),
    /** Prints the artifact id when identity is "artifact". */
    build: z.looseObject({ run: z.string().min(1), artifact: z.string().optional() }).optional(),
    deployBeta: releaseStep,
    verifyBeta: releaseStep,
    /** Reuses the beta's commit or artifact; never rebuilds when identity is "artifact". */
    promote: releaseStep,
    verifyStable: releaseStep,
    rollback: z.looseObject({
      /** redeploy an earlier build; forward-release a new version with an earlier tree; none. */
      kind: z.enum(["redeploy", "forward-release", "none"]),
      where: releaseLocation,
      run: z.string().min(1).optional(),
    }),
    /** Absent: the delivery runner drafts notes from the merged pull requests. */
    notes: z.looseObject({ run: z.string().min(1).optional() }).optional(),
  }),
  /** Beta gates run on every beta; stable gates run once, on the exact beta being promoted. */
  gates: z.looseObject({ beta: z.array(gateRef), stable: z.array(gateRef) }),
  trigger: z.union([
    z.looseObject({ kind: z.literal("every-batch") }),
    z.looseObject({
      kind: z.literal("score"),
      /** change-fragments: the repository's `changes/` files; pr-labels: labels on merged PRs. */
      source: z.enum(["change-fragments", "pr-labels"]),
      threshold: z.number().positive(),
      /** A user-visible fix waiting longer than this cuts a beta regardless of score. */
      maxAgeHours: z.number().positive(),
      /** Hold this long for an approved pull request that could ride along. */
      rideAlongMinutes: z.number().nonnegative(),
    }),
  ]),
  promotion: z.looseObject({ preauthorization: z.enum(["off", "allowed"]).optional() }).optional(),
});
export type ReleaseRecipeV1 = z.infer<typeof ReleaseRecipeV1Schema>;

/**
 * The unified configuration. Reading rule: unknown keys are ignored and preserved by editors;
 * each top-level section is validated on its own, so a malformed section disables only what
 * depends on it; a `version` major newer than FACTORY_CONFIG_VERSION leaves every acting section
 * unset (fail closed). Machine-local settings (accounts, models, capacity, on or paused) never
 * live here.
 */
export const FactoryConfigV1Schema = z.looseObject({
  runners: z.looseObject({ placement: z.enum(["host", "dev"]).optional() }).optional(),
  builder: z.looseObject({ provider: z.string().min(1).optional() }).optional(),
  shadow: z.enum(["dry-run", "review-rehearsal"]).optional(),
  /** The primary records each configured command's exit status at the exact issue head. */
  issueGates: z
    .array(
      z.looseObject({
        argv: z.array(z.string().min(1)).min(1),
        where: z.enum(["container", "host"]).optional(),
        requiredOutput: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .optional(),
  /** Matching paths require an independent security review. */
  sensitivePaths: z.array(z.string().min(1)).optional(),
  schema: z.literal("vorteo-factory"),
  version: z.number().int().positive(),
  /** Absent means "crew". */
  mode: FactoryModeSchema.optional(),
  /**
   * Per-lane overrides of `order`. Every lane may name an ordered list. Intake is treated as
   * pinned until the ledger is portable, and delivery is pinned automatically when the recipe
   * installs onto a machine (`lifecycle` steps). Machines that only build issues are never
   * listed. Lane failover is held pending the owner's decision 7; until then only the first
   * effective holder acquires.
   */
  lanes: z
    .looseObject({
      intake: laneHolders.optional(),
      merge: laneHolders.optional(),
      delivery: laneHolders.optional(),
      releaseBuild: laneHolders.optional(),
      mechanic: laneHolders.optional(),
    })
    .optional(),
  /** The project's default lane order, used by every lane without its own entry. */
  order: z.array(InstallationSchema).min(1).optional(),
  /** Optional allowlist; absent means any trusted, lease-capable installation may claim. */
  claimers: z.array(InstallationSchema).optional(),
  lease: z
    .looseObject({
      ttlMinutes: z.number().positive().optional(),
      renewMinutes: z.number().positive().optional(),
    })
    .optional(),
  /** Deadline overrides in minutes, keyed by issue stage kind, "delivery-lock" or "escalation". */
  watchdog: z.record(z.string(), z.number().positive()).optional(),
  labels: z
    .looseObject({ heavy: z.string().optional(), priority: z.string().optional() })
    .optional(),
  acceptance: z
    .looseObject({
      /** Enable plan judgment for explicit labels or changes requiring additional scrutiny. */
      plan: z.boolean().optional(),
      /** Send-backs per issue before the next result escalates to the owner. Default 2. */
      maxSendBacks: z.number().int().nonnegative().optional(),
    })
    .optional(),
  setupChecks: z
    .array(
      z.looseObject({ id: z.string().min(1), enabled: z.boolean(), reason: z.string().optional() }),
    )
    .optional(),
  release: ReleaseRecipeV1Schema.optional(),
  /** Crew-mode role assignment, mirrored from the legacy `.github/factory.json`. */
  legacy: z
    .looseObject({ triage: InstallationSchema.optional(), releases: InstallationSchema.optional() })
    .optional(),
});
export type FactoryConfigV1 = z.infer<typeof FactoryConfigV1Schema>;

export const FactoryEffectiveConfigSchema = z.object({
  /** Defaults merged with the file; sections that failed validation are absent. */
  value: z.record(z.string(), z.unknown()),
  /** JSON-pointer-like key paths, such as "lanes.merge". */
  fromFile: z.array(z.string()),
  defaults: z.array(z.string()),
  /** Keys this daemon ignores: unknown, or from a newer version. */
  notUnderstood: z.array(z.string()),
  sectionErrors: z.array(z.object({ path: z.string(), error: z.string() })),
  source: z.object({
    /** FACTORY_CONFIG_PATH, ".github/factory.json" for the legacy fallback, or null. */
    path: z.string().nullable(),
    commit: z.string().nullable(),
  }),
});
export type FactoryEffectiveConfig = z.infer<typeof FactoryEffectiveConfigSchema>;

// ---------------------------------------------------------------------------------------------
// Records the daemon writes and serves
// ---------------------------------------------------------------------------------------------

/** One gate's result on one release. Missing evidence is "not-run", never a pass. */
const gateResult = z.object({
  name: z.string(),
  /** "beta" | "stable" */
  tier: z.string(),
  /** "pass" | "fail" | "not-run" */
  result: z.string(),
  evidenceUrl: z.string().nullable(),
});

/** A beta, promotion, rollback or failure. Tags never move; a rollback is its own event. */
export const FactoryReleaseEventSchema = z.object({
  id: z.string(),
  /** "beta" | "promote" | "rollback" | "failed" */
  kind: z.string(),
  version: z.string(),
  /** "beta" | "stable" */
  channel: z.string(),
  commit: z.string(),
  artifact: z.string().nullable(),
  at: iso,
  by: z.object({ runner: z.string().nullable(), ownerAction: z.string().nullable() }),
  contents: z.array(
    z.object({ pr: z.number().int(), issue: z.number().int().nullable(), title: z.string() }),
  ),
  gates: z.array(gateResult),
  rollbackOf: z.object({ fromVersion: z.string(), toVersion: z.string() }).optional(),
});
export type FactoryReleaseEvent = z.infer<typeof FactoryReleaseEventSchema>;

export const FactoryActivityEntrySchema = z.object({
  id: z.string(),
  at: iso,
  /** "mechanical" | "judgment" | "owner" | "mechanic" */
  class: z.string(),
  /** A FactoryEvent kind or an action, such as "merged" or "sent-back". */
  kind: z.string(),
  issue: z.number().int().nullable(),
  text: z.string(),
  url: z.string().nullable(),
});
export type FactoryActivityEntry = z.infer<typeof FactoryActivityEntrySchema>;

export const FactoryPresenceSchema = z.object({
  installation: z.string(),
  /** "on" | "paused" | "off" */
  factory: z.string(),
  /** "crew" | "lean" */
  mode: z.string(),
  daemonVersion: z.string(),
  leanProtocol: z.number().int(),
  /** Waiting heavy tickets accepted before the machine stops claiming heavy issues. */
  heavyQueueLimit: z.number().int(),
  runnersMax: z.number().int(),
  runnersOpen: z.number().int(),
  /** Reader-relative: when this reader last saw the record change. */
  lastSeenAt: iso,
  /** Reader-relative staleness: "fresh" | "stale" | "offline" */
  freshness: z.string(),
  /** The owner's local friendly name for it on this daemon; never written to GitHub. */
  friendlyName: z.string().nullable(),
  /** Lanes whose lease this installation holds now. */
  lanes: z.array(z.string()),
  /** Present when this daemon has a connected-host route to it. */
  serverId: z.string().nullable(),
});
export type FactoryPresence = z.infer<typeof FactoryPresenceSchema>;

const issueLine = z.object({
  issue: z.number().int(),
  title: z.string(),
  /** An IssueStage kind: queued, claimed, planning, plan-ready, deferred, building, checks,
   * review, repair, accepting, sent-back, approved, merged, parked, blocked, foreign. */
  stage: z.string(),
  installation: z.string().nullable(),
  runner: z
    .object({
      agentId: z.string(),
      role: z.string(),
      serverId: z.string().nullable(),
      installation: z.string().optional(),
      friendlyName: z.string().nullable().optional(),
    })
    .nullable(),
  pr: z.object({ number: z.number().int(), headSha: z.string(), checks: z.string() }).nullable(),
  lastActivityAt: iso.nullable(),
  deadline: iso.nullable(),
  /** Plain reason when parked or blocked. */
  waitingOn: z.string().nullable(),
});

export const FactoryLeanStatusSchema = z.object({
  projectId: z.string(),
  mode: z.string(),
  installation: z.string(),
  revision: z.number().int(),
  lanes: z.array(
    z.object({
      lane: z.string(),
      holder: z.string().nullable(),
      here: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
  issues: z.array(issueLine),
  escalations: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      openedAt: iso,
      blocksIssues: z.array(z.number().int()),
    }),
  ),
  /** Plain reasons the Factory is degraded, from the watchdog; empty when healthy. */
  alerts: z.array(z.string()),
});
export type FactoryLeanStatus = z.infer<typeof FactoryLeanStatusSchema>;

export const FactoryLeanViewSchema = z.object({
  pendingBeta: z
    .object({ eventId: z.string(), version: z.string(), shipsAt: iso, held: z.boolean() })
    .nullable()
    .optional(),
  delivery: z
    .object({
      state: z.string(),
      jobId: z.string(),
      kind: z.string(),
      version: z.string().nullable(),
      approvalUrl: z.string().nullable(),
    })
    .nullable()
    .optional(),
  production: FactoryReleaseEventSchema.nullable(),
  betas: z.array(FactoryReleaseEventSchema),
  earlier: z.array(FactoryReleaseEventSchema),
  inFlight: z.array(issueLine),
  machines: z.array(FactoryPresenceSchema),
  previews: z.array(
    z.object({
      workspaceId: z.string(),
      title: z.string(),
      state: z.string(),
      url: z.string().nullable(),
      updatedAt: iso,
    }),
  ),
  health: z.object({
    alerts: z.array(z.string()),
    deliveryLock: z
      .object({
        holder: z.string(),
        holderInfo: z
          .object({
            kind: z.enum(["executor", "runner"]),
            agentId: z.string().optional(),
            installationId: z.string().optional(),
          })
          .optional(),
        batch: z.string(),
        expiresAt: iso,
      })
      .nullable(),
  }),
  recipe: z.object({ valid: z.boolean(), error: z.string().nullable() }),
});
export type FactoryLeanView = z.infer<typeof FactoryLeanViewSchema>;

// ---------------------------------------------------------------------------------------------
// RPCs. Owner-only writes are marked; the daemon refuses them from the CLI and agents.
// ---------------------------------------------------------------------------------------------

const projectInput = z.strictObject({ projectId });
const refusal = z.object({ refused: z.string() });

export const factoryLeanStatus = defineRpc({
  name: "factory.lean.status",
  input: projectInput,
  output: FactoryLeanStatusSchema,
});

export const factoryLeanActivityList = defineRpc({
  name: "factory.lean.activity.list",
  input: z.strictObject({
    projectId,
    before: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({
    entries: z.array(FactoryActivityEntrySchema),
    nextBefore: z.string().nullable(),
  }),
});

/** Decisions an operational Foreman session may take. Each answers named events, once. */
export const FactoryLeanDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("defer"), issue: z.number().int(), behind: z.number().int() }),
  z.strictObject({ kind: z.literal("replan"), issue: z.number().int(), reason: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("approve-widened-plan"),
    issue: z.number().int(),
    files: z.array(z.string()),
  }),
  z.strictObject({
    kind: z.literal("answer-lead"),
    issue: z.number().int(),
    text: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("block"), issue: z.number().int(), reason: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("file-issue"),
    title: z.string().min(1),
    body: z.string().min(1),
    relatesTo: z.array(z.number().int()),
  }),
]);

const sessionInput = {
  projectId,
  /** Events this call answers; a call naming answered events is ignored, never applied twice. */
  eventIds: z.array(z.string().min(1)).min(1),
  /** The status revision the session read; a stale revision is refused. */
  expectedRevision: z.number().int(),
};

export const factoryLeanDecide = defineRpc({
  name: "factory.lean.decide",
  input: z.strictObject({ ...sessionInput, decision: FactoryLeanDecisionSchema }),
  output: z.union([z.object({ applied: z.boolean(), revision: z.number().int() }), refusal]),
});

export const factoryLeanEscalate = defineRpc({
  name: "factory.lean.escalate",
  input: z.strictObject({
    ...sessionInput,
    question: z.string().min(1),
    why: z.string().min(1),
    options: z.array(z.string().min(1)).min(1),
    recommended: z.string().min(1),
    blocksIssues: z.array(z.number().int()),
  }),
  output: z.union([z.object({ escalationId: z.string() }), refusal]),
});

/** The conversational Foreman applying the owner's answer to an escalation or an intent question. */
export const factoryLeanAnswer = defineRpc({
  name: "factory.lean.answer",
  input: z.strictObject({
    projectId,
    escalationId: z.string().min(1),
    decision: z.string().min(1),
  }),
  output: z.union([z.object({ applied: z.boolean() }), refusal]),
});

/** Acceptance of one exact commit by the Foreman role. Refused for any commit but the head. */
export const factoryLeanAccept = defineRpc({
  name: "factory.lean.accept",
  input: z.strictObject({ ...sessionInput, issue: z.number().int(), sha }),
  output: z.union([z.object({ accepted: z.boolean() }), refusal]),
});

/** Numbered improvements, posted verbatim on the issue and delivered unchanged to its lead. */
export const factoryLeanSendBack = defineRpc({
  name: "factory.lean.send-back",
  input: z.strictObject({
    ...sessionInput,
    issue: z.number().int(),
    sha,
    improvements: z.array(z.string().min(1)).min(1),
  }),
  output: z.union([z.object({ round: z.number().int(), escalated: z.boolean() }), refusal]),
});

/** An acceptance session asking the conversational Foreman about intent the record lacks. */
export const factoryLeanAsk = defineRpc({
  name: "factory.lean.ask",
  input: z.strictObject({ ...sessionInput, issue: z.number().int(), question: z.string().min(1) }),
  output: z.union([z.object({ escalationId: z.string() }), refusal]),
});

export const factoryLeanIntentSet = defineRpc({
  name: "factory.lean.intent.set",
  input: z.strictObject({
    projectId,
    issue: z.number().int(),
    quotes: z.array(z.string().min(1)),
    notes: z.string(),
  }),
  output: z.object({ revision: z.number().int() }),
});

export const FactoryLeanRuleSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** "all", "label:<name>" or "path:<glob>" */
  scope: z.string(),
  ownerQuote: z.string(),
  addedAt: iso,
});
export const factoryLeanRulesList = defineRpc({
  name: "factory.lean.rules.list",
  input: projectInput,
  output: z.object({ rules: z.array(FactoryLeanRuleSchema) }),
});
export const factoryLeanRulesAdd = defineRpc({
  name: "factory.lean.rules.add",
  input: z.strictObject({
    projectId,
    text: z.string().min(1),
    scope: z.string().regex(/^(all|label:.+|path:.+)$/),
    ownerQuote: z.string().min(1),
  }),
  output: FactoryLeanRuleSchema,
});
/** Owner-only. */
export const factoryLeanRulesRemove = defineRpc({
  name: "factory.lean.rules.remove",
  input: z.strictObject({ projectId, ruleId: z.string().min(1) }),
  output: z.object({ removed: z.boolean() }),
});

/** A delivery runner reporting its job. The daemon checks the job id against the lock. */
export const factoryLeanDeliveryReport = defineRpc({
  name: "factory.lean.delivery.report",
  input: z.strictObject({
    projectId,
    jobId: z.string().min(1),
    outcome: z.enum(["delivered", "failed"]),
    commits: z.array(sha).min(1),
    target: z.string().min(1),
    verification: z.string().min(1),
    notesUrl: z.string().nullable(),
    version: z.string().nullable(),
    artifact: z.string().nullable(),
    gates: z.array(
      z.strictObject({
        name: z.string(),
        tier: z.enum(["beta", "stable"]),
        result: z.enum(["pass", "fail", "not-run"]),
        evidenceUrl: z.string().nullable(),
      }),
    ),
  }),
  output: z.object({ accepted: z.boolean(), reason: z.string().nullable() }),
});

const pendingBetaInput = z.strictObject({ projectId, eventId: z.string().min(1) });
const pendingBetaOutput = z.union([z.object({ held: z.boolean() }), refusal]);
export const factoryLeanReleasesHold = defineRpc({
  name: "factory.lean.releases.hold",
  input: pendingBetaInput,
  output: pendingBetaOutput,
});
export const factoryLeanReleasesRelease = defineRpc({
  name: "factory.lean.releases.release",
  input: pendingBetaInput,
  output: pendingBetaOutput,
});
export const factoryLeanReleasesList = defineRpc({
  name: "factory.lean.releases.list",
  input: projectInput,
  output: z.object({
    production: FactoryReleaseEventSchema.nullable(),
    events: z.array(FactoryReleaseEventSchema),
    recipe: z.object({ valid: z.boolean(), error: z.string().nullable() }),
  }),
});
/** Owner-only. A beta newer than production; refused when production moved since. */
export const factoryLeanReleasesPromote = defineRpc({
  name: "factory.lean.releases.promote",
  input: z.strictObject({
    projectId,
    eventId: z.string().min(1),
    expectedProduction: z.string().nullable(),
  }),
  output: z.union([z.object({ queued: z.literal(true), jobId: z.string() }), refusal]),
});
/** Owner-only. An accepted release older than production; recorded as a new release event. */
export const factoryLeanReleasesRollback = defineRpc({
  name: "factory.lean.releases.rollback",
  input: z.strictObject({
    projectId,
    targetEventId: z.string().min(1),
    expectedProduction: z.string().min(1),
  }),
  output: z.union([z.object({ queued: z.literal(true), jobId: z.string() }), refusal]),
});
/** Owner-only. Null clears. Spent by the first beta that meets the conditions. */
export const factoryLeanReleasesPreauthorize = defineRpc({
  name: "factory.lean.releases.preauthorize",
  input: z.strictObject({
    projectId,
    conditions: z
      .strictObject({ minSoakHours: z.number().nonnegative(), requireStableGates: z.boolean() })
      .nullable(),
  }),
  output: z.object({ recorded: z.boolean() }),
});

export const factoryLeanConfigRead = defineRpc({
  name: "factory.lean.config.read",
  input: projectInput,
  output: z.object({
    file: z.string().nullable(),
    commit: z.string().nullable(),
    effective: FactoryEffectiveConfigSchema,
    installations: z.array(
      z.object({
        id: z.string(),
        friendlyName: z.string().nullable(),
        /** "this" | "connected" | "presence" | "lease" */
        seenAs: z.array(z.string()),
      }),
    ),
  }),
});
/**
 * Owner-only. Opens a pull request that changes only FACTORY_CONFIG_PATH from `baseCommit`.
 * Never merges: the owner, or Builds on the Vorteo repository, merges it.
 */
export const factoryLeanConfigPropose = defineRpc({
  name: "factory.lean.config.propose",
  input: z.strictObject({ projectId, baseCommit: sha, content: z.string().min(1) }),
  output: z.union([z.object({ pullRequest: z.number().int(), url: z.string() }), refusal]),
});

export const factoryLeanView = defineRpc({
  name: "factory.lean.view",
  input: projectInput,
  output: FactoryLeanViewSchema,
});

/** Owner-only. This machine's local settings, kept in daemon state, never in the repository. */
export const factoryLeanLocalSet = defineRpc({
  name: "factory.lean.local.set",
  input: z.strictObject({
    projectId,
    runners: z.number().int().min(0).max(32).optional(),
    /** Waiting heavy tickets accepted before this machine stops claiming heavy issues. */
    heavyQueueLimit: z.number().int().min(0).max(8).optional(),
  }),
  output: z.object({ runners: z.number().int(), heavyQueueLimit: z.number().int() }),
});

/** Every lean RPC. Registered by the plugin only when the daemon advertises `factoryLean`. */
export const FACTORY_LEAN_RPCS = [
  factoryLeanStatus,
  factoryLeanActivityList,
  factoryLeanDecide,
  factoryLeanEscalate,
  factoryLeanAnswer,
  factoryLeanAccept,
  factoryLeanSendBack,
  factoryLeanAsk,
  factoryLeanIntentSet,
  factoryLeanRulesList,
  factoryLeanRulesAdd,
  factoryLeanRulesRemove,
  factoryLeanDeliveryReport,
  factoryLeanReleasesList,
  factoryLeanReleasesHold,
  factoryLeanReleasesRelease,
  factoryLeanReleasesPromote,
  factoryLeanReleasesRollback,
  factoryLeanReleasesPreauthorize,
  factoryLeanConfigRead,
  factoryLeanConfigPropose,
  factoryLeanView,
  factoryLeanLocalSet,
] as const;

/** Writes only the owner's app may make; the daemon refuses and logs them from other clients. */
export const FACTORY_LEAN_OWNER_ONLY = [
  factoryLeanReleasesHold.name,
  factoryLeanReleasesRelease.name,
  factoryLeanRulesRemove.name,
  factoryLeanReleasesPromote.name,
  factoryLeanReleasesRollback.name,
  factoryLeanReleasesPreauthorize.name,
  factoryLeanConfigPropose.name,
  factoryLeanLocalSet.name,
] as const;
