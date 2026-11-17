import type { HostProfile } from "@/types/host-connection";
import { DEMO_SERVER_ID, DEMO_TIMESTAMP } from "./scenario";
import { DEMO_DEV_SERVER_ID } from "./installation";

export const DEMO_HOST: HostProfile = {
  serverId: DEMO_SERVER_ID,
  label: "Demo",
  appearance: { color: "none", badgeDisplay: "name" },
  lifecycle: {},
  connections: [
    { id: "demo-connection", type: "directTcp", endpoint: "demo.invalid:1", useTls: false },
  ],
  preferredConnectionId: "demo-connection",
  createdAt: DEMO_TIMESTAMP,
  updatedAt: DEMO_TIMESTAMP,
};

/**
 * The demo registry: the Host and the simulated installation's Dev container, so Dev is listed
 * before the owner unlocks. Unlocking relabels both, as a real installation does.
 */
export const DEMO_HOSTS: readonly HostProfile[] = [
  { ...DEMO_HOST, label: "Host" },
  {
    ...DEMO_HOST,
    serverId: DEMO_DEV_SERVER_ID,
    label: "Dev",
    connections: [
      {
        id: "demo-dev-connection",
        type: "directTcp",
        endpoint: "demo-dev.invalid:1",
        useTls: false,
      },
    ],
    preferredConnectionId: "demo-dev-connection",
  },
];
