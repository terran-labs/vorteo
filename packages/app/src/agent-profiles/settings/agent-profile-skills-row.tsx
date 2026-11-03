import { useCallback, useMemo, useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import type { SkillPolicy } from "@getpaseo/protocol/skill-library";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { profileSkillChoices } from "@/agent-skills/profile-selection";

const header = { title: "Skills" };
const policyOptions = [
  { id: "inherit", value: "inherit", label: "Inherit defaults" },
  { id: "none", value: "none", label: "No optional skills" },
  { id: "selected", value: "selected", label: "Selected only" },
];
type SelectedPolicy = Extract<SkillPolicy, { mode: "selected" }>;
function SkillRow({
  identity,
  value,
  onChange,
}: {
  identity: string;
  value: SelectedPolicy;
  onChange: (value: SkillPolicy | undefined) => void;
}) {
  const toggle = useCallback(
    (enabled: boolean) =>
      onChange({
        mode: "selected",
        skills: enabled
          ? [...value.skills, identity]
          : value.skills.filter((item) => item !== identity),
      }),
    [onChange, value.skills, identity],
  );
  return (
    <View style={styles.row}>
      <Text>{identity}</Text>
      <Switch value={value.skills.includes(identity)} onValueChange={toggle} />
    </View>
  );
}
/** One selector row; individual choices live in a centered dialog. */
export function AgentProfileSkillsRow({
  serverId,
  provider,
  value,
  onChange,
}: {
  serverId: string;
  provider: string;
  value: SkillPolicy | undefined;
  onChange: (value: SkillPolicy | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const client = useHostRuntimeClient(serverId);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["skill-library", serverId, ""],
    staleTimeMs: 30_000,
    enabled: open && client !== null,
    queryFn: async () => {
      if (!client) throw new Error("Environment disconnected");
      return client.readSkillLibrary({ kind: "inventory" });
    },
  });
  const choices = useMemo(
    () =>
      profileSkillChoices(
        query.data?.kind === "inventory" ? query.data.inventory.skills : [],
        provider,
      ),
    [query.data, provider],
  );
  let label = "Inherit defaults";
  if (value?.mode === "none") label = "No optional skills";
  if (value?.mode === "selected") label = `${value.skills.length} selected skills`;
  const display = useMemo(() => ({ label }), [label]);
  const changePolicy = useCallback(
    (mode: string) => {
      if (mode === value?.mode || (mode === "inherit" && value === undefined)) return;
      if (mode === "inherit") onChange(undefined);
      else if (mode === "none") onChange({ mode: "none" });
      else onChange({ mode: "selected", skills: [] });
    },
    [onChange, value],
  );
  return (
    <>
      <Button variant="ghost" onPress={show}>
        {label}
      </Button>
      <AdaptiveModalSheet visible={open} header={header} onClose={close}>
        <SelectField
          label="Skills policy"
          value={value?.mode ?? "inherit"}
          selectedDisplay={display}
          options={policyOptions}
          onChange={changePolicy}
          placeholder="Choose"
          emptyText="No options"
        />
        {value?.mode === "selected"
          ? choices.map((skill) => (
              <SkillRow
                key={skill.identity}
                identity={skill.identity}
                value={value}
                onChange={onChange}
              />
            ))
          : null}
        <Button onPress={close}>Done</Button>
      </AdaptiveModalSheet>
    </>
  );
}
const styles = StyleSheet.create({
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12 },
});
