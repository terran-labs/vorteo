### Fixes

- Keep the Host update button disabled and visible while its confirmed request is pending, then restore retry after a failure. System update errors identify the Host action alongside the underlying error.

## Maintenance review

System retains its single primary action while showing a disabled pending control. Regression coverage checks that the pending control cannot submit another request and that retry becomes available after failure. Focused browser confirmation remains pending. README overview and onboarding are unchanged.
