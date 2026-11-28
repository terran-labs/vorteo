import type { PausedCleanupOutcome, PausedMachineCleanup } from "../runtime.js";
import type { LeanLedger, LeanStateStore } from "../types.js";
import { createGitClaimStore, type GitClaimStoreOptions } from "./claim-git.js";
import { releaseSavedClaim, releaseSavedHostClaim, SavedClaimReleaseRefusal } from "./claims.js";
import { verifyMachinePayload } from "./host-key.js";
import type { MachineRoles } from "./roles.js";

interface PauseLedger extends LeanLedger {
  pausedMachineCleanups?: Record<number, PausedCleanupOutcome>;
}

interface PauseScope {
  projectId: string;
  issue: number;
  installation: string;
  primary: string;
  state: LeanStateStore;
  git: Pick<GitClaimStoreOptions, "cwd" | "repository" | "localRemote">;
  now(): Date;
  isOwnerPaused(): Promise<boolean>;
  /** Fresh custody for this issue's exact assigned native Host worktree, including after archival. */
  canVerifySavedWork(): Promise<boolean>;
  chargeMutation(): Promise<void>;
  /** Read the canonical remote issue branch without opening a Builder checkout. */
  readWorkHead(issue: number): Promise<string | null>;
}

type PauseRoles = Pick<MachineRoles, "here" | "primary">;
function hasMachineKeys(roles: PauseRoles): roles is MachineRoles {
  return "publicKeysFor" in roles && typeof roles.publicKeysFor === "function";
}
type PausedCleanupOptions = PauseScope &
  (
    | {
        mode: "unsigned-host";
        refreshPinnedRoles(): Promise<PauseRoles | null>;
      }
    | {
        mode?: "signed-dev";
        refreshPinnedRoles(): Promise<MachineRoles | null>;
        sign(payload: Uint8Array): Promise<string>;
      }
  );

interface ConfirmedRelease {
  generation: string;
  head: string;
  expiresAt: string;
}

const savedWorkUnavailable =
  "No trusted saved-work check is available for this Builder worktree. Its worktree and claim were kept.";

export function createPausedMachineCleanup(options: PausedCleanupOptions): PausedMachineCleanup {
  const { installation, projectId, issue, state } = options;
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error("Invalid Factory issue number.");
  let confirmed: ConfirmedRelease | undefined;
  let refusal: { generation: string; reason: string } | undefined;
  let releasing = false;

  function requireIssue(requestedIssue: number): void {
    if (requestedIssue !== issue)
      throw new Error("The paused cleanup belongs to a different Factory issue.");
  }

  async function requirePaused(): Promise<void> {
    if (!(await options.isOwnerPaused()))
      throw new Error("The Factory project is no longer paused.");
  }

  async function verifiedCustody(): Promise<boolean> {
    try {
      return await options.canVerifySavedWork();
    } catch {
      return false;
    }
  }

  async function readPausedRoles(): Promise<PauseRoles | MachineRoles> {
    await requirePaused();
    if (!(await verifiedCustody())) throw new Error(savedWorkUnavailable);
    const roles = await options.refreshPinnedRoles();
    if (roles?.here !== installation || roles.primary !== options.primary) {
      throw new Error("Factory could not verify the paused project's placement and primary.");
    }
    if (
      options.mode !== "unsigned-host" &&
      (!hasMachineKeys(roles) || roles.publicKeysFor(installation).length === 0)
    )
      throw new Error("Factory could not verify the paused project's signing authority.");
    await requirePaused();
    return roles;
  }

  return {
    async assertPaused() {
      await readPausedRoles();
    },

    async release(input) {
      requireIssue(input.issue);
      if (releasing || confirmed) throw new Error("A paused claim release is already pending.");
      releasing = true;
      refusal = undefined;
      const { claimGeneration, savedHead } = input;
      try {
        let roles = await readPausedRoles();
        async function assertPaused() {
          roles = await readPausedRoles();
        }
        const release = {
          repository: options.git.repository,
          installation,
          now: options.now,
          readWorkHead: options.readWorkHead,
          assertPaused,
          openReleaseStore: (authorizePush: () => Promise<void>) =>
            createGitClaimStore({
              ...options.git,
              namespace: "claims",
              async chargeMutation() {
                await assertPaused();
                await options.chargeMutation();
                await authorizePush();
              },
            }),
        };
        const { expiresAt } =
          options.mode === "unsigned-host"
            ? await releaseSavedHostClaim(release, input)
            : await releaseSavedClaim(
                {
                  ...release,
                  sign: options.sign,
                  verify: (holder, payload, signature) =>
                    hasMachineKeys(roles) &&
                    roles
                      .publicKeysFor(holder)
                      .some((key) => verifyMachinePayload(key, payload, signature)),
                },
                input,
              );
        confirmed = { generation: claimGeneration, head: savedHead, expiresAt };
      } catch (error) {
        if (error instanceof SavedClaimReleaseRefusal) {
          refusal = { generation: claimGeneration, reason: error.message };
        }
        throw error;
      } finally {
        releasing = false;
      }
    },

    async record(input) {
      requireIssue(input.issue);
      if (releasing) throw new Error("A paused claim release is already pending.");
      const { claimGeneration, archivedBuilderId, result } = input;
      await requirePaused();
      const release = confirmed;
      if (release && result.kind !== "released")
        throw new Error("The verified paused release must be recorded before another outcome.");
      if (
        result.kind === "released" &&
        (!release || release.generation !== claimGeneration || release.head !== result.savedHead)
      ) {
        throw new Error("Factory has no verified paused release to record.");
      }

      const refused = refusal;
      const blockedReason = async () => {
        if (refused?.generation === claimGeneration) return refused.reason;
        return (await verifiedCustody()) ? undefined : savedWorkUnavailable;
      };
      const reason = result.kind === "blocked" ? await blockedReason() : undefined;
      const outcome: PausedCleanupOutcome = reason
        ? { ...input, result: { kind: "blocked", reason } }
        : input;
      const snapshot = await state.read(projectId);
      await requirePaused();
      await state.mutate(
        projectId,
        (ledger: PauseLedger) => {
          (ledger.pausedMachineCleanups ??= {})[issue] = outcome;
          if (archivedBuilderId && claimGeneration !== null) {
            const runner = ledger.runners[archivedBuilderId];
            if (
              runner?.agentId === archivedBuilderId &&
              runner.issue === issue &&
              runner.role === "lead" &&
              runner.serverId === null &&
              runner.closedAt === null
            ) {
              runner.closedAt = options.now().toISOString();
              runner.closeReason = "Factory paused this issue.";
            }
          }
          const lease = ledger.leases[issue];
          if (
            outcome.result.kind === "released" &&
            lease?.issue === issue &&
            lease.installation === installation &&
            lease.expiresAt === release?.expiresAt
          ) {
            lease.released = true;
          }
        },
        snapshot.revision,
      );
      if (confirmed === release) confirmed = undefined;
      if (refusal === refused) refusal = undefined;
    },
  };
}
