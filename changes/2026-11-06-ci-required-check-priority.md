### Fixes

- Heavy CI jobs wait for format, lint and typecheck to finish, giving required checks priority over the merge group’s heavy suites. Failed or skipped checks still allow the selected suites to run unless the run is cancelled.

## Maintenance review

CI suite selection and required check definitions are unchanged. The scheduling dependencies also apply to manual, nightly and release-tag runs. README overview and onboarding are unchanged.
