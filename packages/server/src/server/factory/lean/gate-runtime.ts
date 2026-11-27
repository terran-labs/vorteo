import { isDeepStrictEqual } from "node:util";
import { createGateCommandRunner } from "./gate-command-runner.js";
import {
  createIssueGateReceipts,
  gatePassed,
  type GateReceipt,
  type GateTarget,
  type IssueGateCommand,
} from "./gate-receipts.js";
import type { LeanStateStore, PullRef } from "./types.js";

export type HostedGateState = PullRef["checks"] | "absent";

export interface IssueGateInputs {
  issue: number;
  repository: string;
  head: string;
  configCommit: string;
  commands: readonly IssueGateCommand[];
  hostedChecks: HostedGateState;
  /** Fresh approved intake and a unique, live local claim for this exact head. */
  trusted: boolean;
  protectedPaths: readonly string[];
}

type GateExecutionOptions = Omit<Parameters<typeof createGateCommandRunner>[0], "primary" | "now">;

export interface PrimaryGateRuntimeOptions {
  projectId: string;
  repository: string;
  state: LeanStateStore;
  /** Immutable for this runtime. A different installation can never run or attest its gates. */
  primary: string;
  here: string;
  now(): Date;
  holdsPrimary(): Promise<boolean>;
  readInputs(issue: number, head: string): Promise<IssueGateInputs | null>;
  /** Check the daemon's approved Claude runner binding for this head, never a replayed review. */
  approvedClaudeHead(issue: number, head: string): Promise<string | null>;
  /** Omit when the primary has no trusted credential-free execution boundary. */
  execution?: GateExecutionOptions;
}

type GateStep = "container" | "host" | "complete";
type ParkReason = "primary" | "unverified" | "hosted-checks" | "review" | "executor" | "commands";

export type IssueGateProgress =
  | { kind: "ready"; head: string; configCommit: string; receipts: GateReceipt[] }
  | { kind: "parked"; reason: ParkReason; detail: string };

function parked(reason: ParkReason, detail: string): IssueGateProgress {
  return { kind: "parked", reason, detail };
}

function hostedReady(input: IssueGateInputs): boolean {
  return (
    input.hostedChecks === "passing" ||
    (input.hostedChecks === "absent" && input.commands.length > 0)
  );
}

function phaseCommands(input: IssueGateInputs, step: GateStep): readonly IssueGateCommand[] {
  return step === "complete"
    ? input.commands
    : input.commands.filter(({ where }) => where === step);
}

export function createPrimaryGateRuntime(options: PrimaryGateRuntimeOptions) {
  const { primary, here, projectId, repository, state, now } = options;
  const execute = options.execution
    ? createGateCommandRunner({ ...options.execution, primary, now })
    : async () => null;

  async function ownsPrimary(): Promise<boolean> {
    return here === primary && (await options.holdsPrimary());
  }

  async function fresh(issue: number, head: string): Promise<IssueGateInputs | null> {
    const input = await options.readInputs(issue, head).catch(() => null);
    if (input?.issue !== issue || input.repository !== repository || input.head !== head)
      return null;
    return input;
  }

  function targetForInputs(input: IssueGateInputs): GateTarget {
    const { issue, head, configCommit } = input;
    return { issue, head, repository, primary, configCommit };
  }

  const receipts = createIssueGateReceipts({
    projectId,
    state,
    now,
    execute,
    async authorize(target, command) {
      const refused = {
        trusted: false,
        cleanProtectedPaths: false,
        configured: false,
        claudeReviewedHead: null,
      };
      if (target.primary !== primary || !(await ownsPrimary())) return refused;
      const input = await fresh(target.issue, target.head);
      if (!input || input.configCommit !== target.configCommit || !hostedReady(input))
        return refused;
      return {
        trusted: input.trusted,
        cleanProtectedPaths: input.protectedPaths.length === 0,
        configured: input.commands.some((entry) => isDeepStrictEqual(entry, command)),
        claudeReviewedHead:
          command.where === "host"
            ? await options.approvedClaudeHead(target.issue, target.head)
            : null,
      };
    },
  });

  function available(where: IssueGateCommand["where"]): boolean {
    const boundary = options.execution?.boundaries[where];
    return boundary?.machine === primary && boundary?.where === where;
  }

  async function inspect(
    issue: number,
    head: string,
    step: GateStep,
    run = true,
    expectedConfigCommit?: string,
  ): Promise<IssueGateProgress> {
    if (!(await ownsPrimary()))
      return parked("primary", "Wait for the configured Factory primary.");
    const input = await fresh(issue, head);
    if (!input?.trusted || input.protectedPaths.length > 0) {
      return parked("unverified", "Verify the current claim, owner recipe, and protected files.");
    }
    if (expectedConfigCommit !== undefined && input.configCommit !== expectedConfigCommit) {
      return parked("unverified", "The owner recipe changed between gate phases.");
    }
    if (!hostedReady(input)) {
      return parked(
        "hosted-checks",
        input.hostedChecks === "failing"
          ? "Resolve the failing hosted checks on the current head."
          : "Wait for verified hosted checks, or configure an issue recipe when there are no hosted checks.",
      );
    }
    const selected = phaseCommands(input, step);
    if (
      selected.some(({ where }) => where === "host") &&
      (await options.approvedClaudeHead(issue, head)) !== head
    ) {
      return parked(
        "review",
        "Wait for approved Claude review on the exact head before running Host gates.",
      );
    }
    const saved = await receipts.read(targetForInputs(input), selected);
    if (saved.every(gatePassed)) {
      return {
        kind: "ready",
        head,
        configCommit: input.configCommit,
        receipts: saved.filter((entry) => entry !== null),
      };
    }
    if (saved.some((receipt) => receipt !== null && !gatePassed(receipt))) {
      return parked("commands", "A configured issue command failed on this head.");
    }
    if (selected.some(({ where }, index) => !saved[index] && !available(where))) {
      return parked(
        "executor",
        "Wait for a trusted credential-free executor on the configured primary.",
      );
    }
    if (step === "complete" || !run)
      return parked("commands", "Wait for the remaining issue command receipts.");
    if (!(await receipts.checkPhase(targetForInputs(input), input.commands, step))) {
      return parked("commands", "Wait for the configured issue commands to pass on this head.");
    }
    return inspect(issue, head, step, false, input.configCommit);
  }

  return {
    /** Run only configured container commands before the exact-head Reviewer receives the pull. */
    beforeReview: (issue: number, head: string) => inspect(issue, head, "container"),
    /** Run only configured Host commands following verified exact-head Claude approval. */
    async afterReview(issue: number, head: string) {
      const container = await inspect(issue, head, "container", false);
      return container.kind === "ready"
        ? inspect(issue, head, "host", true, container.configCommit)
        : container;
    },
    /** Read fresh policy and completed receipts without starting commands. */
    readyForAcceptance: (issue: number, head: string) => inspect(issue, head, "complete"),
  };
}
