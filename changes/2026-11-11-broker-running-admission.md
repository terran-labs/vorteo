### Fixes

- Preview broker consumer deployment now accepts brokers that are already serving requests, such as after an operator repinned their channel when a reboot renumbered the disk. It stops them first, takes its preservation baseline once they have stopped, and restarts the original brokers if it aborts before replacing any file.

## Maintenance review

Reviewed the broker consumer deployment entry in the customizations inventory and the deployment policy in broker maintenance; both now describe refusing and running admission. Plan schema, approval, exact plan binding, recovery_required evidence and no-replay behavior are unchanged; evidence without `admission.json` keeps refusing-mode semantics. Lost native replies and aborts after a file write still never restore registrations. README overview and onboarding are unchanged. Source only; not installed.
