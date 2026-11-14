### Maintenance

- Refresh the reviewed worktree environment ownership fix against current main.

## Maintenance review

Merged current main while preserving worktree locks, exact registration cleanup, cross-environment path protection and the reviewed link-resolution guards for issue #295. Focused validation covers worktree utilities, worktree service behavior and agent lifecycle scripts. Existing-worktree lock migration remains a separate installation action. README overview and onboarding are unchanged.
