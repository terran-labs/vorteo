import { DELETE_SCAN_RULE_VERSION, scanForDelete, type DeleteScanResult } from "./delete-scan.js";

/**
 * When Vorteo may answer Claude Code's dangerous-removal prompt by itself (#659, part B): the
 * owner put the thread in Bypass mode, the request is a Bash command, Claude Code raised it only
 * because its removal check could not analyse the command, no ask rule of the owner's forced it,
 * Vorteo's own scan finds no delete in the command, and the owner's setting reads a clear "on".
 * Anything else asks the owner.
 *
 * This decides a permission, so it never shares the display match on the card: every phrasing is
 * anchored at both ends and matched without stripping anything, so ANSI escapes, a localized
 * string or a new wording simply fail and the owner is asked. Known dangerous targets (a critical
 * path, the working directory or an ancestor, a possibly-empty variable, a drive root, a mounted
 * drive, an unplaceable Windows path) are not listed and always ask.
 *
 * Phrasings from claude.exe 2.1.321.
 */
export const AUTO_ANSWERABLE_REASONS: readonly RegExp[] = [
  /^Dangerous (?:rm|rmdir) operation on statically-unresolvable target: [^\n]+$/,
  /^Dangerous (?:rm|rmdir) operation not ruled out — the shell may read this command differently than it was parsed$/,
  /^Dangerous (?:rm|rmdir) operation not ruled out — too many command substitutions to analyze \(\d+\)$/,
  /^Dangerous (?:rm|rmdir) operation not ruled out — too many nested command substitutions to analyze$/,
  /^Dangerous (?:rm|rmdir) operation not ruled out — some nested commands or function substitutions could not be analyzed$/,
  /^This shell -c script runs rm and could not be checked$/,
];

// The structured discriminators claude.exe 2.1.321 sends for this check; SDK 0.3.246 forwards
// neither. A later SDK that forwards one must agree, or the owner is asked.
const AUTO_ANSWERABLE_REASON_TYPES = new Set(["safetyCheck", "subcommandResults"]);

/** The SDK's canUseTool options this decision reads. */
export interface ClaudePermissionPromptOptions {
  decisionReason?: string;
  decisionReasonType?: unknown;
  decisionReasonCode?: unknown;
  matchedAskRule?: unknown;
}

/** Whether the prompt was raised by the removal check alone, as an unanalysable command. */
export function isAutoAnswerableReason(options: ClaudePermissionPromptOptions): boolean {
  if (options.matchedAskRule) return false;
  if (options.decisionReasonCode !== undefined) return false;
  if (
    options.decisionReasonType !== undefined &&
    !AUTO_ANSWERABLE_REASON_TYPES.has(String(options.decisionReasonType))
  ) {
    return false;
  }
  const reason = options.decisionReason;
  return typeof reason === "string" && AUTO_ANSWERABLE_REASONS.some((rule) => rule.test(reason));
}

export type AutoAnswerVerdict =
  | { answer: true; command: string; reason: string; scan: DeleteScanResult; ruleVersion: number }
  | { answer: false; scan: DeleteScanResult | null };

/**
 * The decision before the owner's setting is read. `answer: true` still needs the setting and a
 * second look at the thread's mode; see ClaudeAgentSession's automatic answer.
 */
export function evaluateAutoAnswer(input: {
  modeId: string | null | undefined;
  toolName: string;
  toolInput: Record<string, unknown>;
  options: ClaudePermissionPromptOptions;
}): AutoAnswerVerdict {
  const command = input.toolInput.command;
  const scan = typeof command === "string" ? scanForDelete(command) : null;
  if (input.modeId !== "bypassPermissions") return { answer: false, scan };
  if (input.toolName !== "Bash" || typeof command !== "string" || !scan) {
    return { answer: false, scan };
  }
  if (!isAutoAnswerableReason(input.options)) return { answer: false, scan };
  if (scan.deletes) return { answer: false, scan };
  return {
    answer: true,
    command,
    reason: input.options.decisionReason!,
    scan,
    ruleVersion: DELETE_SCAN_RULE_VERSION,
  };
}

/**
 * Where the owner's setting comes from. Only a clear `true` turns automatic answers on; a
 * missing source, an error, a timeout or anything else means ask. Part B2 supplies the source,
 * read from the installation coordinator's owner settings.
 */
export type AutoAnswerSetting = () => Promise<boolean>;

export const NO_AUTO_ANSWER_SETTING: AutoAnswerSetting = async () => false;

/** Reads the setting, treating any failure as "ask". */
export async function readAutoAnswerSetting(
  setting: AutoAnswerSetting | undefined,
): Promise<boolean> {
  if (!setting) return false;
  try {
    return (await setting()) === true;
  } catch {
    return false;
  }
}

/** After this many automatic answers in one turn, the thread says so, so a loop is visible. */
export const AUTO_ANSWER_TURN_WARNING = 5;
