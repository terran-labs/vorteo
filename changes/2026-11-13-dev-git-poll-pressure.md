### Fixes

- Keep sidebar-only workspaces off the active Git fallback cadence. Focused workspaces, open checkout views and running agents retain active polling; idle workspaces refresh at most once per five minutes unless a watcher event or explicit request arrives.
- Share overlapping fallback polls and use minimal stat checks for routine polls on shared filesystems. Watcher events, explicit reads and a five-minute verification stay strict, limiting stale status from same-size edits with unchanged whole-second modification times. Read-only Git commands retain disabled optional index writes; untracked caching remains unchanged.

## Maintenance review

Reviewed workspace Git observation and client demand. Existing per-workspace serialization, watcher delivery, forced reads and repository fetch intervals remain intact. Changes use Vorteo's workspace Git service and its session wiring; the shared Git command runner and checkout implementation are unchanged. README overview and onboarding are unchanged.
