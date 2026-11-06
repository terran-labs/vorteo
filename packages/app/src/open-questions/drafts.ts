import { useCallback, useId, useRef } from "react";
import { create } from "zustand";

/**
 * Unsent answers, shared by every card that shows the same question. The left sidebar and the
 * thread's own card show one question twice; typing, notes, Other answers and selections in
 * either appear in the other. Drafts live in memory and are keyed by question ID, which is a
 * UUID, so questions from different threads and hosts never collide.
 */

export type DraftExtra = "note" | "other" | null;

interface TextField {
  value: string;
  /** Which card wrote it last; `*` means everyone must take it, as after Reset. */
  writer: string;
  version: number;
}

export interface QuestionDraft {
  /** Free-text answer, tied to the recommendation it started from. */
  text?: TextField & { basis: string };
  selected?: string[];
  extra?: DraftExtra;
  extraText?: TextField;
}

interface DraftStore {
  drafts: Record<string, QuestionDraft>;
  update: (questionId: string, change: (draft: QuestionDraft) => QuestionDraft) => void;
}

export const useQuestionDraftStore = create<DraftStore>((set) => ({
  drafts: {},
  update: (questionId, change) =>
    set((state) => ({
      drafts: { ...state.drafts, [questionId]: change(state.drafts[questionId] ?? {}) },
    })),
}));

export const EVERY_CARD = "*";

function nextField(previous: TextField | undefined, value: string, writer: string): TextField {
  return { value, writer, version: (previous?.version ?? 0) + 1 };
}

/**
 * A field's reset key changes only when another card, or a Reset, wrote the text. The card the
 * owner is typing in never resets itself, so the caret never jumps.
 */
function useForeignVersion(field: TextField | undefined, me: string): number {
  const foreign = useRef(field?.version ?? 0);
  if (field && field.writer !== me) foreign.current = field.version;
  return foreign.current;
}

export function useQuestionDraft(questionId: string, recommended: string) {
  const me = useId();
  const draft = useQuestionDraftStore((state) => state.drafts[questionId]) ?? {};
  const update = useQuestionDraftStore((state) => state.update);
  // A revised recommendation replaces the draft, so the owner never accepts a stale default.
  const text = draft.text?.basis === recommended ? draft.text : undefined;
  const textVersion = useForeignVersion(text, me);
  const extraVersion = useForeignVersion(draft.extraText, me);

  const setText = useCallback(
    (value: string, writer: string = me) =>
      update(questionId, (current) => {
        const previous = current.text?.basis === recommended ? current.text : undefined;
        if (writer === me && previous?.value === value) return current;
        return { ...current, text: { ...nextField(previous, value, writer), basis: recommended } };
      }),
    [me, questionId, recommended, update],
  );
  const setSelected = useCallback(
    (change: (current: string[] | undefined) => string[]) =>
      update(questionId, (current) => ({ ...current, selected: change(current.selected) })),
    [questionId, update],
  );
  const setExtra = useCallback(
    (change: (current: DraftExtra) => DraftExtra) =>
      update(questionId, (current) => {
        const extra = change(current.extra ?? null);
        // Switching between a note and an Other answer starts that field empty in every card.
        if (extra === (current.extra ?? null)) return current;
        return { ...current, extra, extraText: nextField(current.extraText, "", EVERY_CARD) };
      }),
    [questionId, update],
  );
  const setExtraText = useCallback(
    (value: string) =>
      update(questionId, (current) =>
        current.extraText?.value === value
          ? current
          : { ...current, extraText: nextField(current.extraText, value, me) },
      ),
    [me, questionId, update],
  );

  return {
    text: text?.value ?? recommended,
    textResetKey: `${recommended}:${textVersion}`,
    setText,
    selected: draft.selected,
    setSelected,
    extra: draft.extra ?? null,
    setExtra,
    extraText: draft.extraText?.value ?? "",
    extraResetKey: `${draft.extra ?? "none"}:${extraVersion}`,
    setExtraText,
  };
}
