### Maintenance

- Refresh Host watch against current main while preserving its read-only reporting behavior.

## Maintenance review

Resolved the customizations inventory conflict by keeping the Host watch entry and main's updated System status entry, including its focused test reference. The reporting script and its CI coverage remain included. Focused validation covers pressure thresholds, descriptor counts, stale worktrees, backup coverage and Dev worktree parsing. No watcher was installed or run against the live Host. README overview and onboarding are unchanged.
