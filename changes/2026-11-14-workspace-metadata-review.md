### Fixes

- Preserve linked workspace classification when a bare repository selects that checkout as its main worktree.
- Report missing archived local checkouts correctly even when an older metadata projection persisted them as worktrees.

## Maintenance review

Checkout discovery now uses the canonical Git directory and common directory to distinguish linked worktrees without adding status scans or upstream calculations. Recovery normalizes the unavailable classification of unowned archived records that name their own checkout as the source, without rewriting retained records or recreating missing directories. Existing real-Git tests now cover bare sources, checkout aliases and records archived before reconciliation. Historical submodule classification is unchanged and remains a known limitation. README overview and onboarding are unchanged; no merge or installation is included.
