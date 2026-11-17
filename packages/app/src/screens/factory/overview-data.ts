import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import type { QuotaAccount } from "@/provider-usage/global-quota";
import type { FactoryControls } from "./overview-controls";
import type { activeDrains, FactoryScopeEntry } from "./all-factories-model";
import type { StopAllControls } from "./overview-sources";
import type { FactoryLaneGroup, FactoryQueueFigures, FactoryUsageSummary } from "./overview-model";
import type { FactoryHistory } from "./overview-sample";
import type { FactoryQueue } from "./queue";

/** Everything a Factory overview design renders, assembled once by the screen. */
export interface FactoryOverviewData {
  /** One project's Factory, or every Factory in the installation. */
  scope: "project" | "all";
  /** The host whose routes the overview lives under; quota and routing read from it. */
  serverId: string;
  /** The zoomed-in Factory with its controls; null in the All Factories scope. */
  focus: { projectId: string; state: ProjectFactoryState; controls: FactoryControls } | null;
  /** Every Factory shown: one in project scope. */
  factories: FactoryScopeEntry[];
  drains: ReturnType<typeof activeDrains>;
  stopAll: StopAllControls;
  /** Opens one Factory's overview from the All Factories scope. */
  zoomIn: (serverId: string, projectId: string) => void;
  /** The sample queue is showing instead of the live one. */
  sample: boolean;
  queue: {
    /** Null when the daemon predates the queue; the board is then hidden. */
    data: FactoryQueue | null;
    loading: boolean;
    fetching: boolean;
    error: Error | null;
    reload: () => void;
  };
  lanes: FactoryLaneGroup[];
  figures: FactoryQueueFigures;
  usage: FactoryUsageSummary;
  quota: {
    accounts: QuotaAccount[];
    /** The accounts are sample accounts, shown because the host reports none. */
    sample: boolean;
    /** API-equivalent dollars by account id, only for sample accounts. */
    spend: Record<string, number>;
  };
  /** Always sample: the daemon does not record Factory history yet. */
  history: FactoryHistory;
  /** Opens an agent thread on its host; undefined while the sample queue shows. */
  openAgent?: (agentId: string, serverId?: string) => void;
  now: number;
}
