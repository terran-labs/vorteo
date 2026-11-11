### Fixes

- One environment no longer deletes another environment's worktree metadata. Vorteo locks the worktrees it creates, archive and recovery forget only their own worktree's registration instead of pruning the whole repository, and a new worktree never reuses a path another environment registered.

### Maintenance

- `scripts/worktree-locks.mjs` locks existing Vorteo worktrees in every Vorteo layout and, with `--unlock`, removes only Vorteo's locks before a downgrade. Worktree cleanup lifts Vorteo's lock only for the worktree it removes.

## Maintenance review

Fixes #295 and prepares Dev worktrees on separate storage (#343). Upstream `deletePaseoWorktree` and workspace recovery no longer run `git worktree prune`; Vorteo locks its worktrees with a fixed reason shared by the daemon and scripts, and a test guards that both copies match. A real-repository test hides worktree folders to stand in for the environment that cannot see them. Recovery drops a locked registration only when it still checks out the workspace's branch, and archive without a repository root drops exactly its own registration. Existing worktrees need the lock migration after both daemons run this release. README overview and onboarding are unchanged.
