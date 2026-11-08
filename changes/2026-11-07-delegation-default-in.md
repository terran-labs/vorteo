### Features

- Full maintenance delegation now covers every installation operation by default, including any added later. One exclusion list names the exceptions: agent instruction and guardrail edits, because agents never edit their own guardrails, snapshot restore and source upgrade rollback, and accounts and credentials. A delegated approval is checked again at dispatch, so revoking the grant stops work that has not started, even after a coordinator restart.
- Builds can request **Update the coordinator** with `request-coordinator-follow` and follow it with `coordinator-follow-status`. Under the full grant it starts after a thirty-second cancellation window; otherwise the owner approves it as before.
- Under the full grant, coordinator settings changes (including the broker keys), preview broker consumer deployments and channel rebinds, and the Dev boot-entry switch approve themselves after the same window. The broker review, boot-entry pins and rollbacks still run at dispatch.
- Installation management can cancel coordinator updates and coordinator settings changes.

### Maintenance

- A front-door test fails when an owner route has no agent request command, exclusion or pinned entry. Existing owner operations without an agent door are a pinned gap list that may only shrink.

## Maintenance review

Inverted full maintenance delegation to default-in behind one exclusion list. Added a Host-agent coordinator update request, delegated admission for coordinator updates, coordinator settings and both broker queues, and management cancellation for coordinator updates and settings. The broker queues keep their approval evidence in a private file and their records pending, so a rolled-back coordinator waits for the owner; a delegated broker request stays pending through dispatch validation and is claimed straight into running in one journal write, so no delegated approval is ever persisted as an owner approval. Owner approvals, including combined coordinator update and settings approvals, replace delegated evidence. Stable source upgrade requests and decisions, which reached main before the front-door rule, are on the pinned gap list; their rollback stays with the owner. Added the front-door rule to the agent guide and task delivery guide. Not yet installed. README overview and onboarding are unchanged.
