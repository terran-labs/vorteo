### Fixes

- Installation daemons re-check coordinator support for the primary connection on every successful settings read. After reconnecting to an older coordinator, the Optimizer and Factory return to launching with the first usable provider instead of waiting; a failed read keeps the last known answer.
- System thread launches re-read the primary connection after their provider and usage reads, select again once if it changed, and otherwise wait, so they never start on a primary connection the owner just cleared or replaced.

## Maintenance review

Primary connection review fixes: the support marker is reconciled from each admission answer and from projections that omit it, and launch selection rejects a superseded choice on installation and standalone daemons. The inventory entry notes both. README overview and onboarding are unchanged.
