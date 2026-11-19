### Improvements

- Monitor explicit GitHub PR states, workflow attempts and named checks on a pinned head through the shared authenticated adapter, with bounded polling and host budget pauses.
- Enable checklist wake readiness only with the complete monitor lifecycle; stale observations, stop and drain cannot authorize new condition wakes. Read-only Factory authority and parent-chain checks refuse pauses or ownership changes during admission.

## Maintenance review

Updated the checklist inventory, lifecycle and compatibility guidance for runtime monitoring and its Factory authority limitation. Extended the existing GitHub authentication case with explicit-target semantics, retry and budget checks. Extended existing Factory pause and wake recovery cases for read-only authority capture and changes during admission. README overview and onboarding remain unchanged; detailed behavior belongs in lifecycle guidance.
