import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AgentActionReceiptSchema,
  type AgentActionReceipt,
} from "@getpaseo/protocol/installation-upgrades";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { delegableUnderGrant, type DelegationGrant } from "./delegated-admission.js";
import { RestartRequestError } from "./restarts.js";

/** How many receipts Installation controls keep. */
const RETAINED = 50;

const ReceiptFileSchema = z.strictObject({
  version: z.literal(1),
  receipts: z.array(AgentActionReceiptSchema),
});

/**
 * Immediate agent doors: read-only or non-disruptive actions a Host agent runs at once under the
 * full maintenance grant, with no window to cancel. Every attempt the grant admits leaves a
 * receipt the owner sees in Installation controls. Anything that restarts, installs or changes
 * configuration uses a queue with a cancellation window instead; the front-door test enforces it.
 */
export interface AgentActions {
  list(): AgentActionReceipt[];
  run<T>(
    action: string,
    requester: string | undefined,
    perform: () => Promise<{ result: T; detail: string }>,
  ): Promise<{ result: T; receipt: AgentActionReceipt }>;
}

export function createAgentActions(input: {
  stateDir: string;
  /** The active full maintenance grant, read fresh at each call; null when none applies. */
  grant: () => DelegationGrant | null;
  now?: () => Date;
}): AgentActions {
  const file = path.join(input.stateDir, "agent-actions", "receipts.json");
  const now = input.now ?? (() => new Date());
  const read = (): AgentActionReceipt[] => {
    if (!existsSync(file)) return [];
    try {
      return ReceiptFileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).receipts;
    } catch {
      // An unreadable history is replaced; receipts are a record, not authority.
      return [];
    }
  };
  // Retention never evicts a started or interrupted receipt: the first still awaits its outcome,
  // and the second records an uncertain effect the owner should see. Both are rare.
  const write = (receipts: AgentActionReceipt[]) => {
    let settled = 0;
    const kept = receipts.filter(
      (receipt) =>
        receipt.outcome === "started" || receipt.outcome === "interrupted" || ++settled <= RETAINED,
    );
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(file, JSON.stringify({ version: 1, receipts: kept }));
  };
  // A recorded outcome moves to the front, newest settled first, so retention keeps it.
  const replace = (receipt: AgentActionReceipt) =>
    write([receipt, ...read().filter((item) => item.id !== receipt.id)]);
  // A receipt still started belongs to an earlier coordinator that stopped mid-action.
  const stale = read();
  if (stale.some((receipt) => receipt.outcome === "started")) {
    for (const receipt of stale)
      if (receipt.outcome === "started") {
        receipt.outcome = "interrupted";
        receipt.detail = `${receipt.detail} The coordinator stopped before the outcome was recorded; check the result before asking again.`;
      }
    write(stale);
  }
  return {
    list: read,
    async run(action, requester, perform) {
      if (!input.grant() || !delegableUnderGrant(`immediate:${action}`))
        throw new RestartRequestError(
          "This action needs the owner's full maintenance delegation. Ask the owner to run it in Installation controls.",
        );
      const started = AgentActionReceiptSchema.parse({
        id: randomUUID(),
        action,
        ...(requester ? { requester } : {}),
        at: now().toISOString(),
        outcome: "started",
        detail: "Started.",
      });
      // Durable before any effect: an action that cannot be recorded does not run.
      write([started, ...read()]);
      try {
        const { result, detail } = await perform();
        const receipt = { ...started, outcome: "succeeded" as const, detail };
        replace(receipt);
        return { result, receipt };
      } catch (error) {
        replace({
          ...started,
          outcome: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
