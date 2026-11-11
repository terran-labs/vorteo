### Fixes

- Preserve the latest Codex child start and terminal observations when its bounded pre-route buffer fills. Root completion can no longer discard a genuine running child after progress evicts older frames.

## Maintenance review

The restart inventory now records lifecycle-aware eviction within the existing buffer cap. Saturation coverage extends the existing child-start fixture for progress, lifecycle-only buffers, terminal delivery and reused native thread identifiers. README overview and onboarding are unchanged. Source only; independent review and live acceptance remain open.
