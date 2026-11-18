const MIB = 1024 * 1024;
/** Above this a full garbage collection pauses the daemon long enough to stall clients. */
const MAX_WORKER_HEAP_MB = 12288;
const HEAP_FLAG = /--max[-_]old[-_]space[-_]size\b/;

export interface WorkerHeapLimitInput {
  /** os.totalmem() */
  totalMemoryBytes: number;
  /** process.constrainedMemory(): a container's cgroup limit, or 0 when unconstrained. */
  constrainedMemoryBytes: number | undefined;
  /** v8.getHeapStatistics().heap_size_limit of this Node binary without flags. */
  defaultHeapLimitBytes: number;
  nodeOptions: string | undefined;
  execArgv: readonly string[];
}

/**
 * Sizes the production daemon worker's old-space limit at a quarter of the memory it can use,
 * capped at 12 GB. Returns null, leaving Node's default, when that default is already as large
 * or when an operator set the limit through NODE_OPTIONS or the worker's arguments.
 */
export function resolveWorkerHeapLimitMb(input: WorkerHeapLimitInput): number | null {
  if (HEAP_FLAG.test(input.nodeOptions ?? "")) return null;
  if (input.execArgv.some((arg) => HEAP_FLAG.test(arg))) return null;
  // Inside a container os.totalmem() reports the whole virtual machine; the cgroup limit binds.
  const constrained = input.constrainedMemoryBytes ?? 0;
  const available =
    constrained > 0 && constrained < input.totalMemoryBytes ? constrained : input.totalMemoryBytes;
  const target = Math.min(Math.floor(available / 4 / MIB), MAX_WORKER_HEAP_MB);
  // Never lower a worker below the limit Node already gives it.
  return target > Math.floor(input.defaultHeapLimitBytes / MIB) ? target : null;
}
