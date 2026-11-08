# Factory

Factory runs a project's GitHub repository with five standing role agents. Turn it on from the project menu or with `vorteo factory project enable <project-id> --repository owner/name`. The daemon then creates, or adopts, one workspace per role in that project, each with one chartered agent and one heartbeat:

| Role ID            | Role     | Workspace               | Heartbeat      | Job                                                              |
| ------------------ | -------- | ----------------------- | -------------- | ---------------------------------------------------------------- |
| `factory-triage`   | Triage   | `<Project> :: Triage`   | `0 8 * * *`    | Decides which issues are ready and helps unready ones get ready. |
| `factory-intake`   | Foreman  | `<Project> :: Foreman`  | `*/10 * * * *` | Turns ready issues into reviewed, merged pull requests.          |
| `factory-builds`   | Builds   | `<Project> :: Builds`   | `*/15 * * * *` | Deploys merged commits and verifies them where they run.         |
| `factory-releases` | Releases | `<Project> :: Releases` | `0 9 * * *`    | Tags accepted commits and writes release notes.                  |
| `factory-mechanic` | Mechanic | `<Project> :: Mechanic` | `0 * * * *`    | Sets the Factory up, then keeps it stable and efficient.         |

The charters ship in [`packages/server/src/server/factory/project/charters/`](../packages/server/src/server/factory/project/charters/) and become each agent's system prompt. The daemon itself never merges, deploys, tags, installs or restarts anything; the agents do that through their charters and the repository's own tools.

**State.** The daemon records role agents, workspaces, the repository, enablement, launches, status lines, project instructions and heartbeat memory in `$PASEO_HOME/factory/projects.json`, written atomically. Each role agent is also labelled `vorteo.factory-role=<projectId>:<roleId>`. Enable looks for a role's agent in the state file, then by that label, then in `--adopt <role>=<agentId>`, and creates one only when all three come up empty, so reruns, restarts and a lost state file never produce a second agent. Adopting labels the existing agent, binds its workspace and sends it the charter. A damaged state file makes the project report `unavailable` and refuses changes until it is fixed or removed.

**Membership.** Role workspaces carry `factoryMembership` with installation `project-factory:<projectId>`, so they show in the sidebar's Factory folder and refuse archive and removal. The wire role enum stays `factory | builds | worker`: Builds travels as `builds` and the other roles as `factory`; the state file keeps the real role. On Vorteo System the Mechanic adopts the existing Optimizer agent, whose workspace keeps only its system membership, and the Optimizer's daily review heartbeat is paused while Factory is on. The state file records that Factory owns the pause before pausing, so startup finishes a pause or resume that a crash or failure interrupted.

**Heartbeats.** The Factory service owns its heartbeat timers instead of adding entries to Schedules, because a Schedules heartbeat cannot skip an unchanged tick or carry changed instructions once. Triage, Foreman and Builds wake only when the GitHub state they react to has changed, when something is pending for them, or at least every six hours; GitHub errors always wake. Releases and Mechanic always wake. A busy agent is left alone until its next tick. Pause stops the heartbeats and resume restarts them. Turning Factory off stops them and removes membership; workspaces, agents and history stay, and turning it on again reuses them.

**Project instructions.** Operators can add instructions per role with `vorteo factory project instructions set <project-id> <role-id> --file <path>`. They follow the shipped charter in the agent's system prompt. Effective instructions depend on every charter input (repository, project name and kind) as well as the additions, so any change, such as turning Factory on again with a new repository, updates the stored system prompt and is sent once with the next heartbeat. When a Vorteo update changes a role's shipped charter, the role is flagged for review and its Mechanic is told; a notice that fails to reach it is retried on the next start or Mechanic heartbeat. it acknowledges or proposes revised instructions, and the operator accepts or dismisses the proposal with `instructions resolve`. Until then the agent runs the new charter with the old instructions.

**Configuration.** `vorteo factory project configure` sets a role's provider and profile and the profiles the Foreman gives workers and reviewers. An unset role launch uses the same default the Optimizer uses; clearing a configured launch switches the agent to that default once. A launch set by profile alone uses that profile's provider. A switch starts the new session with the role's instructions ahead of the carried context and sends them again in full with the next prompt, which follows the switch right away. `vorteo factory project status set <project-id> <role-id> "<line>"` records a one-line role status without waking anyone. Sending a thread to the Factory asks Triage to turn it into one issue.

**Worker accounts.** Right before creating a lead, worker or reviewer, the Foreman runs `vorteo factory project pick-account <project-id> <planner|worker|reviewer> --issue <n>`, adding `--avoid <account>` with the worker's account for a reviewer. The daemon refreshes usage and considers every ready account of the stage profile's provider type, such as every Codex account for a Codex profile. An account qualifies only with an available reading at most five minutes old and a known remaining percentage in every window; it scores by its lowest window, and 0% is exhausted. The highest score wins, with ties going to the installation's default provider. The Foreman starts the agent on that account and labels it `factory.account=<account>`. When nothing qualifies, or usage cannot be read, it uses the configured default as before, so quota never blocks work. Only a `shared-profile/<type>/<workflow>` profile, or no profile, is ranked: a local profile or an older `shared-workflow/<account>/…` reference is bound to its own account, so the command returns that account unranked. With planning on, the Foreman runs it for the lead's worker and sends the account in the lead's go; leads and workers never call the Factory service. The service keeps the last 50 choices in the state file. This chooses an account at launch only: it does not switch a running agent, pool accounts or enforce a reserve, and one account listed under two aliases counts twice.

**Issue isolation and dispatch.** Each issue gets exactly one claim branch, one task worktree, one lead, one worker, one reviewer and one pull request; the Foreman never combines issues, and asks Triage to make related issues one. A lead lists every file it expects to change in its plan, then waits for the Foreman's go before starting its worker. The Foreman compares those files with work already started: issues whose worker has its go, and every open pull request from a `factory/` branch from any installation. Waiting plans never block each other; among overlapping waiting plans the oldest issue goes first. An issue that overlaps started work is deferred, holds no worker slot, and is checked again when that work merges or changes. With planning off, the Foreman posts the Files list itself and applies the same check. A worker that needs a file outside the list stops until the Foreman clears the wider plan. The Foreman sends no go while the project is paused or draining. After each merge the Foreman removes that issue's worktree when it is clean and contained in the default branch, and tells each in-flight issue whose files overlap the merged change to merge the default branch now, so conflicts appear early instead of at merge time. The merge queue batches merges; Factory does not batch work.

**Draining before a restart.** `vorteo factory project list` shows every project the Factory service knows, with its state, repository and pause. Before a restart or upgrade, Builds runs `vorteo factory project pause-all --reason "<text>"` (the reason defaults to "drain before restart"). It pauses every project whose Factory is on and records, per project, that pause-all paused it, with the reason and time. Projects already paused, turned off or unavailable are left alone. Because stopping heartbeats does not reach a Foreman already mid-turn, each paused project's Foreman also gets one drain notice, steered into its current turn when busy: admit no new work, let running workers finish and push, then set its status line to "Drained <id>: <n> workers still finishing". Every drain gets a new id, shown by `list`, `pause-all`, `resume-all` and `project show`, and starting a drain clears the Foreman's status line, so Builds accepts only the current drain's acknowledgment. Unavailable or archived projects get no notice; theirs stays pending until they are restored. The notice is recorded once it is sent, and a failed send is retried by the next pause-all. Resume-all tells each resumed Foreman "Drain ended: resume normal intake." A damaged state file makes all three commands refuse instead of reporting an empty or successful drain. Afterwards `vorteo factory project resume-all` resumes only the projects pause-all paused, so a project an operator paused by hand stays paused. A manual pause, resume or turn off takes a project out of the drain. Both commands are safe to rerun, and the record survives a daemon restart.

**Release tags.** `VORTEO_RELEASES=1` admits only `scripts/vorteo-release.mjs tag` and the release tag push it makes. Everything else that writes shared state still requires `VORTEO_BUILDS=1`.

## Several installations on one repository

Several Vorteo installations can run Factory against the same GitHub repository. GitHub, not timing, decides which one works on each issue. An installation's name is `<serverId>/<projectId>`, such as `srv_dDYiqxDpCkRy/prj_cb8cd4328bd060f1`; `vorteo factory project show` prints it as Installation. It holds no secrets.

**Do not run a second Factory against a repository until every installation that runs Factory on it has this release.** Earlier releases do not claim issues and would work on another installation's issues. There is no cross-installation version check.

**Claims.** Before admitting an issue, and before each later step on it, the Foreman runs `vorteo factory project claim issue <project-id> <n>`. The daemon creates the branch `factory/issue-<n>` through the GitHub API at the default branch's head. GitHub's 201 means this installation owns the issue; 422 "Reference already exists" means another one does. Branch names are fixed; new Factory work uses no type prefix. Workers push to that branch and the PR opens from it. An issue already in progress on an older `<prefix>/factory-issue-<n>` branch finishes there.

**Ownership.** The daemon records the claims it makes in `$PASEO_HOME/factory/projects.json`. It writes an intent (issue, default-branch commit, attempt id) before creating the branch, so a crash between creating the branch and recording it is recovered on the next claim: a branch at the recorded commit is this installation's own, unless another installation's marker names it too, which makes it a `conflict` for the owner to decide. A `factory/issue-<n>` branch it did not create is foreign: the Foreman never starts, repairs, merges or closes that work and never adopts the branch. The claim command reports one of:

| Outcome    | Meaning                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimed`  | This call created the branch.                                                                                                                  |
| `held`     | This installation already owns it.                                                                                                             |
| `foreign`  | Another installation owns it.                                                                                                                  |
| `lost`     | This installation's claim was released or the branch is gone.                                                                                  |
| `conflict` | Another installation's marker names the same branch, as after a crash in the same moment. The Foreman stops and asks the owner which keeps it. |

**Markers.** The lead's "Resolution plan" comment and every Factory PR body carry a visible line naming the owning installation and a hidden marker, `<!-- factory-claim v1 installation=<name> branch=<branch> -->`. The claim command prints both. Markers are for people and for conflict detection; there is no separate claim comment and no heartbeat edit. Builds and role PRs that are not issue work carry the marker plus `Refs #<n>`, `Closes #<n>` or `No-Issue: <reason>`. The Factory Overview queue marks issues another installation owns.

**Stale claims.** A foreign claim is stale when its latest activity is more than 24 hours old: its branch head commit, its marked plan comment or PR, and never earlier than when this installation first saw that head, so a fresh claim on an old default-branch commit is not stale. The Foreman is told once per stale head and asks the owner once whether to release it. It never takes over by itself. After the owner says yes, `vorteo factory project claim release <project-id> <n>` renames `factory/issue-<n>` to `factory-released/issue-<n>/<time>`. GitHub moves the branch and every commit on it in one step, so nothing is lost or rewritten and no release is ever half done. The release refuses unless the Foreman was told about the branch's current head. Any later claim of the issue sees that archive before it can claim, so it never reads the archive as its own release. The former owner's next claim reports `lost`. For a `conflict`, the installation the owner chose runs `vorteo factory project claim issue <project-id> <n> --keep`, which ignores the other installation's existing markers on that branch; the other runs `claim release`, which only forgets its own record and changes nothing on GitHub.

**One Triage and one Releases.** A committed `.github/factory.json` on the default branch names the installation that runs each role:

```json
{ "version": 1, "triage": "<installation>", "releases": "<installation>" }
```

Triage and Releases read it on every tick and when Factory is turned on, and the Foreman refreshes it for the Overview. A role whose entry names another installation, or no installation, does not wake and says so in its status line, such as "Off here: .github/factory.json assigns Triage to srv_x/prj_y". An invalid or unreadable file turns both roles off here until it reads cleanly. Without the file, every installation keeps single-installation behavior. Only the owner edits the file; roles never do. The Factory Overview shows the current assignment and flags a role that is off here. Before labeling, Triage compares the files changed by other installations' open PRs with an issue's scope and asks the owner instead of labeling on overlap. If two installations race for a release tag, Releases reads the existing tag and prepares the next version; tags are never moved or reused. On Vorteo, `scripts/vorteo-release.mjs tag` does this itself.

**One Factory per repository per installation.** Turning on Factory refuses a repository that another project on the same installation already runs.

The sections below describe the earlier read-only observer and controller boundary. They remain until that code is removed.

## Observation contract

`shared/contracts.ts` owns the plugin RPC schemas. `factory.snapshot` verifies that the
requested project appears in the serving daemon's active project registry. Its `serverId`
comes from the plugin session handshake, never the request. Clients must match that identity
to their selected host. Until a trusted controller binding exists, controller freshness and
coverage are unknown, installation and revision are null, allowance measurements are null,
and every action capability is false.

`activity.receipts` currently returns unavailable with `receipts: null`, incomplete coverage
and no continuation cursor. It does not read journals. A supplied cursor is expired and
reports a gap. Empty arrays must never substitute for unavailable receipt observation.

The receipt schema separates the source event time, observation time and independent
verification time. Merge and publication records require repository, immutable source commit
and delivery identity. A verified shipment also requires retained independent verification;
schema validation only checks structure and consistency, not source authenticity. Native
thread observations cannot count as verified shipment. The eventual producer must verify
canonical repository links and bind pagination to the serving host, project and filter.

Snapshot collections have fixed bounds and independent coverage declarations. A producer
that caps a collection must disclose incomplete coverage. `builds.latestRelease.publishedAt`
is the original publication time; verification time cannot advance a daily release clock.

## Controller adoption

The existing controller uses the native governed schedule runtime, captured selected-account
clients and launcher-held ownership fencing. Its startup may recover executions and configure
accounting. Importing that runtime to observe status would mutate state and could create a
second owner. The bundled observer therefore does not import or start it.

Adoption must preserve the installed controller's singleton, durable journals, selected
account, worker profile, existing native schedules and exactly two coordinator identities.
Retained uncertain execution custody must be reconciled before any owner replacement.
Controller source packaging and installation are separate operations. A plugin reload must
not revoke or replace the existing runtime owner merely to reconnect its interface.

The native startup adapter can restore observation for an exact completed installation after
a restart. It verifies the retained owner, checkpoint, configured profile and both coordinator
identities without rebinding membership or admitting execution. Incomplete checkpoints and
reconciliation holds refuse restoration. A hold raised during verification also rejects the
operation. The private startup caller must supply the reconciled owner; this adapter does not
make an unconfigured installation operational.

The native source boundary accepts an optional read-only projection from that same startup-owned
runtime. Only the loaded built-in Factory can delegate its two observation RPCs to it. The service
checks captured owner generation, serving host, active native project, repository, persisted
coordinator membership and exact agent identities before and after each read. A mismatch rejects
the read. A plugin reload resolves the same observer and does not replace or stop its owner.

The service parses bounded canonical DTOs and validates GitHub delivery links against the bound
repository. Current snapshots require a coherent revision and observation time. Archived
coordinators require a visible recovery hold. All action capabilities remain false. The retained-controller provider and native startup boundary are implemented in source.
Production owner attachment, installation and independently verified delivery evidence remain
required. The projection must exclude journal records, credentials, account inventories
and private paths. Reading a release journal does not establish a verified publication.

## Native binding and lifecycle boundary

The optional wire relationship is `WorkspaceDescriptor.factoryMembership`, containing
`installationId`, `projectId`, `serverId` and `role` (`factory`, `builds` or `worker`).
The proposed capability is `factoryWorkspaceMembership`. Native source now persists the
relationship through an internal authority seam and reserves coordinator roles in the registry
transaction. Ordinary archive and removal reject retained ownership, including archived
backing paths shared with an ordinary sibling. The native authority adapter, atomic coordinator binder and initial installation service are
implemented in source. A production owner reconciliation permit and installation remain
unavailable; the daemon does not advertise membership support merely because source exists. The interface cannot infer membership from titles, directories, labels
or Standing state.

A later native binding service must validate the exact relationship and persist it before
controller admission. Ordinary workspace archive, thread archive, bulk archive and project
removal must reject managed members at the daemon boundary. Generic protection toggles must
not remove this ownership. Supported worker cleanup must establish completion, retained
evidence and reconciled execution custody before retiring the relationship. Owner disable
must reconcile active work before removing it. Neither operation may accept a worker-supplied
boolean bypass or create another registration to evade a refusal.

## Installation and CLI boundary

The source candidate adds `vorteo factory status <project-id>` with the existing host
selector and table, JSON and YAML output. It reads the same `factory.snapshot` contract
as the interface, checks the serving host and exact project, and preserves unavailable
measurements. It does not substitute fixtures when transport or validation fails.
Setup and guarded initial installation also use the shared native service when the selected daemon supports it.
The server package builds and exports the canonical plugin contracts for the CLI;
the schemas remain authored in `plugins/factory/shared/contracts.ts`.

Install, status, configure, pause, resume, upgrade and disable must share one native installation
service with the project menu. An observer without a reconciled native adapter cannot advertise installation or dispatch a successful mutation. Repeat installation must discover and adopt an existing identity instead
of creating another controller or coordinator. Commands need the expected installation identity
and coherent observed revision; a null revision does not establish mutation preconditions.

Pause stops new admission while admitted work continues. Stop retains recovery custody. Disable
and upgrade reconcile ownership before replacing or shutting down coordination. These operations
must use native schedule, account and execution mechanisms; they do not add a scheduler, quota
polling loop or merge cap.

### Native owner controls

The built-in interface reads `factory.controls` and dispatches `factory.control` through the
same installed native adapter. Optional startup-owned control ports provide pause, resume and
stop. Without those ports or completed membership, the interface reports controls unavailable.
The legacy setup response keeps its existing false lifecycle flags.

Each action binds the serving host, project, installation, revision and operation identity.
The interface refreshes state before dispatch. Resume requires the displayed revision; pause
and stop can interrupt an outstanding resume using the fresh revision. Lost responses remain
visible and are never retried automatically. Private diagnostics are not returned to clients.
The retained owner must persist intent and reconcile interrupted operations before resuming;
these ports do not create another controller or renew account authorization.

### Guarded CLI installation

`vorteo factory setup <project-id>` reports the serving identity, native revision, setup state
and install availability. It reads no fixtures. `vorteo factory install <project-id>` requires
`--expected-server-id`, `--expected-revision` and a stable `--operation-id` from that attempt.
The command reads setup again from the selected host and rejects changed, held or already
installed state before dispatch. The native adapter supplies the selected account, configured
profile and exact coordinator pair; the command has no selectors for those values.

A refused or uncertain result exits with an error and retains its correlated native details
in structured output. Transport loss or invalid identity after dispatch requires reconciliation
of the original operation. The command never retries installation. These source commands do
not authorize controller adoption, deployment, account changes or a daemon restart. Other
operations remain unavailable until their reconciled native handlers exist.

### Time-limited prepaid execution

The native policy source supports optional `prepaidAuthorization` for one exact weekly
allowance window. Its start and expiry bound a positive interval of at most 24 hours.
The trusted account envelope and the worker policy must both authorize that window;
native admission intersects their intervals. A worker request cannot create account authority.
SDK schedule changes require the advertised `prepaidQuotaAuthorization` capability.

During that interval, the matching weekly reserve floor and occupancy estimate do not stop
prepaid execution. They do not measure prepaid spending. Other windows, configured consumption
meters, fresh authenticated account observations, native custody, concurrency and manual pause
remain enforced. Expiry refuses admission and resume, revokes dispatch permits and freezes
active execution even if a telemetry read stalls. Settlement of already stopped work remains
possible with its required accounting evidence after expiry.

This source support does not establish prepaid balance, a monetary spending ceiling or model
billing attribution. While the matching authorization is active, Factory reports null usage and
limit points rather than displaying allowance occupancy as prepaid cost or an enforced paid limit.
The original native measurement timestamp remains distinct from snapshot time. The owner authorization and exact account identity stay in private native
configuration and evidence. Installing this source and applying an account policy are separate
operations; an older installed governor still enforces its existing weekly policy.
