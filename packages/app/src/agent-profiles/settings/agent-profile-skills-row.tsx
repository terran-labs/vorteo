/* oxlint-disable no-nested-ternary -- Three policy variants map directly to their persisted values. */
/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop -- These bounded form controls render with their draft; callbacks intentionally read the current draft. */
import { useState } from "react";
import { Text, View } from "react-native";
import type { SkillPolicy } from "@getpaseo/protocol/skill-library";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { profileSkillChoices } from "@/agent-skills/profile-selection";

/** One quiet selector row; individual choices live in a centered dialog. */
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
  const choices = profileSkillChoices(
    query.data?.kind === "inventory" ? query.data.inventory.skills : [],
    provider,
  );
  const label =
    value?.mode === "none"
      ? "No optional skills"
      : value?.mode === "selected"
        ? `${value.skills.length} selected skills`
        : "Inherit defaults";
  return (
    <>
      <Button variant="ghost" onPress={() => setOpen(true)}>
        {label}
      </Button>
      <AdaptiveModalSheet
        visible={open}
        header={{ title: "Skills" }}
        onClose={() => setOpen(false)}
      >
        <SelectField
          label="Skills policy"
          value={value?.mode ?? "inherit"}
          selectedDisplay={{ label }}
          options={[
            { id: "inherit", value: "inherit", label: "Inherit defaults" },
            { id: "none", value: "none", label: "No optional skills" },
            { id: "selected", value: "selected", label: "Selected only" },
          ]}
          onChange={(mode) =>
            onChange(
              mode === "inherit"
                ? undefined
                : mode === "none"
                  ? { mode: "none" }
                  : { mode: "selected", skills: [] },
            )
          }
          placeholder="Choose"
          emptyText="No options"
        />
        {value?.mode === "selected"
          ? choices.map((skill) => (
              <View
                key={skill.identity}
                style={{
                  minHeight: 48,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <Text>{skill.identity}</Text>
                <Switch
                  value={value.skills.includes(skill.identity)}
                  onValueChange={(enabled) =>
                    onChange({
                      mode: "selected",
                      skills: enabled
                        ? [...value.skills, skill.identity]
                        : value.skills.filter((identity) => identity !== skill.identity),
                    })
                  }
                />
              </View>
            ))
          : null}
        <Button onPress={() => setOpen(false)}>Done</Button>
      </AdaptiveModalSheet>
    </>
  );
}
