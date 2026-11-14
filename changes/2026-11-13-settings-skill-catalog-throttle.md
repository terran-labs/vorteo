### Fixes

- Reuse successful background skill catalog settlement for one minute, reducing repeated directory scans while other shared settings continue reconciling every five seconds.

## Maintenance review

The installation settings coordinator keys settlement reuse by environment identity, settings revision, available skill definitions and exclusions. Explicit reconciliation, settings changes, projection and errors invalidate reuse; unsettled results are never cached and projection verification reads fresh state. External skill drift can take up to one minute to trigger background reconciliation. Live activation requires a coordinator update and is deferred to planned coordinator maintenance. This is separate from a daemon update. README overview and onboarding are unchanged.
