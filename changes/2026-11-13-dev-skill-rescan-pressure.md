### Fixes

- Reuse unchanged skill package inventory summaries during repeated shared-settings checks. Invalidation compares recursive path, type, size, timestamp and inode metadata, including receipts and executable modes, so nested edits and package replacement refresh the inventory without reopening unchanged package contents.
- Keep skill mutation, detail, export and launch validation uncached. Inventory discovery still checks for additions and removals; cached summaries are bounded and do not authorize changes.

## Maintenance review

Reviewed the five-second shared-settings reconciliation path through skill catalog inventory. Remote catalog checks remain necessary because unchanged settings do not prove unchanged files in another environment. README overview and onboarding are unchanged. Codex app-server file-open attribution is tracked separately from this daemon inventory fix.
