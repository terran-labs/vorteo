import { createHash } from "node:crypto";

import type { InstructionsState } from "./state.js";

/** How many earlier revisions of a role's project instructions the state file keeps. */
export const INSTRUCTIONS_HISTORY_LIMIT = 10;

/** Identifies a rendered shipped charter, so an upgrade that changes it is noticed. */
export function charterVersion(charterText: string): string {
  return createHash("sha256").update(charterText).digest("hex");
}

/** The operator's project instructions as they ride after the charter and in a tick prompt. */
export function instructionsBlock(instructions: Pick<InstructionsState, "additions" | "revision">) {
  return `Project instructions (revision ${instructions.revision}):\n${instructions.additions}`;
}

/** The agent's system prompt: the shipped charter, then the project's own instructions. */
export function effectiveInstructions(
  charterText: string,
  instructions: Pick<InstructionsState, "additions" | "revision">,
): string {
  return instructions.additions.trim()
    ? `${charterText}\n\n${instructionsBlock(instructions)}`
    : charterText;
}

/** Records new additions as the next revision, reviewed against the current shipped charter. */
export function saveRevision(
  current: InstructionsState,
  additions: string,
  charterText: string,
  now: string,
): InstructionsState {
  const revision = current.revision + 1;
  return {
    ...current,
    additions,
    revision,
    updatedAt: now,
    history: [...current.history, { revision, additions, updatedAt: now }].slice(
      -INSTRUCTIONS_HISTORY_LIMIT,
    ),
    basedOn: { charterVersion: charterVersion(charterText), charterText },
    review: { status: "none" },
  };
}

/** Marks the additions as reviewed against the current shipped charter, unchanged. */
export function rebase(current: InstructionsState, charterText: string): InstructionsState {
  return {
    ...current,
    basedOn: { charterVersion: charterVersion(charterText), charterText },
    review: { status: "none" },
  };
}

/** True when non-empty additions were last reviewed against a different shipped charter. */
export function hasDrifted(current: InstructionsState, charterText: string): boolean {
  return (
    current.additions.trim() !== "" &&
    current.basedOn?.charterVersion !== charterVersion(charterText)
  );
}
