### Fixes

- Host release cleanup puts back every release that came into use in one pass before deleting anything, and deletes under a `.deleting` name that is never restored, so neither a slow nor an interrupted cleanup can hide a release in use or bring back a half-deleted one.

## Maintenance review

Addresses the five review findings on safe release pruning: one-pass restore, a never-restored deletion name, only ENOENT failing a session host start, a set-aside copy beside its job folder being removed when unused instead of blocking both forever, and process listing tests on real-format `lsof` and `ps` output, including a session host started through the `current` link whose working directory is in the release. Each new retention test fails against the previous code. Updated the original fragment and the customizations inventory. README overview and onboarding are unchanged. Not installed.
