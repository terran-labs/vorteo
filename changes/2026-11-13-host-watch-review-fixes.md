### Fixes

- Keep routine Host watch checks on worktree metadata; require an explicit investigation flag for expensive file scans.
- Share a finite, capped deadline across discovery and Host and Dev probes, and report missing paths and failed probes as unknown.

## Maintenance review

Updated the Host watch inventory and installation reference to describe metadata-only checks, the investigation flag, bounded probes and unknown results. Documentation discloses optional lock-file maintenance, manual operation and exact path output. Focused executor tests cover scan cost, deadline exhaustion and Dev failures. No live watcher or installation action is included.
