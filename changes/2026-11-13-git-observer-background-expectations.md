### Maintenance

- Update session Git observer assertions to require background registration for workspace-list observation. Both workspace update and checkout status delivery retain coverage.

## Maintenance review

Reviewed server test expectations for Git workspace registration after the polling-pressure change. The two session argument assertions now match background observation; the checkout diff registration count assertion remains valid. Runtime behavior and README overview and onboarding are unchanged.
