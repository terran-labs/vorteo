import { useHostRouteServerId } from "@/navigation/host-route-context";
import { SampleFactoryOverview } from "@/screens/factory/overview";

/** The Sample Factory. A static segment, so it wins over a project id. */
export default function SampleFactoryOverviewRoute() {
  const serverId = useHostRouteServerId();
  if (!serverId) return null;
  return <SampleFactoryOverview serverId={serverId} />;
}
