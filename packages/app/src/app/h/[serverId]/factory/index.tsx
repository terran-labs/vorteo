import { useHostRouteServerId } from "@/navigation/host-route-context";
import { FactoryOverview } from "@/screens/factory/overview";

/** Every Factory in the installation; the project route zooms into one. */
export default function AllFactoriesOverviewRoute() {
  const serverId = useHostRouteServerId();
  if (!serverId) return null;
  return <FactoryOverview serverId={serverId} projectId={null} />;
}
