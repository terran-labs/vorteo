### Fixes

- The workspace hover card lists running services with preview links again.
- The composer's shortcut focus hint no longer shows on touch layouts.
- A missing worktree service reports "Vorteo worktree service is not configured".

## Maintenance review

An audit of merge 51f16b39f found three Vorteo behaviors it dropped: the hover card's preview rows (e4e3bca72; the component and its test survived unused), the touch exclusion on the composer's focus hint (1167acf35) and one rebranded error message (e0f82d126). Two other worktree errors still say "Paseo" because an upstream test asserts that text; changing them would conflict with every upstream merge for a cosmetic gain. The audit also found the sidebar quota card file unused after the footer redesign (469492c4e), which likely replaced it, and a dropped per-broadcast cache for legacy checklist projections that costs only throughput; both are left for follow-up. The customizations inventory and README need no updates.
