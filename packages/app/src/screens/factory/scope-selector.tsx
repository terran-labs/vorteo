import { useCallback } from "react";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { ChevronDown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ScreenTitle } from "@/components/headers/screen-title";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { useAllFactories, useProjectNames } from "./overview-sources";
import { allFactoriesOverviewRoute, projectFactoryOverviewRoute } from "./routes";
import type { FactoryScopeEntry } from "./all-factories-model";

const ThemedChevronDown = withUnistyles(ChevronDown);

/** One route-backed scope selector for the board, reports and operating controls. */
export function FactoryScopeSelector({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string | null;
}) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const { entries } = useAllFactories(focused);
  const name = useProjectNames()(serverId, projectId ?? "");
  const allLabel = t("projectFactory.scope.allTitle");
  const title = projectId ? (name ?? t("projectFactory.overview")) : allLabel;
  const openAll = useCallback(
    () => router.navigate(allFactoriesOverviewRoute(serverId)),
    [serverId],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel={title}
        testID="factory-scope-selector"
      >
        <ScreenTitle>{title}</ScreenTitle>
        <ThemedChevronDown size={16} uniProps={mutedIconColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem selected={projectId === null} onSelect={openAll}>
          {allLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {entries.map((entry) => (
          <FactoryOption
            key={entry.key}
            entry={entry}
            selected={entry.serverId === serverId && entry.projectId === projectId}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FactoryOption({ entry, selected }: { entry: FactoryScopeEntry; selected: boolean }) {
  const open = useCallback(
    () => router.navigate(projectFactoryOverviewRoute(entry.serverId, entry.projectId)),
    [entry.serverId, entry.projectId],
  );
  return (
    <DropdownMenuItem selected={selected} onSelect={open}>
      {entry.hostLabel ? `${entry.name} · ${entry.hostLabel}` : entry.name}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    flexShrink: 1,
    borderRadius: theme.borderRadius.md,
  },
}));
