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
  const record = (receipt: AgentActionReceipt) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const receipts = [receipt, ...read()].slice(0, RETAINED);
    writePrivateFileAtomicSync(file, JSON.stringify({ version: 1, receipts }));
  };
  return {
    list: read,
    async run(action, requester, perform) {
      if (!input.grant() || !delegableUnderGrant(`immediate:${action}`))
        throw new RestartRequestError(
          "This action needs the owner's full maintenance delegation. Ask the owner to run it in Installation controls.",
        );
      const base = {
        id: randomUUID(),
        action,
        ...(requester ? { requester } : {}),
        at: now().toISOString(),
      };
      try {
        const { result, detail } = await perform();
        const receipt = AgentActionReceiptSchema.parse({ ...base, outcome: "succeeded", detail });
        record(receipt);
        return { result, receipt };
      } catch (error) {
        record(
          AgentActionReceiptSchema.parse({
            ...base,
            outcome: "failed",
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }
    },
  };
}
