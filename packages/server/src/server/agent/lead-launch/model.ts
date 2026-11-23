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
  /** The preset's resolved instructions, so an edited preset no longer matches. */
  instructionsDigest: z.string(),
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

function digest(text: string | undefined): string {
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex");
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
    instructionsDigest: digest(config.systemPrompt),
  };
}

function canonical(binding: LeadLaunchBinding): string {
  return JSON.stringify({ ...binding, featureValues: sortedRecord(binding.featureValues) });
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

function describe(binding: LeadLaunchBinding): string {
  const features = Object.entries(binding.featureValues)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  return [
    `preset ${binding.profileId ?? "none"}`,
    `account ${binding.provider}`,
    `model ${binding.model ?? "default"}`,
    `thinking ${binding.thinkingOptionId ?? "default"}`,
    `permission mode ${binding.modeId ?? "default"}`,
    `features ${features || "none"}`,
  ].join("; ");
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * The daemon-built confirmation. Every word the owner reads, except the quoted reason, comes from
 * the stored record. There is no defaultAppliesAfter and no Other answer.
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
  const why = [
    `${params.callerTitle} (${record.callerAgentId}) asks to start a lead thread that is not its worker preset. Nothing starts until you choose.`,
    `Requested: ${describe(requested.binding)}.`,
    changed.length ? `Differs from the worker preset: ${changed.join("; ")}.` : "",
    `The agent's reason, in its own words: "${clip(record.reason, 400)}"`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id: record.id,
    question: clip(
      `Start "${record.title}" in ${params.workspaceLabel} on ${requested.binding.profileId ?? requested.binding.provider}?`,
      500,
    ),
    why: clip(why, 2000),
    recommendedDefault: requested.label,
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
    recommendedOptionIds: [requested.optionId],
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
