### Changes

- The Factory Foreman now gives each lead the go to start its worker, after checking the plan's files against all work in flight. Overlapping issues wait without holding a worker slot instead of colliding.
- The Foreman picks every agent's account itself, including a planning lead's worker, so leads and workers no longer call the Factory service.
- After each merge, the Foreman removes the merged issue's clean worktree and tells in-flight issues that touch the same files to merge the default branch right away, so conflicts appear before merge time. Issues are never combined into one branch or pull request.

## Maintenance review

Foreman charter rules for issue isolation, overlap-aware worker starts, worktree cleanup and early conflict merges, approved by the owner as part of the Factory placement proposal. The shipped Foreman charter changes, so its review fires after install. No daemon or wire changes. README overview and onboarding are unchanged.
