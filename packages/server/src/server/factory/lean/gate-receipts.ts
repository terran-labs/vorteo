import { createHash } from "node:crypto";
import type { LeanLedger, LeanStateStore } from "./types.js";

export interface IssueGateCommand {
  argv: string[];
  where: "container" | "host";
  requiredOutput?: string;
}

export interface GateTarget {
  issue: number;
  head: string;
  repository: string;
  primary: string;
  configCommit: string;
}

export interface GateCommandExecution {
  head: string;
  machine: string;
  where: IssueGateCommand["where"];
  tree: string;
  exitCode: number;
  outputMatched: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface GateReceipt extends GateTarget, GateCommandExecution {
  argv: string[];
  requiredOutput: string | null;
}

interface ReceiptLedger extends LeanLedger {
  gateReceipts?: Record<string, GateReceipt>;
}

function identity(target: GateTarget, command: IssueGateCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.issue,
        target.repository,
        target.primary,
        target.configCommit,
        target.head,
        command.where,
        command.argv,
        command.requiredOutput ?? null,
      ]),
    )
    .digest("hex");
}

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function validGateTarget(target: GateTarget): boolean {
  return (
    Number.isSafeInteger(target.issue) &&
    target.issue > 0 &&
    /^[\w.-]+\/[\w.-]+$/u.test(target.repository) &&
    !/\s/u.test(target.repository) &&
    Boolean(target.primary.trim()) &&
    (target.head.length === 40 || target.head.length === 64) &&
    target.configCommit.length === target.head.length &&
    oid.test(target.configCommit) &&
    oid.test(target.head)
  );
}

export function validGateCommand(command: IssueGateCommand): boolean {
  return (
    command.argv.length > 0 &&
    !/^-|=/u.test(command.argv[0]) &&
    command.argv.every((arg) => arg.length > 0 && !arg.includes("\0")) &&
    (command.where === "host" || command.where === "container") &&
    (command.requiredOutput === undefined ||
      (command.requiredOutput.length > 0 &&
        !command.requiredOutput.includes("\0") &&
        !/[\r\n]/u.test(command.requiredOutput)))
  );
}

function matchesExecution(
  target: GateTarget,
  command: IssueGateCommand,
  result: GateCommandExecution,
): boolean {
  return (
    result.head === target.head &&
    result.machine === target.primary &&
    result.where === command.where &&
    oid.test(result.tree) &&
    result.tree.length === target.head.length &&
    Number.isSafeInteger(result.exitCode) &&
    result.exitCode >= 0 &&
    result.exitCode <= 255 &&
    typeof result.outputMatched === "boolean" &&
    Number.isFinite(Date.parse(result.startedAt)) &&
    Date.parse(result.finishedAt) >= Date.parse(result.startedAt)
  );
}

export function gatePassed(receipt: GateReceipt | null): boolean {
  return receipt?.exitCode === 0 && receipt.outputMatched === true;
}

export function createIssueGateReceipts(input: {
  projectId: string;
  state: LeanStateStore;
  now(): Date;
  /** Re-read the current primary, PR head, owner recipe commit and exact argv, intake,
   * and protected paths. Claude approval comes from its head-bound local daemon session. */
  authorize(
    target: GateTarget,
    command: IssueGateCommand,
  ): Promise<{
    trusted: boolean;
    cleanProtectedPaths: boolean;
    claudeReviewedHead: string | null;
    configured: boolean;
  }>;
  /** The isolated validator calls authorizeLaunch after setup and before executing argv. */
  execute(
    target: GateTarget,
    command: IssueGateCommand,
    authorizeLaunch: () => Promise<boolean>,
  ): Promise<GateCommandExecution | null>;
}) {
  const active = new Map<string, Promise<boolean>>();

  async function authorized(target: GateTarget, command: IssueGateCommand): Promise<boolean> {
    const policy = await input.authorize(target, command);
    return (
      policy.trusted &&
      policy.cleanProtectedPaths &&
      policy.configured &&
      (command.where !== "host" || policy.claudeReviewedHead === target.head)
    );
  }

  function recorded(
    ledger: ReceiptLedger,
    target: GateTarget,
    command: IssueGateCommand,
  ): GateReceipt | null {
    const receipt = ledger.gateReceipts?.[identity(target, command)];
    if (!receipt || !matchesExecution(target, command, receipt)) return null;
    const boundCommand = { ...receipt, requiredOutput: receipt.requiredOutput ?? undefined };
    return identity(receipt, boundCommand) === identity(target, command) ? receipt : null;
  }

  async function run(target: GateTarget, command: IssueGateCommand) {
    if (!(await authorized(target, command))) return false;
    const id = identity(target, command);
    const previous = recorded(await input.state.read(input.projectId), target, command);
    if (previous) return gatePassed(previous);
    let launchAuthorized = false;
    const result = await input.execute(target, command, async () => {
      launchAuthorized = await authorized(target, command);
      return launchAuthorized;
    });
    if (!launchAuthorized || !result || !matchesExecution(target, command, result)) return false;
    if (Date.parse(result.finishedAt) > +input.now() || !(await authorized(target, command)))
      return false;
    const receipt: GateReceipt = {
      ...target,
      ...result,
      argv: [...command.argv],
      requiredOutput: command.requiredOutput ?? null,
    };
    const stored = await input.state.mutate(input.projectId, (current: ReceiptLedger) => {
      const receipts = (current.gateReceipts ??= {});
      receipts[id] ??= receipt;
      return recorded(current, target, command);
    });
    return gatePassed(stored);
  }

  async function runCommands(
    target: GateTarget,
    commands: readonly IssueGateCommand[],
  ): Promise<boolean> {
    for (const command of commands) {
      const id = identity(target, command);
      const task = active.get(id) ?? run(target, command);
      active.set(id, task);
      try {
        if (!(await task)) return false;
      } finally {
        if (active.get(id) === task) active.delete(id);
      }
    }
    return true;
  }

  return {
    async check(target: GateTarget, commands: readonly IssueGateCommand[]): Promise<boolean> {
      if (!validGateTarget(target) || !commands.length || !commands.every(validGateCommand))
        return false;
      return runCommands({ ...target }, structuredClone(commands));
    },
    async checkPhase(
      target: GateTarget,
      commands: readonly IssueGateCommand[],
      where: IssueGateCommand["where"],
    ): Promise<boolean> {
      if (!validGateTarget(target) || !commands.length || !commands.every(validGateCommand))
        return false;
      return runCommands(
        { ...target },
        structuredClone(commands.filter((command) => command.where === where)),
      );
    },
    async read(
      target: GateTarget,
      commands: readonly IssueGateCommand[],
    ): Promise<(GateReceipt | null)[]> {
      if (!validGateTarget(target)) return commands.map(() => null);
      const snapshot = { ...target };
      const requested = structuredClone(commands);
      const ledger = await input.state.read(input.projectId);
      return requested.map((command) =>
        validGateCommand(command) ? recorded(ledger, snapshot, command) : null,
      );
    },
  };
}
