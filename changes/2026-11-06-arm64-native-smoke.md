### Tooling

- The arm64 container smoke runs on GitHub's native arm64 runner instead of under QEMU emulation on an x86 runner, which made it the slowest container job.

## Maintenance review

Owner-approved CI optimization: the Container smoke matrix picks `ubuntu-24.04-arm` for arm64 and drops QEMU setup, verified by a manual Container run on the branch before merge. Updated the CI workflow test. README overview and onboarding are unchanged.
