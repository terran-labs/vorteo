import type { PreviewVersion } from "@getpaseo/protocol/previews";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { PreviewVariantGroup } from "./model";
import { PreviewThumb } from "./parts";
import type { PreviewsActions } from "./use-previews";

/** Options published under one variant key, with the owner's pick and reason. */
export function VariantGroupView({
  group,
  httpBase,
  actions,
}: {
  group: PreviewVariantGroup;
  httpBase: string | null;
  actions: PreviewsActions;
}) {
  const { set, options } = group;
  const [picking, setPicking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const winner = options.find((option) => option.id === set.winnerVersionId);
  const disabled = !actions.canAct || actions.pending;

  const confirmPick = useCallback(() => {
    if (!picking) return;
    const trimmed = reason.trim();
    actions.act({
      kind: "pick",
      variantSetId: set.id,
      winnerVersionId: picking,
      ...(trimmed ? { reason: trimmed } : {}),
    });
    setPicking(null);
    setReason("");
  }, [actions, picking, reason, set.id]);
  const cancelPick = useCallback(() => {
    setPicking(null);
    setReason("");
  }, []);
  const clearPick = useCallback(
    () => actions.act({ kind: "pick", variantSetId: set.id, winnerVersionId: null }),
    [actions, set.id],
  );

  return (
    <View style={[styles.group, taskCardStyles.proseInset]} testID={`preview-variants-${set.id}`}>
      <Text style={styles.heading}>{`Pick one: ${set.title}`}</Text>
      {winner ? (
        <View style={styles.winner}>
          <Text style={styles.text}>
            {`Picked ${winner.variantLabel ?? winner.title}`}
            {set.reason ? `. ${set.reason}` : ""}
          </Text>
          <Button variant="ghost" size="md" disabled={disabled} onPress={clearPick}>
            Clear pick
          </Button>
        </View>
      ) : null}
      <View style={styles.options}>
        {options.map((option) => (
          <VariantOption
            key={option.id}
            option={option}
            httpBase={httpBase}
            picked={option.id === set.winnerVersionId}
            disabled={disabled}
            onPick={setPicking}
          />
        ))}
      </View>
      {picking ? (
        <View style={styles.reason}>
          <Text style={styles.text}>
            {`Why ${options.find((option) => option.id === picking)?.variantLabel ?? "this one"}? Optional.`}
          </Text>
          <FormTextInput
            size="md"
            style={styles.target}
            initialValue=""
            onChangeText={setReason}
            placeholder="A short reason helps the agent"
            accessibilityLabel="Reason for this pick"
            maxLength={2000}
          />
          <View style={styles.buttons}>
            <Button variant="default" size="md" disabled={disabled} onPress={confirmPick}>
              Confirm pick
            </Button>
            <Button variant="ghost" size="md" onPress={cancelPick}>
              Cancel
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function VariantOption({
  option,
  httpBase,
  picked,
  disabled,
  onPick,
}: {
  option: PreviewVersion;
  httpBase: string | null;
  picked: boolean;
  disabled: boolean;
  onPick: (versionId: string) => void;
}) {
  const pick = useCallback(() => onPick(option.id), [onPick, option.id]);
  return (
    <View style={styles.option}>
      <PreviewThumb version={option} httpBase={httpBase} style={picked && styles.picked} />
      <Text style={styles.label} numberOfLines={1}>
        {option.variantLabel ?? option.title}
      </Text>
      <Button
        variant={picked ? "secondary" : "outline"}
        size="md"
        style={styles.target}
        disabled={disabled || picked}
        onPress={pick}
        accessibilityLabel={`Pick ${option.variantLabel ?? option.title}`}
      >
        {picked ? "Picked" : "Pick"}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[2] },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  winner: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  options: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  option: { flexGrow: 1, flexBasis: 160, maxWidth: 280, gap: theme.spacing[1] },
  picked: { borderWidth: 2, borderColor: theme.colors.accent },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  reason: { gap: theme.spacing[2] },
  target: { minHeight: 44 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
