### Tooling

- The main-branch publisher enqueues a pull request in the merge queue directly when `gh pr merge` falls back to auto-merge, which this repository disallows, instead of stopping after its checks pass.

## Maintenance review

Added a direct merge-queue enqueue, pinned to the tested head, to the publisher, plus one regression test that fails without it. README overview and onboarding are unchanged.
