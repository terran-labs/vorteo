import type { LeanModePort } from "./types.js";

export interface LeanProjectRuntime {
  recover(): Promise<void>;
  reconcile(): Promise<void>;
  inspectDeadlines(): Promise<void>;
  subscribe(wake: () => void): () => void;
  stop(reason: "disable" | "pause" | "switch"): Promise<void>;
}

export function createLeanMode(
  projectRuntime: (projectId: string) => Promise<LeanProjectRuntime>,
  report: (projectId: string, error: unknown) => void,
): LeanModePort {
  const projects = new Map<string, ReturnType<typeof start>>();
  async function start(projectId: string) {
    const runtime = await projectRuntime(projectId);
    let active = true;
    let running: Promise<void> | null = null;
    let dirty = false;
    const wake = () => {
      dirty = true;
      if (!active || running) return;
      running = (async () => {
        while (dirty) {
          if (!active) break;
          dirty = false;
          await runtime.reconcile();
        }
      })()
        .catch((error) => report(projectId, error))
        .finally(() => {
          running = null;
          if (dirty && active) wake();
        });
    };
    // Watch deadlines even when the reconcile pass is waiting on an external service.
    let inspecting = false;
    const watchdog = setInterval(() => {
      if (inspecting) return;
      inspecting = true;
      void runtime
        .inspectDeadlines()
        .catch((error) => report(projectId, error))
        .finally(() => {
          inspecting = false;
        });
    }, 30_000);
    watchdog.unref();
    try {
      await runtime.recover();
      const unsubscribe = runtime.subscribe(wake);
      const poll = setInterval(wake, 60_000);
      poll.unref();
      wake();
      return async (reason: "pause" | "disable" | "switch") => {
        active = false;
        unsubscribe();
        clearInterval(poll);
        clearInterval(watchdog);
        await running;
        await runtime.stop(reason);
      };
    } catch (error) {
      clearInterval(watchdog);
      throw error;
    }
  }
  return {
    async start(projectId) {
      const instance = projects.get(projectId) ?? start(projectId);
      projects.set(projectId, instance);
      try {
        await instance;
      } catch (error) {
        if (projects.get(projectId) === instance) projects.delete(projectId);
        throw error;
      }
    },
    async stop(projectId, reason) {
      const instance = projects.get(projectId);
      if (!instance) return;
      const stop = await instance;
      await stop(reason);
      if (projects.get(projectId) === instance) projects.delete(projectId);
    },
  };
}
