# Task delivery

Only the Vorteo :: Builds thread runs the publishing and installation steps below. Other threads stop when their branch is ready and hand it to Builds; see [Builds coordinator](../AGENTS.md#builds-coordinator).

Use these scripts for the checks and operations described below. The ownership and delegation rules in the [agent guide](../AGENTS.md#builds-coordinator) are operating instructions, not a claim that scripts enforce every boundary; the guide's [authorization levels](../AGENTS.md#authorization-levels) decide how far a task may go. Each script prints what it checked and refuses rather than guessing. Tests live in [`scripts/agent-lifecycle.test.mjs`](../scripts/agent-lifecycle.test.mjs) and run in CI.

## Start in a task worktree

```sh
node scripts/task-worktree.mjs <slug> [--branch fix/<slug>] [--base origin/main]
```

The script fetches with pruning, then creates `../<repo>-<slug>` on a new `feat/<slug>` branch from the fetched base, with its own dependency install. Set `PASEO_TASK_WORKTREE_ROOT` or pass `--root` to choose another parent directory. Branch names start with `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `perf/` or `test/`, or `factory/` for a Factory issue claim; pass `--base origin/factory/issue-<n>` so the worktree tracks the claimed branch.

Use a dedicated task checkout for edits and reuse it for sequential work. Create separate filesystem worktrees when concurrent edits need isolation; read-only review needs none. Keep child agents in the builder's workspace. A worktree is filesystem isolation, not a new outcome or workspace.

The helper installs dependencies by default; `--no-install` skips that step but still fetches with pruning. When ref preservation or a no-pruning boundary applies, do not use the helper. Fetch with `git fetch --no-prune origin` and create the requested branch and worktree with `git worktree add -b <branch> <path> <base>`, preserving the authorized base. Do not install dependencies unless the task requires and permits it. Never edit the primary checkout, overwrite another task's changes or clean up refs as a side effect of preparation.

## Coordinate delivery

Builds owns actual build and release validation, integration, publication, installation and installation recovery. Existing feature and CI owners retain source defects and unrelated CI triage; send them exact evidence and acceptance checks. Keep only the delivery dependency in Builds' checklist, linking the upstream defect, current owner and condition for resumption. Do not expand the queue into broad implementation or a general make-CI-green project.

Use dynamically sized bounded subagents when authorized, within configured permissions, presets, budgets and actual enforced capacity. Run heavy builds through the [heavy-job queue](development.md#heavy-job-queue); spare agent capacity does not authorize a competing build. Reuse suitable available agents, assign explicit file ownership and independent review, and keep children in the builder's existing workspace. There is no permanent lane count. Preserve the existing owner workspace when routing work; a new workspace requires a distinct outcome without an existing owner and an explicitly authorized split. Consequential scope or ownership changes need a concise owner question unless already authorized; routine execution choices do not.

Reuse verified evidence when the source and relevant inputs are unchanged. Coordinate required build and release checks, rerunning affected checks when a change or unresolved failure invalidates evidence. Batch compatible deliveries while serializing integration, publication and lifecycle operations under Builds. Keep ready independent interface delivery moving despite unrelated server CI, daemon or recovery work unless an exact applicable gate requires a hold. Record that gate and the condition that clears it. Do not bypass, disable or weaken any required check.

Report published source, served interface and installed daemon revisions separately. `main` can advance before installation, and a static interface can be published without restarting the daemon. Preserve deployed ancestry and all existing CI, restart and approval gates; these instructions add no runtime enforcement or new permission.

## Builds delivery details

### Standing delivery authority

An instruction to ship authorizes the routine implementation, validation, integration, publication and installation steps covered by its authorization level. Builds owns scheduling, compatible batching, evidence reuse and ordinary recovery choices within that scope. Carry recorded authorization across handoffs and phases; do not ask the owner again merely because work reaches a new phase or a different worker performs it.

Resolve technical uncertainty by inspecting source and evidence and running proportionate validation. Reviewers identify defects, unmet acceptance checks and applicable existing gates; a review does not create a new permission requirement. Distinguish a technical check from an owner decision and from the recorded approval required by the tracked lifecycle workflow.

Ask the owner only when existing authorization leaves a consequential decision unresolved, such as a material change in outcome, irreversible action outside the agreed scope, or an exception to an explicit restriction. Prepare the concrete action and its consequences first, identify the exact restriction or missing decision, and combine related questions. Never ask again while the same question awaits an answer. Explicit holds, access boundaries, resource limits and tracked approvals remain binding; a general instruction to proceed does not silently remove them.

Builds has a standing responsibility to advance authorized deliveries, with finite goals and acceptance checks for each outcome. A blocked dependency pauses only dependent work. Continue other authorized work and resume when evidence clears the dependency. An empty queue is idle, not permission to invent work; an owner pause remains a pause. Record blockers with the condition that clears them, and report verified delivery rather than repeated preparation summaries.

**Install the moment work is ready.** When a change has its review and its failing checks are classified, Builds integrates and installs it immediately, without asking the owner. Waiving or deferring a non-required or pre-existing CI failure, and choosing when to install, are Builds' calls, not owner questions. Time windows from other threads, such as a renewal guard, only exclude that window; never defer ready work to "after" a window, to a later date or to the next batch. Before ending any turn, list green-but-unmerged PRs, ready-but-unsubmitted installs and queued work whose owner has gone quiet, and act on each one or record the concrete rule that forbids acting now. A lead that schedules its own next step for a later day is stalling; ask it to start now unless a named external event blocks it.

These rules are mandatory for delivery preparation and handoff.

- Feature implementation and unrelated CI triage belong to their existing feature or CI owners. Route source defects back with exact evidence and acceptance checks. Builds links the upstream defect and current owner as a concise delivery dependency, then verifies the returned fix. Do not turn its queue into broad feature implementation or a general make-CI-green project.
- Other threads prepare their task branches in dedicated checkouts and hand validated changes to Builds. Send the branch, head commit, checkout path, checks and evidence, intended outcome and authorization level (3 or 4). The installed `installation-maintenance` skill identifies Builds. Use the [handoff contract](#handoff-contract) for source, evidence, failed attempts, holds, acceptance and current ownership. A container agent that cannot reach Builds includes the same details in its Host handoff.
- Batch compatible deliveries and reuse verified evidence for unchanged source and relevant inputs. Run required integration and release checks, and rerun affected checks when source, inputs or unresolved failures invalidate prior evidence. Unrelated server CI, daemon or recovery work must not hold ready independent interface delivery unless an exact applicable gate requires it. Record that gate when blocking delivery; never skip or weaken it.
- Keep the operator able to tell progress from a stall. Before any wait longer than a few minutes, state what is being watched, when it started, its usual duration and the condition that ends it; report when it overruns. After each install receipt, complete delivered checklist items. Mark an item blocked only when it is stuck, with the reason and what clears it; work waiting on another owner names that owner and stays in Review.
- Preview from the task checkout with a dev server or the managed preview helper. Do not run web exports or release builds for previews. Run heavy validation through the [heavy-job queue](development.md#heavy-job-queue) and follow [Check your work](../AGENTS.md#check-your-work); do not run a full suite merely for handoff.

## Bounded delegation and workspace ownership

A workspace represents an outcome and its ownership, not a worker slot or filesystem checkout. When delegation is authorized, builders choose bounded subagents dynamically for implementation and independent review, within existing permissions, presets, budgets and actual enforced capacity. Run heavy builds through the [heavy-job queue](development.md#heavy-job-queue); available agent capacity is not build capacity. There is no permanent lane count. Reuse suitable available agents and assign exact scope, file ownership, acceptance checks and return conditions. Reviewers must be independent of the author.

Children inherit the builder's existing workspace; omit `workspaceId` when creating them. Separate concurrent editing worktrees do not require separate workspace tabs, and read-only reviewers need neither a new workspace nor a worktree. Preserve the existing owner workspace when routing work. Use a new workspace only for a distinct outcome that lacks an existing owner and has an explicitly authorized split. Delegation never grants integration, publication, installation or lifecycle authority; Builds remains the sole coordinator for those actions.

## Keep work bounded and recommend splits early

Reassess scope at the first substantial expansion or handoff and at least once per working day during continuing work. Proactively propose consequential optimizations or scope splits when outcomes need different owners or dependencies, two consecutive checkpoints add prerequisites without closing acceptance, or a working day produces no reviewable result.

First check existing ownership. Route work to an existing feature or CI owner before proposing another thread or workspace. Keep routine execution choices autonomous. Ask concise owner questions only for consequential tradeoffs, scope changes or new workspace placement that existing owner authorization does not resolve, with a recommended choice and its practical effect. Continue independent authorized work while waiting.

Explain what is prepared versus installed, the smallest complete delivery path and concrete blockers. Define a finish line and acceptance checks for each proposed outcome. A proposal does not authorize new agents or workspaces. An approved split preserves source, evidence, failed attempts, decisions, checklist state, file ownership and delivery constraints; use separate filesystem worktrees only where concurrent edits need isolation. Keep integration, publication and lifecycle with Builds, and do not count a handoff as implementation completion.

Reconcile duplicate or stale tasks against actual source, evidence and ownership. Preserve one authoritative task for each outcome and retain links to transferred dependencies and unfinished acceptance. Archive only explicitly authorized threads after reconciling their outputs and remaining ownership; an idle or completed worker is not archival permission. Follow [Archive requests](../AGENTS.md#archive-requests) for preservation and workspace handling.

Record deferrable debt found along the way in one deduplicated GitHub issue, at Level 3 or higher, or list it in your report otherwise, then return to the task. Do not widen the current delivery to fix it.

Accept explicit owner reports of successful everyday use as acceptance for the behavior they describe. Do not keep that behavior open solely for an additional synthetic test or optional monitoring. Do not widen the acceptance criteria or add infrastructure without showing why it is necessary for the requested outcome.

## Handoff contract

A handoff must identify the receiving owner and preserve that owner's workspace. Include these fields in a private handoff or task metadata, with no secrets:

| Field                       | Required content                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome and owner           | Requested result, current owner, receiving owner, existing workspace and exact file ownership.                                                                       |
| Source                      | Repository, branch, base and head commits, worktree location, exact patch and any uncommitted or untracked work.                                                     |
| Evidence                    | Checks run, results, source and input bindings, retained log or receipt locations, and what remains unverified. Identify unchanged evidence suitable for reuse.      |
| Failed attempts             | What was attempted, exact failure evidence, conclusions and exhausted approaches so the receiver does not repeat them blindly.                                       |
| Holds and authority         | Current authorization, owner decisions, approval and restart holds, cancellations, access limits and unresolved questions. A handoff grants no additional authority. |
| Acceptance and dependencies | Passed and remaining checks, upstream defect links and owners, concrete blockers, resumption conditions and the next bounded action.                                 |

The receiving owner reconciles the handoff with source and current evidence before continuing. Builds keeps a concise linked delivery dependency while the feature or CI owner retains implementation. Worker completion or transfer does not complete integration, publication, installation or unfinished acceptance.

### While Builds owns delivery

Keep the wait visible on your checklist. Hold an item such as "Builds merges and publishes the change" in Review, with owner `Vorteo :: Builds` and a short description of what you are waiting for. Mirror the steps Builds reports as checks and update them after each Builds report. Complete it only after you have verified `main` and the published interface yourself, and keep a separate pending item for that verification.

## Shared dependency installs

`node scripts/install-dependencies.mjs` installs a checkout's dependencies. Task worktrees and the workspace setup in `paseo.json` use it, and web builds use its library with `--mode build`. On macOS it keeps one complete install per lockfile under `~/.cache/vorteo-dependencies` and clones it into each checkout with APFS copy-on-write (`cp -c`). Every checkout gets its own `node_modules` trees, so workspace links such as `node_modules/@getpaseo/server -> ../../packages/server` still resolve inside that checkout, and edits never reach another one. Clones share disk blocks until a file changes.

On Linux, including the Dev container, installs run `npm ci` without the cache. Measured in Dev on 2026-11-08, copying a cached install onto the shared Projects folder took about 1m45s, against about 2 minutes for `npm ci`, for a 5.6 GB cache, so the cache stays macOS-only. Linux installs preload `scripts/lib/cp-sync-js.cjs`: Node's native `fs.cpSync` directory copy fails with EACCES on Dev's virtiofs mount on Node 22 and 24, and `@shopify/react-native-skia`'s postinstall uses it. The shim adds an accept-all filter unless the caller passes its own, which keeps those calls on Node's JavaScript copy.

The cache key covers the lockfile, every workspace `package.json`, `.npmrc`, the Node and npm versions, the platform and the install mode. Worktree mode also covers the dependency patches, because its full `npm ci` applies them. A cache miss runs a normal `npm ci` and then saves the result; a failed clone falls back to `npm ci`. In task worktrees and `paseo.json` workspace setup (`--queue`), a full `npm ci` waits for the environment's [heavy-job slot](development.md#heavy-job-queue), unless it already runs inside a heavy job or as Builds (`VORTEO_BUILDS=1`). Installer, coordinator, web build and live dev installs never queue, because they can run while the Builds gate holds the slot. The cache keeps the four most recently used installs. Other platforms, and `VORTEO_DEPENDENCY_CACHE=0`, always run `npm ci`. Do not replace this with one symlinked `node_modules`: Node resolves symlinks to real paths, so every workspace import would load from one checkout.

<a id="publish-to-main"></a>

## Deliver to `main` through a pull request

Every change reaches `main` through a pull request, including Builds' integrations and upstream Paseo merges. Nobody pushes `main` directly: the pre-push hook refuses it for everyone, and the checked-in [GitHub rulesets](release.md#github-rulesets) enforce it on GitHub once applied.

```sh
node scripts/publish-main.mjs [--no-merge] [--pr <number>] [--delete-branch] [--title <text>] [--body-file <path>] [--dry-run]
```

Run it from Builds in the clean integration checkout, on a named branch. It refuses local changes, `main` or a detached HEAD, a missing Gitleaks binary and a ruleset without required checks. A branch behind `origin/main` is fine. It then:

1. Pushes the branch without force and opens its pull request, or reuses this repository's open one once GitHub reports the pushed head. Every call names the repository, because `gh` in this fork otherwise targets upstream Paseo.
2. Refuses a pull request that GitHub reports as conflicting with `main` (`mergeable` `CONFLICTING` or merge state `DIRTY`): merge `origin/main` into the branch, resolve the conflicts, commit with a change fragment and publish again. It checks [who may merge](#who-merges), then waits for the required checks listed in [`.github/rulesets/main.json`](../.github/rulesets/main.json), reported by GitHub Actions on the exact head commit. Only success passes. A failed or neutral run stops it; a cancelled run gets a few polls for its replacement, then stops. A skipped `format`, `lint` or `typecheck` satisfies the rule only when `changes`, whose path filter decides those jobs, passed on the same commit; it is reported as skipped, not as validation. Any other skip fails.
3. Checks the review and conflicts again, then merges with a merge commit pinned to that head (`--match-head-commit`). When the checked-in ruleset has a merge queue, it instead calls GraphQL `enqueuePullRequest` with `expectedHeadOid` pinned to the verified head. It waits until GitHub reports it merged, printing the queue position and state as they change, for up to six hours; rerunning with `--pr <number>` keeps waiting without enqueueing it twice. It refuses when the pull request closes, its head moves, or it leaves the queue unmerged, which GitHub does when its merge group fails the required checks or conflicts. Finally it proves `main` contains both the merge commit and the head.

The branch is kept by default, so recovery branches and preservation holds survive delivery. `--delete-branch` deletes it after the verified merge unless it moved; a failed deletion is reported without undoing the merge. `--no-merge` opens the pull request and stops. `--pr <number>` merges an existing pull request instead of the current branch.

Merge commits are deliberate. An installation installs its own commit before it pushes, and a merge commit keeps that exact commit in `main`'s history, so ancestry proves the installed source is published. Squash and rebase merges would give `main` a different commit, so the merge queue also merges with merge commits. The queue builds a temporary merge group of `main`, the pull requests ahead and this one, runs the required checks on it and fast-forwards `main` to it once every entry passed. A branch therefore never needs `main` merged in just because `main` moved, and a release preparation keeps its version. GitHub's merge commit does not run the version hook. Only release preparation changes the version, so a clean merge carries whichever side prepared one; two concurrent preparations conflict at the top of the changelog. Fragments are separate files, so a clean merge keeps them all.

The required checks are a floor for every merge. They never replace Builds' integration and release checks, independent review, rollback plans or installation acceptance, and a merge is not an installation.

### Delivery order

- **Level 3** merges source to `main` without installing it.
- **Level 4 on an installation used to develop Vorteo**: integrate and validate, install, accept the install, then merge the same day. Interface-only changes install by guarded static publication with no daemon restart; daemon and protocol changes use the tracked lifecycle workflow and its approval. If `main` moved meanwhile, deliver the installed commit as is: the merge queue merges it with `main`, and the installed commit stays an ancestor of `main`. Merge `main` into the branch only when GitHub reports a conflict.
- **An installation that follows a release channel**, such as production, installs only [tagged releases](release.md#vorteo-releases), through the same tracked source-update approval. Every installation is the same kind; only its use differs.

### Who merges

- **This installation's own work.** A same-repository pull request authored by the GitHub account running Builds merges once the required checks pass, when that account is the personal repository owner, a verified active owner of the repository organization, or a delegated approver and no change request blocks it. Anyone who can push to its branch already has write access. Zero approving reviews are required: GitHub does not let an account approve its own pull request.
- **Everything else**, including contributors' fork pull requests and branches pushed by other accounts, waits for the owner. It merges only when the owner or an explicitly delegated approver has approved its exact head and still has write access, confirmed through GitHub's permission API rather than the review's association label. Delegates are listed in [`.github/delivery-approvers.json`](../.github/delivery-approvers.json), read from the base branch so a pull request cannot add its own approver; add one only at the owner's explicit request. Write access alone never delegates approval. Approvals from the GitHub account running Builds do not count: agents share that account's token, so its approval proves no human decision. While Builds runs as the owner's account, the owner merges contributors' pull requests on GitHub, or an approver with a separate account approves them.
- **Change requests** from a reviewer with write access block every merge, this installation's own included, until that reviewer approves or the review is dismissed. Each reviewer's latest decision counts. The check runs again right before the merge; GitHub enforces no review gate, so a review submitted in the seconds before the merge is not seen; this is a known limitation, not an atomic approval guarantee.

### Parallel branches and change fragments

Ordinary commits change neither the [Vorteo version](release.md#vorteo-versions) nor the top of the changelog and inventory; each adds its own [change fragment](release.md#change-fragments). Parallel branches therefore conflict only where they change the same code, or around a release preparation. Deliver a branch without merging `origin/main` first. When GitHub reports a conflict, merge `origin/main` into the branch, resolve it, keep every fragment, and commit; the fragments the merge brings in satisfy the commit hook. Builds integrates a contributor's branch on its own branch only after the owner approves that pull request, either as above or by an explicit request in the owner's own words naming it. That keeps the contributor's commits, and GitHub marks their pull request merged when its head reaches `main`.

## Deliver to the Host

The Host updater installs only source that descends from the installed release, and it folds in published interface records. Build the update from the installed source, then merge `main`:

```sh
node scripts/prepare-host-delivery.mjs --checkout <delivery-dir> \
  --source-repo <installation source repository> --installed <installed commit>
```

Read the installed commit from the current release's activation record and the source repository from the installation's update request. Keep these paths out of Git. Each run takes one step: it resets a new checkout to the installed commit, or starts the next merge of a newer installed release, a published record, or `main`. A newer installed release that already contains the branch is reached by fast-forward. Release-note conflicts keep both sides, and manifest conflicts that differ only in Vorteo version strings keep the installed side. Resolve any other conflict yourself. Finish each merge with `npm run version:vorton`, a change fragment when the merge brings none, and a normal commit, then run the script again until it reports ready. Install the result with the installation client, then deliver it to `main` through a pull request.

Deliver installed source to `main` the same day. A Host that runs ahead of GitHub blocks the next update from `main`. If `main` moved meanwhile, deliver the installed commit as is; the merge queue merges it with `main`, and the installed commit stays an ancestor of `main`.

## Restart control path

This section describes how Builds submits and follows requests. Other threads hand their work to Builds instead. The non-negotiable rules are in the [agent guide](../AGENTS.md#required-restart-control-path).

When the owner's full maintenance delegation is active, every fresh Host-credential request is approved after its thirty-second cancellation window, except the operations its exclusion list names (today, agent instruction and guardrail edits, snapshot restore and source upgrade rollback, and accounts and credentials); each capability's `ownerApprovalRequired` reports it, so observe the recorded decision instead of asking for a click. Otherwise, when the owner has saved automatic maintenance permission for a target and `capabilities` reports `ownerApprovalRequired: false` for it, restart and source-update requests submitted with the Host credential are approved automatically for both Host and Dev targets. Inspect the recorded request decision rather than asking for a click or a chat approval. Requests made with the Dev credential, and batches containing a Dev contribution, still require the owner's button approval. Do not enable the policy yourself, impersonate a Host requester, transfer Host credentials, or treat routine automatic approval as coordinator or supervisor maintenance authority.

For authorized work, prepare and submit required restart or installation requests without asking permission in chat to create them. Present the exact request's review link and a short description of the target and interruption to whoever decides it: the installation lead when the owner has delegated approvals, otherwise the owner. That decision in Installation controls is the approval; do not require a verbal reply before or after it. Observe the recorded decision and continue automatically when approved. Only the delegated installation lead approves on the owner's behalf, within its recorded grant. A changed source, plan or request revision requires its own button approval.

### Front doors

Every new installation lifecycle or settings operation ships, in the same change, with an agent request command in `scripts/installation-agent.mjs`, delegated admission under the full maintenance grant through the shared exclusion list in `delegated-admission.ts`, and live status with Cancel in Installation controls. Do not ship an owner-only operation and convert it later. The front-door test fails when an owner route in `front-door.ts` has no agent command, exclusion on that list, or pinned entry. Read-only views, owner sessions, grant management and release upgrades are pinned exemptions. Existing owner operations without an agent door are a pinned gap list; it only shrinks, and a new route never joins it.

Lifecycle and settings operations that change the installation get a pending request with the thirty-second window and Cancel. Read-only or non-disruptive actions, such as a safety snapshot or helper recovery verification, get an immediate door instead: the grant is checked at the call, the action runs at once and Installation controls history keeps its receipt under **Agent actions**. The front-door test refuses an immediate door for any handler that restarts, installs or changes configuration.

This rule also applies to coordinator maintenance. If the installed system cannot represent an operation with a visible request and approval button, report that specific capability gap and prepare the missing managed workflow. Do not substitute chat approval, a plain daemon request or an untracked service operation. Instruction changes do not themselves add coordinator reload support.

Every Host or Dev daemon restart, supervisor replacement, and preparatory finish-turns hold must use the installation coordinator's tracked lifecycle workflow. The request must be visible in the sidebar and installation controls, with live status and owner cancellation before dispatch. Chat approval does not authorize bypassing these controls.

Never call daemon drain/restart RPCs directly or use launchctl, supervisorctl, Docker restart, kill, or a private polling loop to perform or manage a Host/Dev daemon restart outside that workflow. Do not create an invisible hold while waiting for agents to finish. If the coordinator cannot represent the required operation, extend and validate the managed workflow before placing a hold or interrupting anything. Supervisor maintenance is not an exception. Report the unsupported operation explicitly; do not substitute a worker restart or fabricate a coordinator receipt.

### Source updates

For daemon or protocol deployment, inspect the maintenance client's `capabilities` and use `request-restart --target host|container-daemon --update` for each affected target. Host installs its daemon and shared interface; Dev installs its daemon in the existing container. Complete validation before submitting, retain contribution receipts, and wait for the recorded approval, automatic or by the owner. Prefer guarded static publication for interface-only changes. If that operation is unavailable from the current environment, inspect the supported Host source updater before declaring delivery blocked. When it is available, prepare and submit the validated source with `request-restart --target host --update`, then return its exact review link and explain that approval installs the Host daemon, restarts Host and publishes the interface. Do not ask for chat permission to prepare or submit the request. Wait for the recorded approval before execution. A plain restart does not install code. Hand off only when both the applicable static route and managed source-update route are unavailable or concretely refused; report the observed failure. Preview-only requests still stop at preview delivery.

## Deliver in live dev mode

On an installation whose Delivery mode is Live dev, the owner's browser runs the Host's live checkout (`live/main`), so interface delivery is a change to that checkout rather than a publication. Use `node scripts/live-dev.mjs`; see [live dev mode](live-dev-mode.md).

- **One-off tweaks.** `claim --by <thread> <files>`, edit the files in the live checkout, check the result in the browser, then `commit --by <thread> -m <message>`. Commits run the repository hooks; `commit` writes the change fragment from `--note`, or from the message. Release a claim you abandon with `release`.
- **Task branches.** Validate in your task worktree as usual, then `promote <branch> --by <thread>`. It refuses while the live checkout has uncommitted edits and aborts on conflicts without changing anything.
- **Main.** Builds publishes `live/main` to `main` through the usual pull request the same day, then runs `sync` to merge `main` back. A live checkout that runs ahead of `main` overnight is the same problem as a Host that runs ahead of GitHub.
- **Daemon and protocol changes** still use the tracked lifecycle workflow; live mode only changes how the interface is served. Gate interface work on daemon capabilities as usual, because the live interface may run ahead of the installed daemon.
- **Status.** `status` shows the branch, how far it is ahead of `main`, claims and uncommitted edits. Check it before you edit.

## Archive a task

```sh
node scripts/archive-readiness.mjs [worktree] [--installed <commit>]
```

The check passes when the worktree has no uncommitted or untracked files and every commit is on `origin/main`. Commits that arrived by cherry-pick, rebase or squash count. Pass `--installed` for work that must be running on the installation. Exit status 0 means ready, 1 means blocked with the reasons listed, and 2 means the check could not run.

When the check passes and the task's completion criteria hold, end your report by offering to archive. Archive only when the owner asks. Reconcile duplicate or stale tasks, thread outputs and remaining ownership before authorized archival. The check does not grant archival permission or replace inspecting the workspace's threads and preserving unrelated work.

## Clean up worktrees

```sh
node scripts/worktree-cleanup.mjs [--apply] [--idle-hours 24]
```

Without `--apply` it only reports. It removes a worktree only when the archive check passes and its Git index has been idle for the window, then deletes the branch if all its work is on `origin/main`. It keeps locked, dirty, unpublished, recently used and protected-branch worktrees. Git itself refuses to remove a worktree with changes. A shared repository also lists worktrees from other environments, such as the Dev container; they look missing from here and stay unless you pass `--prune-missing`. Run `--apply` only for worktrees your task owns or with the owner's approval.
