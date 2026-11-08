### Fixes

- Factory account picks for Dev now find accounts set up through managed sign-in, such as Claude accounts, which previously never qualified there. Two accounts count as the same only when the installation's provider definitions bind both, never because their local names match.

## Maintenance review

`pick-account --server` now maps a local account to the destination through an installation provider definition that is not removed and not excluded for that host and binds both daemons' server ids, read through the daemon's existing settings authority without new credentials or logging. Binding keys are environment server ids that the coordinator writes over connections refusing any daemon reporting another id; the pick also refuses an authority naming another daemon. The local installation account id match remains only when the daemon has no installation settings. The account-choice case table covers a managed setup with the same id on both hosts, a same-id lookalike without a definition and a definition excluded for Dev. README overview and onboarding are unchanged. Not installed.
