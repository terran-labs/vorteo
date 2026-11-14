### Fixes

- Avoid scanning tracked files during workspace reconciliation and checkout discovery when only repository roots, branch, remote and worktree ownership are needed.

## Maintenance review

Checkout discovery uses a fresh metadata-only form of the existing checkout facts reader, skipping dirty state and upstream tracking counts. All production callers use the lightweight identity result for project placement, repository classification, suggestions or worktree planning. Repository transitions invalidate cached snapshots for a strict refresh on their next read. UI snapshots, watcher refreshes, diff reads and operation validation retain their existing behavior. Continuous metadata-watcher refreshes remain a separate source of Git work. README overview and onboarding are unchanged.
