### Improvements

- The Host watch's stale-worktree check also covers worktrees only Dev can see, such as those on Dev's worktree volume, by reading them inside Dev.

## Maintenance review

Review follow-up for Dev worktrees on native storage: registered worktrees missing on the Host are read inside Dev in one batched `docker exec` without optional Git locks, with a parser test. On one Host it found 47 more stale worktrees. README overview and onboarding are unchanged.
