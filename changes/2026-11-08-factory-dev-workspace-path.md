### Fixes

- Creating a workspace on another host without `path` now says that path, a folder on that host, is required, instead of returning a bare validation error.
- The Foreman's Dev instructions name the exact workspace calls: reuse or create the Dev workspace titled "<Project> :: Factory issue agents" with `path` set to the project's root, which is the same path in Dev for projects in the shared Projects folder, treating Dev as unavailable if that fails, and have the lead reuse or create its local workspace at the issue worktree.

## Maintenance review

The remote `create_workspace` route now rejects a missing `path` with a readable message rather than inventing a default, and one connected-hosts end-to-end assertion covers it. The dev-mode Foreman charter changes, so its version changes and the existing review flow re-sends it; host mode is unchanged. README overview and onboarding are unchanged. Not installed.
