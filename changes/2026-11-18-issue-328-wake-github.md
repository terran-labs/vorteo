### Improvements

- Monitor explicit GitHub PR states, workflow attempts and named checks on a pinned head through the shared authenticated adapter, with bounded polling and host budget pauses.
- Enable checklist wake readiness only with the complete monitor lifecycle; stale observations, stop and drain cannot authorize new condition wakes. Read-only Factory authority and parent-chain checks refuse pauses or ownership changes during admission.

### Fixes

- Exempt only blocked tasks with current unspent generations and live monitoring from timed review. Missing dependencies or stale observations restore eligibility under the existing opt-in ladder; a separate durable receipt records the first unavailable reason without spending a wake claim.

- Require a shared GitHub observation to start after each subscriber arms, including when both events share a clock timestamp. A closed PR prerequisite accepts closure or merge.
- Check stored holds before loading a provider runtime and back off refused generations for two minutes without spending their claims.
- Document that an unlabeled cross-server child can wake while its remote Factory parent is paused.

## Maintenance review

Updated the checklist inventory, lifecycle and compatibility guidance for runtime monitoring and its Factory authority limitation. Extended the existing GitHub authentication case with explicit-target semantics, retry and budget checks. Extended existing Factory pause and wake recovery cases for read-only authority capture and changes during admission. Corrected the unreleased fragment after independent review and extended the existing authentication and recovery cases without adding a suite. Reviewed the incoming main traffic accounting, account switching and release-retention inventory during integration. Traffic accounting shares WebSocket delivery with the wake capability but does not replace condition monitoring or admission; both remain intact. README overview and onboarding remain unchanged; detailed behavior belongs in lifecycle guidance.
