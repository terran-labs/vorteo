### Maintenance

- Worktree registration cleanup resolves link paths before trusting them, so a link that walks out of a repository's worktrees folder is never taken for a registration, and relative registration links still match their worktree.

## Maintenance review

Review follow-up on the worktree ownership change: `worktreeAdminDir` resolves the `.git` link before checking that it lies in a `worktrees` folder, and registration links written relative to their admin folder (Git's `worktree.useRelativePaths`) are resolved against it. The lock migration's `--root` values are resolved to real paths. Test rows cover an escaping link and a relative link. README overview and onboarding are unchanged.
