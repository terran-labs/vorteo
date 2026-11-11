### Fixes

- Return persisted Factory queue snapshots while one background refresh runs. Bound GitHub and agent reads, retain stale evidence after failures, and avoid repeated GitHub calls for paused or draining Factories. Bootstrap their first snapshot once when none is saved, and skip disabled Factories.
- Check cold refresh progress promptly in the overview and sidebar, then restore the normal slow interval.

## Maintenance review

Reviewed Factory queue persistence, optional response fields, cold and partial results, Dev route cancellation and refresh progress. Focused regressions cover stale reads, single-flight refresh and paused recovery. README overview and onboarding are unchanged. Source requires a daemon install before the server behavior is live.
