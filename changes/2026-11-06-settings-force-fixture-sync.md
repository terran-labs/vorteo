### Fixes

- Let the packaged Force restart check retry the exact admission rejection raised when initial account settings synchronize before an agent starts.

## Maintenance review

The fixture retries only the known pre-creation settings-binding rejection once, matching the existing single-notice fixture. Other errors still fail immediately. Product behavior, restart targets, assertions and deadlines are unchanged. README overview, onboarding and the feature inventory need no changes for this test setup correction.
