### Fixes

- Fix the peer service environment test flaking when concurrent services register routes in a different order. Compare routes by script name while preserving exact route and environment assertions.

## Maintenance review

Reviewed the peer service environment test and route registry. Only test comparison order changes; production registration order, the customizations inventory, and README overview and onboarding remain unchanged.
