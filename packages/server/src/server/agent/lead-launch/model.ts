import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import type { AgentSessionConfig } from "../agent-sdk-types.js";

/**
 * Owner-confirmed lead launches (#360).
 *
 * A coordinator bound to a worker preset may ask the daemon to start a lead thread on another
 * preset. The daemon resolves every option into an exact launch binding, stores the record on the
 * coordinator's thread with a daemon-owned question, and starts nothing. Only the owner's answer
 * from the app claims the record, once, and the launch must still match the stored binding when
 * it runs. A timeout, a default or an agent edit never starts it.
 */

/** Marks questions the daemon asked. Agents can withdraw them but never revise them. */
export const LEAD_LAUNCH_ASKED_BY = "daemon:lead-launch";
/** Set on a confirmed lead: which coordinator asked and which record it came from. */
export const LEAD_LAUNCH_REQUESTED_BY_LABEL = "paseo.lead-requested-by";
export const LEAD_LAUNCH_ID_LABEL = "paseo.lead-launch-id";
export const DECLINE_OPTION_ID = "decline";

/** Everything a launch is bound to. Two launches with the same binding start the same thread. */
export const LeadLaunchBindingSchema = z.object({
  profileId: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  modeId: z.string().nullable(),
  featureValues: z.record(z.string(), z.unknown()),
  cwd: z.string(),
  workspaceId: z.string(),
  title: z.string().nullable(),
  promptDigest: z.string(),
  /** The worker preset the lead itself must use, or null when it may launch any preset. */
  workerPresetId: z.string().nullable(),
  /**
   * Digest of the whole resolved launch configuration: instructions, tool access and policy, MCP
   * servers, provider options, skills, quota reserve and the lead's own worker preset included.
   * Any preset edit between the ask and the click changes it.
   */
  configDigest: z.string(),
});
export type LeadLaunchBinding = z.infer<typeof LeadLaunchBindingSchema>;

export const LeadLaunchOptionSchema = z.object({
  optionId: z.string(),
  /** The preset reference the launch passes to create; the binding holds the resolved ID. */
  profileId: z.string(),
  label: z.string(),
  binding: LeadLaunchBindingSchema,
});
export type LeadLaunchOption = z.infer<typeof LeadLaunchOptionSchema>;

export const LeadLaunchStatusSchema = z.enum([
  "pending",
  "starting",
  "launched",
  "failed",
  "declined",
  "cancelled",
  "interrupted",
]);
export type LeadLaunchStatus = z.infer<typeof LeadLaunchStatusSchema>;

export const LeadLaunchRecordSchema = z.object({
  /** Equals the confirmation question's ID. */
  id: z.string().uuid(),
  callerAgentId: z.string(),
  requestedAt: z.string().datetime(),
  title: z.string(),
  reason: z.string(),
  initialPrompt: z.string(),
  options: z.array(LeadLaunchOptionSchema),
  status: LeadLaunchStatusSchema,
  chosenOptionId: z.string().optional(),
  approvedBy: z.string().optional(),
  decidedAt: z.string().datetime().optional(),
  launchedAgentId: z.string().optional(),
  failureCode: z.string().optional(),
});
export type LeadLaunchRecord = z.infer<typeof LeadLaunchRecordSchema>;

/** What the daemon hands to the create path for one claimed launch. Never built from tool input. */
export interface ConfirmedLeadLaunch {
  launchId: string;
  callerAgentId: string;
  option: LeadLaunchOption;
}

export class LeadLaunchError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_pending"
      | "invalid_option"
      | "binding_mismatch"
      | "daemon_question",
    message: string,
  ) {
    super(message);
    this.name = "LeadLaunchError";
  }
}

export function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt.trim()).digest("hex");
}

/** JSON with object keys sorted at every level, so equal values always serialize the same. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : entry,
  );
}

/**
 * The resolved configuration's digest. Everything is bound except values that change between the
 * ask and the click without any edit to the chosen preset. Writers of the resolved configuration
 * checked (#584 second review): resolveProfileLaunch and resolveProfileSelection (preset fields,
 * worker, provenance), the provider's resolveCreateConfig (mode and features from the preset and
 * provider), captureSkillPolicy, the quota reserve, buildMcpSessionConfig and title resolution.
 * Excluded, and only these:
 * - `capturedAt` of the skill snapshot, wherever it lives: `skillSnapshot` on installation-bound
 *   daemons (Host and Dev) and `profileLaunch.skillSnapshot` otherwise. The skills are bound.
 * - `profileLaunch.configurationRevision`: the shared preferences revision, which any saved
 *   setting bumps. The values it would protect are resolved and bound directly.
 * - `quotaReserve.state.changedAt`: set to the resolution time.
 * - `isDefault` on the resolved preset and its worker: choosing another default preset clears it.
 */
export function launchConfigDigest(config: AgentSessionConfig): string {
  const stable = structuredClone(config) as unknown as Record<string, unknown>;
  const launch = stable.profileLaunch as Record<string, unknown> | undefined;
  for (const snapshot of [stable.skillSnapshot, launch?.skillSnapshot])
    if (snapshot) delete (snapshot as Record<string, unknown>).capturedAt;
  if (launch) {
    delete launch.configurationRevision;
    for (const preset of [launch.profile, launch.worker])
      if (preset) delete (preset as Record<string, unknown>).isDefault;
  }
  const reserve = stable.quotaReserve as { state?: Record<string, unknown> } | undefined;
  if (reserve?.state) delete reserve.state.changedAt;
  return createHash("sha256").update(canonicalJson(stable)).digest("hex");
}

function sortedRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** The binding of a fully resolved launch, as the create path is about to register it. */
export function launchBinding(params: {
  config: AgentSessionConfig;
  workspaceId: string;
  prompt: string;
}): LeadLaunchBinding {
  const { config } = params;
  return {
    profileId: config.profileLaunch?.profile.id ?? config.profileId ?? null,
    provider: config.provider,
    model: config.model ?? null,
    thinkingOptionId: config.thinkingOptionId ?? null,
    modeId: config.modeId ?? null,
    featureValues: sortedRecord(config.featureValues),
    cwd: config.cwd,
    workspaceId: params.workspaceId,
    title: config.title ?? null,
    promptDigest: promptDigest(params.prompt),
    workerPresetId: config.profileLaunch?.worker?.id ?? null,
    configDigest: launchConfigDigest(config),
  };
}

function canonical(binding: LeadLaunchBinding): string {
  return canonicalJson(binding);
}

export function sameBinding(left: LeadLaunchBinding, right: LeadLaunchBinding): boolean {
  return canonical(left) === canonical(right);
}

/** Field-by-field differences from the worker preset, for the owner to read. */
function differences(binding: LeadLaunchBinding, worker: LeadLaunchBinding | null): string[] {
  if (!worker) return [];
  const fields: Array<[string, keyof LeadLaunchBinding]> = [
    ["preset", "profileId"],
    ["account", "provider"],
    ["model", "model"],
    ["thinking", "thinkingOptionId"],
    ["permission mode", "modeId"],
  ];
  const lines = fields.flatMap(([label, key]) => {
    const requested = binding[key] ?? "default";
    const own = worker[key] ?? "default";
    return requested === own
      ? []
      : [`${label}: worker ${String(own)}, requested ${String(requested)}`];
  });
  if (JSON.stringify(binding.featureValues) !== JSON.stringify(worker.featureValues))
    lines.push("features differ from the worker preset");
  return lines;
}

/** What the lead may do, in plain words. */
function describe(binding: LeadLaunchBinding): string {
  const features = Object.entries(binding.featureValues)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  return [
    `Preset ${binding.profileId ?? "none"} on account ${binding.provider}`,
    `model ${binding.model ?? "default"}, thinking ${binding.thinkingOptionId ?? "default"}`,
    `permission mode ${binding.modeId ?? "provider default"}`,
    `features ${features || "none"}`,
    binding.workerPresetId
      ? `may start its own workers only on preset ${binding.workerPresetId}`
      : "may start other agents on any preset",
  ].join("; ");
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Agent text on one line, so it cannot imitate the daemon's own lines on the card. */
function oneLine(text: string, limit: number): string {
  return clip(plain(text), limit);
}

/**
 * Agent text with format characters (direction overrides, zero-width characters) removed and
 * control characters and every kind of whitespace folded to single spaces.
 */
function plain(text: string): string {
  return text
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
}

const PROMPT_EXCERPT = 500;
const WHY_LIMIT = 2000;

/** The excerpt says when it was cut and how long the full task is. */
function promptExcerpt(prompt: string): string {
  const text = plain(prompt);
  if (text.length <= PROMPT_EXCERPT)
    return `The lead's first task, in the agent's words: "${text}"`;
  return `The lead's first task, in the agent's words (first ${PROMPT_EXCERPT} of ${text.length} characters): "${text.slice(0, PROMPT_EXCERPT)}…"`;
}

/**
 * The daemon-built confirmation. Every word the owner reads, except the quoted agent text, comes
 * from the stored record. There is no defaultAppliesAfter, no recommendation and no Other answer.
 */
export function leadLaunchQuestion(params: {
  record: LeadLaunchRecord;
  callerTitle: string;
  workerBinding: LeadLaunchBinding | null;
  workspaceLabel: string;
  now: string;
}): AgentQuestion {
  const { record } = params;
  const requested = record.options[0]!;
  const changed = differences(requested.binding, params.workerBinding);
  // The excerpt is last, so the rest is clipped to leave it whole within the 2,000 characters.
  const excerpt = promptExcerpt(record.initialPrompt);
  const head = [
    `${oneLine(params.callerTitle, 80)} (${record.callerAgentId}) asks to start a lead thread that is not its worker preset. Nothing starts until you choose; no option is recommended.`,
    `Requested: ${describe(requested.binding)}.`,
    changed.length ? `Differs from the worker preset: ${changed.join("; ")}.` : "",
    `The agent's reason, in its own words: "${oneLine(record.reason, 400)}"`,
  ]
    .filter(Boolean)
    .join("\n");
  const why = `${clip(head, WHY_LIMIT - excerpt.length - 1)}\n${excerpt}`;
  return {
    id: record.id,
    question: clip(
      `Start "${oneLine(record.title, 60)}" in ${params.workspaceLabel} on ${requested.binding.profileId ?? requested.binding.provider}?`,
      500,
    ),
    why,
    // The card recommends nothing: the agent's requested escalation is not a default.
    recommendedDefault: "No recommendation. Choose one of the options.",
    input: {
      kind: "choice",
      allowOther: false,
      options: [
        ...record.options.map((option) => ({
          id: option.optionId,
          label: clip(option.label, 80),
          description: clip(describe(option.binding), 200),
        })),
        { id: DECLINE_OPTION_ID, label: "Don't start" },
      ],
    },
    askedAt: params.now,
    askedBy: LEAD_LAUNCH_ASKED_BY,
    status: "open",
  };
}

/**
 * The option the owner chose. Current apps send one option ID; older apps send only the label as
 * text, so an exact label match is accepted. Anything else is refused rather than guessed.
 */
export function chosenOptionId(
  question: AgentQuestion,
  answer: { answer: string; optionIds?: string[]; source?: string },
): string {
  const options = question.input?.kind === "choice" ? question.input.options : [];
  if (answer.source === "other")
    throw new LeadLaunchError("invalid_option", "Choose one of the listed launch options.");
  if (answer.optionIds?.length) {
    const [id] = answer.optionIds;
    if (answer.optionIds.length !== 1 || !options.some((option) => option.id === id))
      throw new LeadLaunchError("invalid_option", "Choose exactly one of the listed options.");
    return id!;
  }
  const matches = options.filter((option) => option.label === answer.answer.trim());
  if (matches.length !== 1)
    throw new LeadLaunchError("invalid_option", "Choose one of the listed launch options.");
  return matches[0]!.id;
}

/** Pending to starting, or declined, exactly once. */
export function claimLeadLaunch(
  record: LeadLaunchRecord,
  claim: { optionId: string; approvedBy: string; now: string },
): LeadLaunchRecord {
  if (record.status !== "pending")
    throw new LeadLaunchError("not_pending", `This launch is already ${record.status}.`);
  if (claim.optionId === DECLINE_OPTION_ID)
    return {
      ...record,
      status: "declined",
      chosenOptionId: claim.optionId,
      approvedBy: claim.approvedBy,
      decidedAt: claim.now,
    };
  if (!record.options.some((option) => option.optionId === claim.optionId))
    throw new LeadLaunchError("invalid_option", "That option is not part of this launch.");
  return {
    ...record,
    status: "starting",
    chosenOptionId: claim.optionId,
    approvedBy: claim.approvedBy,
    decidedAt: claim.now,
  };
}

/** Appended to the owner's answer so the coordinator learns what the daemon did. */
export function leadLaunchOutcomeText(record: LeadLaunchRecord | undefined): string | null {
  if (!record) return null;
  switch (record.status) {
    case "launched":
      return `The daemon started the lead thread ${record.launchedAgentId} with the confirmed settings. It is not your subagent; coordinate through send_agent_prompt.`;
    case "declined":
      return "The owner declined this launch. Nothing was started.";
    case "failed":
      return `The confirmed launch failed (${record.failureCode ?? "error"}). Nothing was started. Ask again with request_lead_launch if it is still needed.`;
    case "cancelled":
      return "This launch was cancelled. Nothing was started.";
    case "interrupted":
      return "The daemon stopped before this launch finished, so it was not started. Ask again with request_lead_launch if it is still needed.";
    default:
      return null;
  }
}
