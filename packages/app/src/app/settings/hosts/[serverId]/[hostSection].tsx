import { Redirect, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PageLayout } from "@/components/page-layout";
import { HostVoicePage } from "@/screens/settings/voice/voice-page";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import SettingsScreen from "@/screens/settings-screen";
import { buildSettingsSectionRoute, normalizeHostSectionSlug } from "@/utils/host-routes";

/**
 * Per-host addresses open the shared settings page. The host overview opens
 * Environments with that environment's tab selected; other sections open
 * their pane.
 */
export default function SettingsHostSectionRoute() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ serverId?: string; hostSection?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId.trim() : "";
  const rawSection = typeof params.hostSection === "string" ? params.hostSection : "";
  const section = normalizeHostSectionSlug(rawSection) ?? "connections";
  const view = useMemo(
    () => ({
      kind: "section" as const,
      section: "environments" as const,
      focus: { kind: "environment" as const, serverId },
    }),
    [serverId],
  );

  // The incoming speech settings are host-owned and have no shared catalog pane yet.
  if (section === "voice")
    return (
      <HostRouteBootstrapBoundary>
        <PageLayout title={t("settings.hostSections.voice")} testID="host-voice-settings">
          <HostVoicePage serverId={serverId} />
        </PageLayout>
      </HostRouteBootstrapBoundary>
    );

  if (section !== "host") return <Redirect href={buildSettingsSectionRoute(section)} />;

  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
