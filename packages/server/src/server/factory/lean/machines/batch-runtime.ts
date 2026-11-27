import { createLeanGateBootstrap, type LeanGateBootstrapOptions } from "../gate-bootstrap.js";
import { createGateCommandRunner } from "../gate-command-runner.js";
import type { GateCommandExecution } from "../gate-receipts.js";
import type { LeanLedger } from "../types.js";
import {
  configuredHeavyBatches,
  createMachineBatchTransport,
  type MachineBatchTransportOptions,
} from "./batch-transport.js";
import { readPinnedFactoryConfig } from "./pinned-factory-config.js";
import type { HeavyGateBatch } from "./signed-gates.js";

interface PassedBatch {
  head: string;
  configCommit: string;
  machine: string;
  results: readonly GateCommandExecution[];
}

interface BatchLedger extends LeanLedger {
  passedHeavyGateBatches?: Record<string, PassedBatch>;
}

export interface MachineBatchRuntimeOptions
  extends
    Omit<MachineBatchTransportOptions, "execute" | "now">,
    Pick<LeanGateBootstrapOptions, "paseoHome" | "primary" | "docker" | "gitBinary"> {
  now(): Date;
  isActive(): Promise<boolean>;
  lifetimeMs?: number;
}

const defaultLifetimeMs = 2 * 60 * 60_000;

function ledgerKey(batch: HeavyGateBatch): string {
  return `${batch.target.issue}:${batch.batchId}`;
}

/** Keep the primary's local gates separate. This adds only owner-configured remote batches. */
export function createMachineBatchRuntime(options: MachineBatchRuntimeOptions) {
  const { here, primary, projectId, repository, state, now } = options;
  const { primaryGates } = createLeanGateBootstrap({
    ...options,
    // On the secondary, reuse only the exact-checkout source and disposable execution boundary.
    primary: here,
    holdsPrimary: options.isActive,
  });
  const localExecution = primaryGates.execution;
  const execute =
    localExecution && createGateCommandRunner({ ...localExecution, primary: here, now });
  let transport: ReturnType<typeof createMachineBatchTransport> | null = null;

  async function getTransport() {
    transport ??= createMachineBatchTransport({
      ...options,
      now: () => now().getTime(),
      async authorizeBatch(batch) {
        return (
          batch.target.primary === primary &&
          (await options.isActive()) &&
          (await options.authorizeBatch(batch))
        );
      },
      async execute(challenge, command, authorizeLaunch) {
        if (!execute || challenge.machine !== here || command.where !== "container") return null;
        // The runner uses its primary field as the local execution identity. The signed target
        // retains the real primary and is independently authenticated before every launch.
        return execute({ ...challenge.target, primary: here }, command, authorizeLaunch);
      },
    });
    const pending = transport;
    try {
      return await pending;
    } catch (error) {
      if (transport === pending) transport = null;
      throw error;
    }
  }

  async function liveInputs(issue: number, head: string) {
    const input = await options.readInputs(issue, head);
    return input?.trusted &&
      input.issue === issue &&
      input.repository === repository &&
      input.head === head &&
      input.protectedPaths.length === 0 &&
      (input.hostedChecks === "passing" || input.hostedChecks === "absent")
      ? input
      : null;
  }

  async function passed(batch: HeavyGateBatch): Promise<boolean> {
    const ledger: BatchLedger = await state.read(projectId);
    const saved = ledger.passedHeavyGateBatches?.[ledgerKey(batch)];
    return (
      saved?.head === batch.target.head &&
      saved.configCommit === batch.target.configCommit &&
      saved.machine === batch.machine
    );
  }

  async function advance(batch: HeavyGateBatch): Promise<boolean> {
    if (!(await options.authorizeBatch(batch))) return false;
    if (await passed(batch)) return true;
    const gates = await getTransport();
    const accepted = await gates.accept(batch, (ledger: BatchLedger, results) => {
      const records = (ledger.passedHeavyGateBatches ??= {});
      records[ledgerKey(batch)] = {
        head: batch.target.head,
        configCommit: batch.target.configCommit,
        machine: batch.machine,
        results,
      };
    });
    if (accepted || (await passed(batch))) return true;
    await gates.request(batch, options.lifetimeMs ?? defaultLifetimeMs);
    return false;
  }

  return {
    /** Primary hook after the normal local gates pass, before the exact-head merge. */
    async readyForAcceptance(issue: number, head: string): Promise<boolean> {
      if (here !== primary || !(await options.isActive())) return false;
      const input = await liveInputs(issue, head);
      if (!input) return false;
      const { configCommit } = input;
      const raw = await readPinnedFactoryConfig(options.github, repository, configCommit);
      const recipes = configuredHeavyBatches(raw);
      if (!recipes) return false;
      if (recipes.length === 0) return options.isActive();
      for (const [batchId, recipe] of recipes) {
        const batch: HeavyGateBatch = {
          batchId,
          target: { issue, head, configCommit, repository, primary },
          ...recipe,
        };
        if (!(await advance(batch))) return false;
      }
      const current = await liveInputs(issue, head);
      return current?.configCommit === configCommit && (await options.isActive());
    },

    /** Secondary hook for each active issue, using the configured isolated Docker boundary. */
    async reconcileSecondary(issue: number): Promise<boolean> {
      if (here === primary || !execute || !(await options.isActive())) return false;
      const gates = await getTransport();
      return gates.respond(issue);
    },
  };
}
