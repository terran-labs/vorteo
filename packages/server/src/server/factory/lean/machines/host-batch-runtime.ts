import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { createIssueGateReceipts, type GateTarget } from "../gate-receipts.js";
import type { IssueGateInputs } from "../gate-runtime.js";
import type { LeanStateStore } from "../types.js";
const recipe = z.strictObject({
  machine: z.string().optional(),
  commands: z
    .array(
      z.strictObject({
        argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
        where: z.literal("container"),
        requiredOutput: z.string().min(1).max(4096).optional(),
      }),
    )
    .min(1)
    .max(32),
});
const configSchema = z
  .object({
    heavyGateBatches: z
      .record(
        z
          .string()
          .regex(/^[\w-]+$/u)
          .max(160),
        recipe,
      )
      .optional(),
  })
  .nullable();

export function configuredLocalHeavyBatches(raw: unknown) {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) return null;
  return Object.values(parsed.data?.heavyGateBatches ?? {});
}

type Execute = Parameters<typeof createIssueGateReceipts>[0]["execute"];

export function createLocalHostBatches(options: {
  projectId: string;
  repository: string;
  primary: string;
  state: LeanStateStore;
  now(): Date;
  holdsPrimary(): Promise<boolean>;
  readInputs(issue: number, head: string): Promise<IssueGateInputs | null>;
  readConfig(configCommit: string): Promise<unknown>;
  execute: Execute;
}) {
  const { repository, primary } = options;

  async function qualified(issue: number, head: string) {
    if (!(await options.holdsPrimary())) return null;
    const input = await options.readInputs(issue, head);
    if (
      !input?.trusted ||
      input.issue !== issue ||
      input.repository !== repository ||
      input.head !== head ||
      input.protectedPaths.length ||
      (input.hostedChecks !== "passing" && input.hostedChecks !== "absent")
    ) {
      return null;
    }
    const target: GateTarget = {
      issue,
      head,
      repository,
      primary,
      configCommit: input.configCommit,
    };
    const batches = configuredLocalHeavyBatches(await options.readConfig(target.configCommit));
    if (!batches) return null;
    // In Host mode the primary executes every pinned batch, regardless of its prior placement.
    return { target, commands: batches.flatMap((entry) => entry.commands) };
  }

  const receipts = createIssueGateReceipts({
    ...options,
    async authorize(target, command) {
      const current = await qualified(target.issue, target.head);
      const sameTarget = current !== null && isDeepStrictEqual(target, current.target);
      return {
        trusted: sameTarget,
        cleanProtectedPaths: sameTarget,
        configured:
          sameTarget && current.commands.some((entry) => isDeepStrictEqual(entry, command)),
        claudeReviewedHead: null,
      };
    },
  });

  return {
    async readyForAcceptance(issue: number, head: string): Promise<boolean> {
      const configured = await qualified(issue, head);
      if (!configured) return false;
      if (!configured.commands.length) return true;
      if (!(await receipts.check(configured.target, configured.commands))) return false;
      const current = await qualified(issue, head);
      return isDeepStrictEqual(configured, current);
    },
    async reconcileSecondary(): Promise<boolean> {
      return false;
    },
  };
}
