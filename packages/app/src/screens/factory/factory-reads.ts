import {
  ProjectFactoryListSchema,
  type ProjectFactoryList,
} from "../../../../../plugins/factory/shared/project";
import type { FactoryInvoke } from "./queue";

/**
 * Factory reads shared by the sidebar cards and the overview, so both use one cache entry per
 * host and one bound on concurrent daemon reads. No React here.
 */

/** The reason Stop all Factories sends. Any other drain was started by someone else, such as Builds. */
export const OWNER_STOP_REASON = "Stopped from the Factory Overview";

export function isOwnerStop(drain: { reason: string } | null | undefined): boolean {
  return drain?.reason === OWNER_STOP_REASON;
}

export function factoryListQueryKey(serverId: string) {
  return ["factoryProjectList", serverId] as const;
}

export async function loadFactoryList(invoke: FactoryInvoke): Promise<ProjectFactoryList> {
  return ProjectFactoryListSchema.parse(await invoke("factory.project.list", {}));
}

/** Hosts and projects are read a few at a time, so many Factories never flood a daemon. */
const MAX_CONCURRENT_READS = 3;
let runningReads = 0;
const waitingReads: (() => void)[] = [];

export async function boundedFactoryRead<T>(read: () => Promise<T>): Promise<T> {
  // A finished read hands its slot straight to the next waiting one.
  if (runningReads >= MAX_CONCURRENT_READS) {
    await new Promise<void>((resume) => waitingReads.push(resume));
  } else {
    runningReads += 1;
  }
  try {
    return await read();
  } finally {
    const next = waitingReads.shift();
    if (next) next();
    else runningReads -= 1;
  }
}
