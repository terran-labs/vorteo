### Fixes

- Preview broker consumer deployment records that every broker channel was intact at the end of its maintenance window, and recovery checks that record before confirming a deployment.

## Maintenance review

Follow-up to the running-broker confirmation review. Before any broker is re-enabled, the worker records `window-verified.json`, holding the full end-of-window preservation report bound to the plan and `commit.json`; `admission.json` gains `evidenceVersion` 2 and the final receipt carries the window record's digest. Confirmation with or without a receipt requires and checks that record for version 2 runs. Runs whose `admission.json` has no `evidenceVersion` (made before this change, including the 9491d417 deployment on this installation) are confirmed under an explicit, tested legacy rule in which `commit.json` stands for the window check. The broker maintenance guide now says recovery confirmation applies to refusing runs too, and that abort records are best-effort, so missing commit or restoration evidence is what refuses aborted runs. Plan schema, approval and no-replay behavior are unchanged. The inventory entry stays accurate; README overview and onboarding are unchanged. Source only; not installed.
