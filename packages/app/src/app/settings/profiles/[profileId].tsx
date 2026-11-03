/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop -- These bounded form controls render with their draft; callbacks intentionally read the current draft. */
import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef } from "react";
import { Text } from "react-native";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useHosts } from "@/runtime/host-runtime";
import { useAgentProfiles } from "@/agent-profiles/internal/use-agent-profiles";
import { AgentProfilePage } from "@/agent-profiles/settings/agent-profile-page";
import { parseProfileRoute } from "@/agent-profiles/settings/agent-profile-page-model";
function ProfileRouteBody() {
  const params = parseProfileRoute(useLocalSearchParams());
  const hosts = useHosts();
  const serverId = params.serverId ?? hosts[0]?.serverId ?? "";
  const { profiles, saveProfiles } = useAgentProfiles(serverId);
  const profile = profiles?.find((item) => item.id === params.profileId);
  const router = useRouter();
  const snapshot = useRef(profile);
  if (snapshot.current?.id !== profile?.id) snapshot.current = profile;
  if (!profile)
    return <Text>{profiles === null ? "Loading profile…" : "Profile unavailable"}</Text>;
  const assertCurrent = () => {
    if (
      JSON.stringify(profiles?.find((item) => item.id === profile.id)) !==
      JSON.stringify(snapshot.current)
    )
      throw new Error("Profile changed. Reopen it before saving.");
  };
  return (
    <AgentProfilePage
      key={profile.id}
      serverId={serverId}
      profile={snapshot.current ?? profile}
      onBack={() =>
        router.replace({
          pathname: "/settings/accounts/[providerType]",
          params: { providerType: params.providerType ?? profile.provider },
        })
      }
      onSave={async (value) => {
        assertCurrent();
        await saveProfiles(
          (profiles ?? []).map((item) =>
            item.id === profile.id
              ? Object.assign({ id: item.id, isDefault: item.isDefault }, value)
              : item,
          ),
        );
      }}
      onDelete={async () => {
        assertCurrent();
        await saveProfiles((profiles ?? []).filter((item) => item.id !== profile.id));
      }}
    />
  );
}
export default function ProfileRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ProfileRouteBody />
    </HostRouteBootstrapBoundary>
  );
}
