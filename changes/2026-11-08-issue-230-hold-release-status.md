### Fixes

- Fixed succeeded restarts retaining waiting-for-hold status after hold release succeeds on retry
- Record the first line of hold release errors in existing coordinator diagnostics

## Maintenance review

Reviewed System status and restart controls, Automated upgrade restarts that wait for idle, Reviewed source updates, and Protected owner access and restart validation. The correction restores accurate completion detail and uses existing diagnostics; those inventory entries remain accurate. Lifecycle behavior, README overview and onboarding are unchanged. No live installation acceptance is claimed.

Validation: focused restart tests passed (149 passed, one existing macOS-only case skipped on Linux), along with the server build, full typecheck after building declarations, lint, formatting, staged version check and diff check.
