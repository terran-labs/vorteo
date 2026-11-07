### Fixes

- A Factory claim release in progress, or interrupted by a crash, no longer makes the claim's owner give it up. The release deletes the branch first, with a lease, and archives it afterwards, finishing an interrupted archive on its next attempt.

## Maintenance review

Review fix for multi-installation Factory claims: release order is leased delete, then archive, with a recorded pending release for crash recovery. Source only; not installed. README overview and onboarding are unchanged.
