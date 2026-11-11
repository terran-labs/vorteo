### Improvements

- New Dev installations keep Dev's task worktrees on Docker's native storage: a named volume covers the Projects folder's worktree folder inside Dev, so Dev builds at native speed and never reads the Host's worktrees and dependencies through the shared folder. Owner projects stay shared.

## Maintenance review

`docker/multiplex/install.sh` writes `dev-worktrees.compose.json`, and `common.sh` includes it and prepares the volume (created if needed, owned by uid 1000) before each `up`. Rollback removes the override and recreates the container; the volume is kept. Refreshing deployment scripts refuses an older `common.sh` while the override exists, and the docs cover volume loss, its locked leftovers and removal on uninstall. Verified in a disposable container from the Dev image: Host worktrees hidden, worktree root on the VM's ext filesystem, Dev's locked worktree kept through a Host prune, rollback restores the shared view. Existing installations are unchanged until a tracked migration ships. Depends on the worktree ownership locks. README overview and onboarding are unchanged.
