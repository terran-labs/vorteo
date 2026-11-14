import { useCallback, useMemo, useState } from "react";
import { SettingsRow } from "@/components/settings";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import {
  browserTimeZone,
  timeZoneChoices,
  useOwnerTimeZone,
} from "@/execution-installation/time-zone";
import { toErrorMessage } from "@/utils/error-messages";

// Option values are strings, so automatic gets an id no IANA zone can use.
const AUTOMATIC = "automatic";

/** The owner's time zone, shared with every agent in Host and Dev. */
export function TimeZoneRow() {
  const timeZone = useOwnerTimeZone();
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const browser = browserTimeZone();
  const automaticZone = timeZone.value?.reported ?? browser;
  const override = timeZone.value?.override ?? null;
  const options = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: AUTOMATIC,
        value: AUTOMATIC,
        label: "Automatic (browser)",
        description: automaticZone ?? undefined,
      },
      ...timeZoneChoices(override, automaticZone).map((zone) => ({
        id: zone,
        value: zone,
        label: zone.replaceAll("_", " "),
      })),
    ],
    [automaticZone, override],
  );
  const selected = override ?? AUTOMATIC;
  const choose = useCallback(
    async (value: string) => {
      const next = value === AUTOMATIC ? null : value;
      if (next === override) return;
      setSaving(true);
      setProblem(null);
      try {
        await timeZone.choose(next);
      } catch (error) {
        setProblem(toErrorMessage(error));
      } finally {
        setSaving(false);
      }
    },
    [override, timeZone],
  );
  const selectedDisplay = useMemo(
    () => options.find((option) => option.value === selected) ?? { label: "Automatic (browser)" },
    [options, selected],
  );
  const handleChange = useCallback((value: string) => void choose(value), [choose]);
  const hint = timeZone.supported
    ? "Agents give owner-facing times in this zone. Automatic follows the browser of the owner device that opened Vorteo most recently."
    : "Available after the next System services update.";
  return (
    <SettingsRow label="Time zone" hint={hint} error={problem} testID="settings-time-zone">
      <SelectField
        label="Time zone"
        field={false}
        value={timeZone.supported ? selected : null}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={handleChange}
        disabled={!timeZone.supported || saving}
        loading={timeZone.supported && !timeZone.loaded}
        searchable
        searchPlaceholder="Search time zones"
        placeholder="Automatic (browser)"
        emptyText="No matching time zones"
        testID="settings-time-zone-select"
      />
    </SettingsRow>
  );
}
