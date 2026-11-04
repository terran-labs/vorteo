import {
  questionAllowsOther,
  questionOptions,
  type AgentQuestion,
  type QuestionOption,
} from "@getpaseo/protocol/agent-questions";
import { CheckSquare, Sparkles, Square } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { composeOptionAnswer, composeTextAnswer, type ComposedAnswer } from "./model";

/** Long recommendations get a taller field so the owner can read what they are accepting. */
const MULTILINE_THRESHOLD = 60;

interface ControlsProps {
  question: AgentQuestion;
  canAnswer: boolean;
  pending: boolean;
  onAnswer: (answer: ComposedAnswer) => void;
  testIDPrefix: string;
}

/**
 * Answer controls for one question. Free-text questions get one editable field pre-filled with the
 * recommendation. Button questions answer in one click, with an optional note and, unless the agent
 * turned it off, an Other answer for when none of the options fit.
 */
export function QuestionAnswerControls(props: ControlsProps) {
  const kind = props.question.input?.kind ?? "text";
  return kind === "text" ? <TextAnswer {...props} /> : <OptionAnswer {...props} />;
}

function TextAnswer({ question, canAnswer, pending, onAnswer, testIDPrefix }: ControlsProps) {
  const recommended = question.recommendedDefault;
  const [draft, setDraft] = useState(recommended);
  const [resets, setResets] = useState(0);
  // A revised recommendation replaces the draft, so the owner never accepts a stale default.
  const [seen, setSeen] = useState(recommended);
  if (seen !== recommended) {
    setSeen(recommended);
    setDraft(recommended);
  }
  const multiline =
    (question.input?.kind === "text" && question.input.multiline === true) ||
    recommended.length > MULTILINE_THRESHOLD;
  const composed = composeTextAnswer(question, draft);
  const edited = composed.source === "edited";
  const send = useCallback(() => {
    if (composed.answer) onAnswer(composed);
  }, [composed, onAnswer]);
  const reset = useCallback(() => {
    setDraft(recommended);
    setResets((value) => value + 1);
  }, [recommended]);
  return (
    <View style={styles.stack}>
      <FormTextInput
        size="md"
        initialValue={recommended}
        resetKey={`${recommended}:${resets}`}
        onChangeText={setDraft}
        onSubmitEditing={multiline ? undefined : send}
        editable={canAnswer}
        multiline={multiline}
        selectTextOnFocus
        maxLength={4000}
        accessibilityLabel={`Answer: ${question.question}`}
        testID={`${testIDPrefix}-answer-${question.id}`}
      />
      <View style={styles.actions}>
        <Button
          variant="default"
          size="md"
          disabled={!canAnswer || !composed.answer}
          loading={pending}
          onPress={send}
          testID={`${testIDPrefix}-send-${question.id}`}
        >
          {edited ? "Send answer" : "Accept recommendation"}
        </Button>
        {edited ? (
          <Button
            variant="ghost"
            size="md"
            onPress={reset}
            testID={`${testIDPrefix}-reset-${question.id}`}
          >
            Reset
          </Button>
        ) : null}
      </View>
    </View>
  );
}

type Extra = "note" | "other" | null;

function OptionAnswer({ question, canAnswer, pending, onAnswer, testIDPrefix }: ControlsProps) {
  const input = question.input;
  const options = useMemo(() => questionOptions(input), [input]);
  const recommended = useMemo(
    () => new Set(question.recommendedOptionIds ?? []),
    [question.recommendedOptionIds],
  );
  const multi = input?.kind === "multi";
  const [selected, setSelected] = useState<string[]>(() => [...recommended]);
  const [extra, setExtra] = useState<Extra>(null);
  const [text, setText] = useState("");
  const note = extra === "note" ? text : "";

  const choose = useCallback(
    (id: string) => onAnswer(composeOptionAnswer(question, [id], note)),
    [note, onAnswer, question],
  );
  const toggle = useCallback(
    (id: string) =>
      setSelected((current) =>
        current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
      ),
    [],
  );
  const submitMulti = useCallback(
    () => onAnswer(composeOptionAnswer(question, selected, note)),
    [note, onAnswer, question, selected],
  );
  const sendOther = useCallback(() => {
    const composed = composeTextAnswer(question, text);
    if (composed.answer) onAnswer(composed);
  }, [onAnswer, question, text]);
  const openNote = useCallback(() => setExtra((value) => (value === "note" ? null : "note")), []);
  const openOther = useCallback(
    () => setExtra((value) => (value === "other" ? null : "other")),
    [],
  );

  const range = multi ? multiRange(input, options.length) : null;
  const selectionFits = range ? selected.length >= range.min && selected.length <= range.max : true;
  const disabled = !canAnswer || pending;

  return (
    <View style={styles.stack}>
      <OptionList
        question={question}
        options={options}
        recommended={recommended}
        selected={selected}
        disabled={disabled}
        onChoose={choose}
        onToggle={toggle}
        testIDPrefix={testIDPrefix}
      />
      {multi ? (
        <View style={styles.actions}>
          <Button
            variant="default"
            size="md"
            disabled={disabled || !selectionFits}
            loading={pending}
            onPress={submitMulti}
            testID={`${testIDPrefix}-submit-${question.id}`}
          >
            Send selection
          </Button>
          {range && !selectionFits ? (
            <Text style={styles.description}>{rangeHint(range)}</Text>
          ) : null}
        </View>
      ) : null}
      {extra ? (
        <FormTextInput
          size="md"
          initialValue=""
          resetKey={extra}
          onChangeText={setText}
          onSubmitEditing={extra === "other" ? sendOther : undefined}
          editable={canAnswer}
          maxLength={extra === "note" ? 2000 : 4000}
          placeholder={extraPlaceholder(extra, multi)}
          accessibilityLabel={extra === "note" ? "Note" : `Other answer: ${question.question}`}
          testID={`${testIDPrefix}-${extra}-${question.id}`}
        />
      ) : null}
      <View style={styles.actions}>
        <Button
          variant="ghost"
          size="md"
          onPress={openNote}
          disabled={!canAnswer}
          testID={`${testIDPrefix}-add-note-${question.id}`}
        >
          {extra === "note" ? "Remove note" : "Add note"}
        </Button>
        {questionAllowsOther(input) ? (
          <Button
            variant="ghost"
            size="md"
            onPress={openOther}
            disabled={!canAnswer}
            testID={`${testIDPrefix}-other-${question.id}`}
          >
            {extra === "other" ? "Cancel" : "Other answer"}
          </Button>
        ) : null}
        {extra === "other" ? (
          <Button
            variant="secondary"
            size="md"
            disabled={disabled || !text.trim()}
            onPress={sendOther}
            testID={`${testIDPrefix}-send-other-${question.id}`}
          >
            Send
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function OptionList({
  question,
  options,
  recommended,
  selected,
  disabled,
  onChoose,
  onToggle,
  testIDPrefix,
}: {
  question: AgentQuestion;
  options: QuestionOption[];
  recommended: ReadonlySet<string>;
  selected: readonly string[];
  disabled: boolean;
  onChoose: (id: string) => void;
  onToggle: (id: string) => void;
  testIDPrefix: string;
}) {
  const kind = question.input?.kind;
  if (kind === "confirm")
    return (
      <View style={styles.actions}>
        {options.map((option) => (
          <OptionButton
            key={option.id}
            option={option}
            recommended={recommended.has(option.id)}
            disabled={disabled}
            onChoose={onChoose}
            testID={`${testIDPrefix}-option-${question.id}-${option.id}`}
          />
        ))}
      </View>
    );
  if (kind === "choice")
    return (
      <>
        {options.map((option) => (
          <View key={option.id} style={styles.choice}>
            <OptionButton
              option={option}
              recommended={recommended.has(option.id)}
              disabled={disabled}
              onChoose={onChoose}
              testID={`${testIDPrefix}-option-${question.id}-${option.id}`}
            />
            {option.description ? (
              <Text style={styles.description}>{option.description}</Text>
            ) : null}
          </View>
        ))}
      </>
    );
  return (
    <>
      {options.map((option) => (
        <CheckRow
          key={option.id}
          option={option}
          checked={selected.includes(option.id)}
          recommended={recommended.has(option.id)}
          disabled={disabled}
          onToggle={onToggle}
          testID={`${testIDPrefix}-option-${question.id}-${option.id}`}
        />
      ))}
    </>
  );
}

function OptionButton({
  option,
  recommended,
  disabled,
  onChoose,
  testID,
}: {
  option: QuestionOption;
  recommended: boolean;
  disabled: boolean;
  onChoose: (id: string) => void;
  testID: string;
}) {
  const press = useCallback(() => onChoose(option.id), [onChoose, option.id]);
  return (
    <Button
      variant={recommended ? "default" : "secondary"}
      size="md"
      leftIcon={recommended ? Sparkles : undefined}
      disabled={disabled}
      onPress={press}
      accessibilityLabel={recommended ? `${option.label}, recommended` : option.label}
      testID={testID}
    >
      {option.label}
    </Button>
  );
}

function CheckRow({
  option,
  checked,
  recommended,
  disabled,
  onToggle,
  testID,
}: {
  option: QuestionOption;
  checked: boolean;
  recommended: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
  testID: string;
}) {
  const press = useCallback(() => onToggle(option.id), [onToggle, option.id]);
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  const Icon = checked ? CheckSquare : Square;
  return (
    <PressHighlight
      accessibilityRole="checkbox"
      accessibilityLabel={recommended ? `${option.label}, recommended` : option.label}
      accessibilityState={accessibilityState}
      aria-checked={checked}
      disabled={disabled}
      onPress={press}
      style={styles.checkRow}
      testID={testID}
    >
      <Icon size={18} color={styles.label.color} />
      <View style={styles.checkText}>
        <Text style={styles.label}>
          {option.label}
          {recommended ? <Text style={styles.recommendedTag}> · Recommended</Text> : null}
        </Text>
        {option.description ? <Text style={styles.description}>{option.description}</Text> : null}
      </View>
    </PressHighlight>
  );
}

function extraPlaceholder(extra: Exclude<Extra, null>, multi: boolean): string {
  if (extra === "other") return "Your own answer";
  return multi ? "Note sent with your selection" : "Note sent with the option you choose";
}

function multiRange(input: AgentQuestion["input"], total: number): { min: number; max: number } {
  if (input?.kind !== "multi") return { min: 0, max: total };
  return { min: input.min ?? 0, max: Math.min(input.max ?? total, total) };
}

function rangeHint({ min, max }: { min: number; max: number }): string {
  if (min === max) return `Choose ${min}.`;
  return `Choose ${min} to ${max}.`;
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing[2] },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  choice: { gap: theme.spacing[1], alignItems: "flex-start" },
  checkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  checkText: { flex: 1, minWidth: 0, gap: theme.spacing[0.5] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  recommendedTag: { color: theme.colors.foregroundMuted },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
