import { z } from "zod";

export const AgentQuestionStatusSchema = z.enum(["open", "answered", "withdrawn"]);

/**
 * Typed question inputs. A question without `input` is a free-text question, which is how every
 * question before typed inputs behaved. Clients that do not understand `input` still show
 * `recommendedDefault` and a text field, so agents must keep that text meaningful as an answer.
 */
export const QuestionOptionSchema = z.object({
  id: z.string().trim().min(1).max(64).describe("Stable option ID returned with the answer."),
  label: z.string().trim().min(1).max(80).describe("Button text."),
  description: z.string().trim().max(200).optional().describe("Optional one-line detail."),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

const allowOther = z
  .boolean()
  .optional()
  .describe("Offer an Other answer with free text. Defaults to true; set false for true binaries.");

export const QuestionInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    multiline: z.boolean().optional().describe("Use a taller field for long answers."),
  }),
  z.object({
    kind: z.literal("confirm"),
    yesLabel: z.string().trim().min(1).max(40).optional().describe('Label for "yes". Default Yes.'),
    noLabel: z.string().trim().min(1).max(40).optional().describe('Label for "no". Default No.'),
    allowOther,
  }),
  z.object({
    kind: z.literal("choice"),
    options: z.array(QuestionOptionSchema).min(2).max(6),
    allowOther,
  }),
  z.object({
    kind: z.literal("multi"),
    options: z.array(QuestionOptionSchema).min(2).max(12),
    min: z.number().int().min(0).max(12).optional(),
    max: z.number().int().min(1).max(12).optional(),
    allowOther,
  }),
]);
export type QuestionInput = z.infer<typeof QuestionInputSchema>;

export const QuestionAnswerSourceSchema = z.enum(["recommended", "edited", "option", "other"]);
export type QuestionAnswerSource = z.infer<typeof QuestionAnswerSourceSchema>;

/** The buttons a question offers. Confirm questions always use the option IDs `yes` and `no`. */
export function questionOptions(input: QuestionInput | undefined): QuestionOption[] {
  if (!input || input.kind === "text") return [];
  if (input.kind === "confirm")
    return [
      { id: "yes", label: input.yesLabel ?? "Yes" },
      { id: "no", label: input.noLabel ?? "No" },
    ];
  return input.options;
}

export function questionAllowsOther(input: QuestionInput | undefined): boolean {
  if (!input || input.kind === "text") return true;
  return input.allowOther !== false;
}

export const AgentQuestionSchema = z.object({
  id: z.string().uuid(),
  question: z.string().min(1).max(500),
  why: z.string().min(1).max(2000),
  blocks: z.array(z.string().min(1)).max(50).optional(),
  recommendedDefault: z.string().min(1).max(2000),
  defaultAppliesAfter: z.string().datetime().optional(),
  // COMPAT(agentQuestionInputs): added November 2026; absent means a free-text question.
  input: QuestionInputSchema.optional(),
  recommendedOptionIds: z.array(z.string()).max(12).optional(),
  askedAt: z.string().datetime(),
  askedBy: z.string(),
  status: AgentQuestionStatusSchema,
  answer: z.string().optional(),
  answeredAt: z.string().datetime().optional(),
  answeredBy: z.string().optional(),
  answerDeliveredAt: z.string().datetime().optional(),
  answerOptionIds: z.array(z.string()).max(12).optional(),
  answerNote: z.string().optional(),
  answerSource: QuestionAnswerSourceSchema.optional(),
});
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;

const QuestionFields = {
  question: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("One short question the owner can answer without reading the conversation."),
  why: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Why this needs the owner and what stays blocked until it is answered."),
  recommendedDefault: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("The answer you recommend. The owner can accept it with one click."),
  blocks: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("IDs of this thread's checklist tasks that wait for the answer."),
  defaultAppliesAfter: z
    .string()
    .datetime()
    .optional()
    .describe(
      "Optional ISO time, at least 15 minutes ahead, after which you will proceed with the recommended default if the owner has not answered.",
    ),
  input: QuestionInputSchema.optional().describe(
    "How the owner answers. Omit for free text. confirm shows Yes/No buttons (option IDs yes and no), choice shows one button per option, multi shows checkboxes. Button types offer Other unless allowOther is false, and the owner can attach a note.",
  ),
  recommendedOptionIds: z
    .array(z.string().min(1))
    .max(12)
    .optional()
    .describe(
      "Required for confirm, choice and multi: the option IDs you recommend. recommendedDefault must still read as the answer in words, for example Yes.",
    ),
};

export const QuestionMutationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("ask"),
      id: z
        .string()
        .uuid()
        .describe("A fresh UUID. Reuse it with identical fields when retrying a lost response."),
      ...QuestionFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("update"),
      id: z.string().uuid(),
      question: QuestionFields.question.optional(),
      why: QuestionFields.why.optional(),
      recommendedDefault: QuestionFields.recommendedDefault.optional(),
      blocks: QuestionFields.blocks,
      input: QuestionFields.input,
      recommendedOptionIds: QuestionFields.recommendedOptionIds,
      defaultAppliesAfter: z
        .string()
        .datetime()
        .nullable()
        .optional()
        .describe("A new time after which the default applies, or null to remove it."),
    })
    .strict(),
  z.object({ operation: z.literal("withdraw"), id: z.string().uuid() }).strict(),
]);
export type QuestionMutation = z.infer<typeof QuestionMutationSchema>;

export const QuestionAnswerRequestSchema = z.object({
  type: z.literal("agent.questions.answer.request"),
  agentId: z.string(),
  requestId: z.string(),
  questionId: z.string().uuid(),
  answer: z.string().min(1).max(4000),
  // COMPAT(agentQuestionInputs): sent only when the daemon advertises agentQuestionInputs.
  optionIds: z.array(z.string().min(1)).max(12).optional(),
  note: z.string().max(2000).optional(),
  source: QuestionAnswerSourceSchema.optional(),
});
export const QuestionAnswerResponseSchema = z.object({
  type: z.literal("agent.questions.answer.response"),
  payload: z.object({
    agentId: z.string(),
    requestId: z.string(),
    questions: z.array(AgentQuestionSchema).nullable(),
    error: z.string().nullable(),
  }),
});
