### Fixes

- Stopping the Host's sign-in for an adopted legacy Codex account no longer turns back into an adoption when Dev pauses it for a changed folder: a paused record resumes only to the status it paused, so the undo continues. Records the earlier release paused, which cannot tell the two apart, wait for the owner (#647).
- Confirming a changed Dev folder no longer waits for Dev sessions to stop when Dev already held the Host's sign-in in that folder; every other check still runs, and a different person still asks first (#647).
- The coordinator keeps the new adoption facts in a separate file, so rolling it back to the earlier release needs no preparation. When another account's saved switch record cannot be read, the reason now says so (#647).

## Maintenance review

Review fixes on PR #653: `parkedFrom` and resume only to it, no automatic resume without it, the sidecar `codex-signin/adoption-extra.json` for `parkedReason`, `parkedFrom` and copy persons with records kept in the first release's strict shape, the settled folder-change confirmation, and the other-account unreadable text. The providers guide, protocol notes (rollback instruction replaced by the sidecar) and the adopted legacy Codex inventory entry are updated. README overview and onboarding are unchanged. Not published.
