import type {
  InstallationType,
  InstallationTypeStatus,
} from "@getpaseo/protocol/installation-type";
import { useCallback, useEffect, useState } from "react";
import { SettingsRow } from "@/components/settings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useToast } from "@/contexts/toast-context";
import { useInstallationOwnerClient } from "@/execution-installation/panel";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { toErrorMessage } from "@/utils/error-messages";

const TYPES: readonly { value: InstallationType; label: string; description: string }[] = [
  {
    value: "stable",
    label: "Stable",
    description:
      "Serves the published interface and installs tagged releases through tracked updates you approve.",
  },
  {
    value: "lab",
    label: "Lab",
    description:
      "Live development: your browser runs the live checkout with hot reload, and daemon changes rebuild and swap in here first, then reach main once they are stable.",
  },
];

/** Stable or Lab, shared by the installation and shown beside its name. */
export function InstallationTypeRow() {
  const client = useInstallationOwnerClient();
  const toast = useToast();
  const [status, setStatus] = useState<InstallationTypeStatus | null>(null);
  const [supported, setSupported] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!client) return;
    let current = true;
    const load = async () => {
      try {
        const next = await client.installationType();
        if (!current) return;
        setStatus(next);
        setSupported(next !== null);
      } catch (error) {
        if (current) toast.error(toErrorMessage(error));
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [client, toast]);
  const choose = useCallback(
    async (type: InstallationType) => {
      if (!client || !status || type === status.type) return;
      setSaving(true);
      try {
        setStatus(await client.changeInstallationType(status, type));
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        setSaving(false);
      }
    },
    [client, status, toast],
  );
  if (!readExecutionInstallation()) return null;
  const selected = TYPES.find((type) => type.value === status?.type);
  let hint = selected?.description ?? "Stable installs tagged releases; Lab evolves itself.";
  if (!client) hint = "Unlock these settings to change the installation type.";
  else if (!supported) hint = "Available after the next System services update.";
  return (
    <SettingsRow label="Installation type" hint={hint} testID="settings-installation-type">
      <DropdownMenu>
        <DropdownTrigger
          accessibilityRole="button"
          accessibilityLabel={`Installation type: ${selected?.label ?? "unknown"}`}
          disabled={!status || saving}
          testID="settings-installation-type-trigger"
        >
          {selected?.label ?? "Stable"}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={320}>
          {TYPES.map((type) => (
            <InstallationTypeOption
              key={type.value}
              option={type}
              selected={status?.type === type.value}
              onChoose={choose}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}

function InstallationTypeOption({
  option,
  selected,
  onChoose,
}: {
  option: (typeof TYPES)[number];
  selected: boolean;
  onChoose: (type: InstallationType) => Promise<void>;
}) {
  const select = useCallback(() => void onChoose(option.value), [onChoose, option.value]);
  return (
    <DropdownMenuItem
      selected={selected}
      description={option.description}
      onSelect={select}
      testID={`settings-installation-type-${option.value}`}
    >
      {option.label}
    </DropdownMenuItem>
  );
}
