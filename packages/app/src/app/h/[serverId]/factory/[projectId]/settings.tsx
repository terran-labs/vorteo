import { useLocalSearchParams } from "expo-router";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { FactorySettings } from "@/screens/factory/settings";

export default function FactorySettingsRoute() {
  const serverId = useHostRouteServerId();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  if (!serverId || !projectId) return null;
  return <FactorySettings serverId={serverId} projectId={projectId} />;
}
