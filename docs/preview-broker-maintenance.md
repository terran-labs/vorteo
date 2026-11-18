# Preview broker channel identity repair

The preview broker refuses a channel whose recorded filesystem device changes.
An APFS device number can change across a reboot. Matching inode, ownership and
mode alone does not authorize a replacement binding. The repair plan must bind
independently reviewed continuity evidence to the APFS volume UUID and every
protected directory identity.

## Preparation and owner decision

The separate `preview-broker-channel-rebind` operation prepares through
`request-broker-channel-rebind --request-file <file>` in the installation agent.
The Host request API is `/api/installation/broker-rebind-requests`; status is
available through `broker-rebind-status <id>`. Installation controls show the
exact plan digest, before and after config hashes, volume identities and evidence
directory. Approval or cancellation uses the authenticated owner decision route
`/api/installation/owner/broker-rebinds/decision`, binding request ID, revision,
operation and plan digest. Maintenance delegation never approves broker trust.

The protected `previewBroker` configuration pins the two config paths, Python,
worker, identity verifier, eight deployed consumer files, evidence root and
retained recovery readers. Both selected and recovery config and journal parsers
must accept the new records before the first pending journal append. A terminal
record still requires a compatible reader. Installing only the interface does
not install this operation or satisfy these checks.

The deployed consumers must already contain the reviewed locking, protected
reload and activation-fence code. This operation does not install those files.
Consumer installation and coordinator/configuration activation require their
own supported, reviewed lifecycle plan. Neither the legacy installer nor the
unrelated native permission helper is an alternative admission path. If that
installation capability is absent, keep activation held and report that gap.

## Exact write footprint

The approved manifest names both config paths and their exact input and output
SHA256 values. The only config addition is `channelFilesystemIdentity`, containing
version, APFS filesystem, volume UUID, mount point, four channel directory
identities and the complete protected ancestor identity map. Existing device
pins and all other config fields remain retained.

Each config directory receives one exclusive `.broker-rebind-<id>-<index>` staged
file and `https-broker-rebind.pending.json`. The latter binds its config hash to
the shared commit record. The protected evidence root receives one exclusive
request directory with intent, original config backups, bounded before/after
inventories, replacement intents and acknowledgements, verification and commit
records. Evidence uses retained directory descriptors. No existing evidence is
overwritten or deleted.

Both actual consumers use the same locks and reload protected config under lock.
Migration holds both locks in lexical order. Producers may add requests without
those locks: existing request, receipt, origin and ledger bytes and identities
must remain unchanged, and new inbox requests are recorded rather than replayed.
An indeterminate prior start refuses preparation. Inventories enumerate at most
4,097 entries per directory and reject more than 4,096 before reading contents.

The two config renames are sequential, not one atomic transaction. Both consumers
remain fenced until the exact shared `commit.json` exists. `verified.json` is
written before activation and is not proof of commitment. A missing or changed
fence on a migrated config refuses consumption. On the next locked invocation,
consumers verify the commit, config and stable volume binding before processing.

## Failure and recovery

A lost apply response is uncertain, including when the commit may already exist.
Do not retry, infer success from verification alone, or automatically restore
backups. The existing coordinator drain performs bounded read-only reconciliation
under both consumer locks. It records `precommit-held`, `committed` or `unresolved`;
only an exact committed observation settles the previously approved effect.
Held and unresolved work remains fenced for separate recovery review. Repeated
observations are spaced by at least 30 seconds, with no apply retry.
`precommit-held` proves current fencing only. It does not establish full UUID
acceptance, absence of earlier effects or authority to restore a backup.

The observer verifies the exact approved TypeScript JSON bytes and digest, then
parses those bytes to the plan before reconstructing Python's canonical intent
and commit. Both digests are recorded explicitly; they are not assumed equal.
Changed or incomplete evidence remains uncertain. Postcommit live queue progress
is legitimate, so reconciliation checks retained preservation evidence rather
than comparing active queues against a frozen inventory.

The source contains an owned-only restoration primitive, not an exposed command
or automatic rollback. It requires original intent, backup hashes and exact
completed-write identities, refuses foreign replacements, and leaves a shared
rollback barrier plus both fences. Missing replacement acknowledgements require
separate review. Partial files and all receipts remain for inspection.

After migration, recovery consumers must understand UUID anchors and fences;
older consumer code is not an accepted rollback merely because old device pins
remain in config. Coordinator recovery must likewise retain strict-schema
compatibility with every broker record and configuration field.

## Acceptance boundaries

Source tests and review do not authorize trust activation. Installation requires
a separately reviewed supported plan. The owner, or the full maintenance grant
after its cancellation window, approves the exact request at action time. Hostname changes remain a separate decision. This operation
starts no application and restarts no Host or Dev daemon.

After a confirmed commit, separately verify both broker readbacks, preserved
queues and ledgers, the intended registered application's process ownership,
fresh availability receipt, HTTPS HTML and entry assets. A config repair alone
does not establish service availability or cold-start acceptance.

## Deploy compatible consumers before channel trust migration

The separate `preview-broker-deployment` request replaces exactly four consumer
files at each configured broker root. Only `channel_identity.py` may be absent.
The protected coordinator configuration pins the module closure, native inspector,
paired container, recovery readers, registration mappings and finite participant
scope. Installation controls show the source, file preimages and candidates,
registration disposition and scope declaration. Approving deployment does not
approve channel trust migration.

Preparation checks native boot, process generations, exact plist bytes, effective
launchd enabled state and known manual callers. The owner reviews the declared
managed and manual scope; this is not an assertion about arbitrary same-user
imports. Participant commitments must cover the execution window and remain
current. Imported or waiting generations must settle before replacement.

When the pinned Python is a macOS framework launcher,
`<framework>/Versions/<v>/bin/python<v>`, the executor runs the interpreter that
launcher re-executes, `<framework>/Versions/<v>/Resources/Python.app/Contents/MacOS/Python`,
and holds native child custody to that path and its argv. The path comes from the
pinned, canonical launcher path by that fixed pattern only, never from the
environment or `PATH`. It must be a canonical, owner-only executable outside
writable Dev mounts, and its digest must not change during the invocation; if it
is missing or fails those checks, preparation refuses. Any other interpreter path
runs as pinned. The worker likewise admits a live broker generation whose argv is
the binding argv, or the same argv with `argv[0]` replaced by that launcher's
`Python.app` image, and refuses any other interpreter. A refused preparation
records the first line of its error in the job detail and the installation log.
The coordinator uses the existing refusal sanitizer before deriving preparation
and persistence reasons, removing terminal escapes and control characters and
limiting text to one line. The requester relies on server-side sanitization of
these fields and does not sanitize them itself. Local transport error formatting
is unchanged.

Preparation refuses before recording when admission or compatible readers are
unavailable. Once recorded, a refused preparation returns the retained failed
job through the ordinary successful HTTP response; inspect its `status`.
A concurrent journal write permits one fresh validation attempt only while the
request itself is unchanged. Both attempts retain full-journal reservations.
Validation retries never approve a request or replay native deployment effects.
The fresh reservation belongs only to that preparation attempt. New preparation,
owner decisions and dispatch refuse if disk differs from the coordinator's
evaluated snapshot. After a preparation-only refresh, the coordinator retains
only the outcome it durably wrote for that same request, so later ordinary queue
writes preserve its prepared state or failure reason. It does not adopt another
writer's records, decisions or revisions. Deployment writes do not refresh other
lifecycle queues.
Status and same-identity resubmission read retained receipts without advancing
that snapshot or admitting subsequent work.

Failure bookkeeping uses the existing locked journal mutation and admission
checks. It changes only the same pending, preparing request revision and exact
plan to failed, preserving other records and competing lifecycle decisions.
Repeating the same identity returns its retained state without preparing again;
a changed reason or plan requires a new identity.

If failure bookkeeping cannot persist, the HTTP error retains `error` and adds
`code: "deployment_preparation_persistence_uncertain"`,
`outcome: "recorded_uncertain"`, `requestId`, `preparationReason` and
`persistenceReason`. These are optional error-response additions; successful job
shapes and WebSocket schemas are unchanged. The scoped client directs you to
`broker-deployment-status ID`. A retained preparing record after this error is
unresolved. Resubmission reports it without repairing it or retrying native work.
If another writer removed the request during bookkeeping, this response still
reports persistence uncertainty; status may report no retained request.
Legacy ordinary queue writes can still overwrite other writers' records; this
repair only prevents reversion of the owned deployment outcome.
Participant-scope replacement remains a separate operation and is not supplied
by this repair.

Dispatch records child intent before a single spawn. An inherited private channel
rechecks coordinator configuration, protected artifacts, full queue reservation
and native child identity before each native boundary. The worker disables the
exact broker schedulers, waits up to fifteen seconds for old consumers to exit,
acquires their existing locks and writes durable per-file intents and readbacks.
It preserves channels, configuration, ledgers, plists, displaced files and all
partial evidence.

Each registration in the plan names one of two admission modes, and installation
controls show it to the owner. Preparation, dispatch and every later check require
the live mode to equal it, and the worker records it in `admission.json` before
any effect. A plan without the field means refusing.

- **Refusing.** The unchanged legacy channel pins still refuse before request
  consumption. The plan's preservation digest covers the full inventory: config,
  installed marker, channel files and ledger.
- **Running.** The legacy pins verify, for example after an operator repinned them
  when a reboot renumbered the APFS device, so the broker serves requests and
  rewrites its ledger every cycle. Approving it restarts the broker on the new
  consumer code, which serves requests immediately. The plan's preservation
  digest covers only the config and installed marker, and it pins no scheduler
  process generation. The worker takes the full inventory baseline after
  suppression; under the broker locks the inventory must still equal it exactly,
  and it is compared across the commit window as in refusing mode. Once the
  broker runs again, its ledger, inbox, receipts and origins are its own working
  state, so after restore the worker compares only the committed consumer files
  and the config and installed marker, which no broker run writes.

Both modes compare the approved preservation digest before any native effect, so
a wrong mode or stale preparation refuses while the brokers still run.

A channel with a filesystem identity anchor, or any other verification failure,
is refused: trust migration stays the separate rebind. Effective enabled and
registered behavior is restored after complete file verification. An initially
absent launchd override may become an explicit enabled override; this is
semantic restoration, not byte-identical override storage. Loaded but disabled
jobs are refused before effects. No daemon or application lifecycle is included.

If the attempt aborts after every suppression effect was acknowledged and before
the first consumer file write, the worker re-enables and reloads the original
brokers and records `abort-restored.json`; the job still ends without a
commitment. A broker generation that survives bootout is the exception: starting
new generations beside a process launchd no longer accounts for would hide it
from recovery, so the worker keeps suppression and records
`abort-not-restored.json`. The same applies when a later window recheck finds an
unlisted broker generation.

Coordinators older than the release that added the `admission` field cannot parse
a journal containing it. Once a deployment with that field has run, rolling the
coordinator or Host back below that release is not supported. Lost replies retain uncertainty. After a lost reply or any file
write, recovery reads evidence and native state without replaying commands,
replacing files or automatically restoring registrations. Before re-enabling any broker, the worker records `window-verified.json`: the
full end-of-window preservation report, bound to the plan and to `commit.json`.
The final receipt carries its digest.

Recovery can confirm a run that committed and restored but never wrote its final
receipt, in refusing and running mode alike. Every per-file intent and
acknowledgement must match `commit.json`, every suppression and restoration
effect must be acknowledged for this plan, and the same post-restore checks must
pass: the full live comparison for a refusing broker, and committed files, config
and installed marker for a running one. A run whose `admission.json` carries
`evidenceVersion` 2 must also have a consistent `window-verified.json`. A run
without that marker was made by a worker that never wrote the window record; for
it, `commit.json`, written only after the under-lock preservation check, stands
for the window check. What refuses an aborted run is the missing evidence: an
abort before the first write leaves no `commit.json`, and one after it leaves no
restoration acknowledgements. Abort records are best-effort and are not written
once replacement has begun, so their absence proves nothing. That confirmation
writes nothing.
The client commands are `request-broker-consumer-deployment --request-file` and
`broker-deployment-status ID`. Submission requires the configured capability;
exact approval remains separate. Source validation is not installed availability.

## Restore the broker on an installation with renewal evidence

Once renewal evidence exists, every coordinator change runs through a runner
renewal, and the legacy admission path is unavailable. A renewal may carry
`previewBrokerDeployment` or `previewBroker`, but only as its single entry in
`configurationChanges`. A renewal naming both, or one of them beside any other
setting, is refused. Policy, native helper and monitor changes stay outside
renewal. Do not edit the coordinator configuration by hand: renewals pin its
exact bytes.

Each renewal's candidate configuration must differ from the live one by exactly
the attached section. Its compatible recovery reader keeps the live configuration,
so a failed renewal rolls back to the coordinator without the new section.
Admission checks the section's paired Docker identity and its recovery readers in
the selected Host release, then runs the section's executor checks against the
candidate: protected files and their SHA256 pins, consumer and participant scope,
and the retained recovery reader probe. Preparation, approval and claim each
repeat these checks.

Full maintenance delegation approves attaching either section (owner decision of
2026-11-03) and, since 2026-11-07, the consumer deployment and channel rebind in
steps 2 and 4, each after a thirty-second cancellation window. Without the grant
the owner approves each step in installation controls. Builds submits each
request below.

1. Attach `previewBrokerDeployment` through a renewal. Prepare the protected
   participant scope first. Its `validUntil` must cover the renewal, its approval
   and the deployment execution, with more than three minutes left at each check.
   Submit with `request-coordinator --request-file
<preparation.json>` and follow it with `coordinator-status <id>` until the
   renewal succeeds. `capabilities` then reports `previewBrokerDeployment`
   available.
2. Submit `request-broker-consumer-deployment --request-file <file>`. The owner,
   or the full grant, approves the exact request. Follow it with
   `broker-deployment-status <id>` until it reports `succeeded`.
3. Attach `previewBroker` through a second renewal. Its `consumerFiles` pin the
   eight deployed consumer files by their committed SHA256 values, four beside
   each config path, and `channel_identity.py` matches `identityModule`. Submit
   and follow it as in step 1. `capabilities` then reports `previewBroker`
   available.
4. Submit `request-broker-channel-rebind --request-file <file>`. The owner,
   or the full grant, approves the exact request. Follow it with `broker-rebind-status <id>` until it
   reports `succeeded`.
5. Read back both renewals with `coordinator-status`, both capabilities, the
   succeeded deployment and rebind statuses. Then complete the acceptance
   checks above: both broker readbacks, preserved queues and ledgers, process
   ownership, a fresh availability receipt, HTTPS HTML and entry assets.

A lost reply at any step is uncertain. Read the matching status before deciding
whether anything needs to be resubmitted, and never retry an apply.
