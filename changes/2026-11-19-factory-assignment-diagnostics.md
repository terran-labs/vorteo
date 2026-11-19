### Fixes

- Preserve bounded, allowlisted diagnostics for unreadable Factory assignments, distinguishing subprocess, HTTP, response and content failures while keeping both assigned roles off. Killed with SIGTERM alone does not establish timeout.

## Maintenance review

Reviewed multi-installation Factory assignment reads, shared response and persisted-state schemas, and role gates. Diagnostics are optional for older state and readers; issue-claim ownership, success and 404 behavior remain unchanged. Updated the Factory guide and customization inventory. README overview and onboarding are unchanged. Reconciled with the merged review-attribution changes, preserving their review-evidence cases alongside the separate assignment diagnostics cases. Source only; not installed. The historical failure remains unexplained.
