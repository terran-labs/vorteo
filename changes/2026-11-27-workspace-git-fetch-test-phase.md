### Maintenance

- A workspace Git service test no longer fails at random when its first idle repository refresh lands just after a regular fetch.

## Maintenance review

Test only; behavior is unchanged. The workspace Git service case "a deleted worktree leaves its shared repository polling and fetch to the surviving worktree" failed whenever its first idle release landed shortly after an active fetch. That release's phase is hashed from the repository path, which in this test is a random temporary folder. Pinned phases from about 190 to 260 seconds gave three fetches across the two measured intervals, and the rest gave two. An idle release fetches and restarts the three minute fetch clock, so one landing soon after an active fetch fits a third fetch in that span. The case now pins the phase to 0, which runs the first idle release before the deletion. No other case in its group counts fetches. README overview and onboarding are unchanged.
