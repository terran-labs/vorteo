### Fixes

- Preserve the timeline cursor when a provider closes during a history read. The Retry button can attempt a fresh history load during the polling cooldown.

## Maintenance review

Timeline reads recheck session creation at the loader boundary. Explicit Retry requests share in-flight work and allow one extra load per cooldown. Older hosts still receive the ordinary timeline request.
