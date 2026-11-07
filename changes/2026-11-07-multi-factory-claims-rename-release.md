### Fixes

- Releasing a stale Factory claim renames its branch to `factory-released/issue-<n>/<time>` in one GitHub step, so a push landing during the release is kept, nothing is half released after a crash, and a later claim of the same issue is never mistaken for the released one.

## Maintenance review

Review fix for multi-installation Factory claims: release uses GitHub's atomic branch rename instead of a separate archive and delete, removing pending-release recovery state. Source only; not installed. README overview and onboarding are unchanged.
