### Fixes

- Broker settings changes now take all release code from one installed Host or coordinator release at fixed paths, and show the owner that release's commit. Retained older releases, build caches, source checkouts and mixed modules are refused.
- The coordinator writes the broker participant scope itself when an approved change applies, limited to 24 hours on the current boot with no manual participants. An owner interface too old to show each changed field can no longer approve broker settings.
- The broker deployment worker checks each launch agent's arguments again immediately before launchd loads it.

## Maintenance review

Hardened the reviewed broker settings from the security review: anchored release code, single-section connection pins, coordinator-minted participant scope, a `reviewedFields` approval capability tagged COMPAT(coordinatorSettingFields), and bounded retries for checks that could not run. README overview and onboarding are unchanged.
