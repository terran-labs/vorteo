### Features

- Full maintenance delegation now covers every installation operation by default, including any added later. One exclusion list names the exceptions; today it holds only shared instruction requests, because agents never edit their own guardrails.
- Builds can request **Update the coordinator** with `request-coordinator-follow` and follow it with `coordinator-follow-status`. Under the full grant it starts after a thirty-second cancellation window; otherwise the owner approves it as before.
- Under the full grant, coordinator settings changes (including the broker keys), preview broker consumer deployments and channel rebinds, and the Dev boot-entry switch approve themselves after the same window. The broker review, boot-entry pins and rollbacks still run at dispatch.
- Installation management can cancel coordinator updates and coordinator settings changes.

### Maintenance

- A front-door test fails when an owner route has neither an agent request command nor a stated exemption.

## Maintenance review

Inverted full maintenance delegation to default-in behind one exclusion list. Added a Host-agent coordinator update request, delegated admission for coordinator updates, coordinator settings and both broker queues, and management cancellation for coordinator updates and settings. The broker queues keep their approval evidence in a private file and their records pending, so a rolled-back coordinator waits for the owner. Added the front-door rule to the agent guide and task delivery guide. Not yet installed. README overview and onboarding are unchanged.
