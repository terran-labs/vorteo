import { useLocalSearchParams } from "expo-router";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { FactoryOverview } from "@/screens/factory/overview";

export default function FactoryOverviewRoute() {
  const serverId = useHostRouteServerId();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  if (!serverId || !projectId) return null;
  return <FactoryOverview serverId={serverId} projectId={projectId} />;
}
