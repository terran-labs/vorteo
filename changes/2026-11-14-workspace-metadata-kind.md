### Fixes

- Keep ordinary repository checkouts classified as local workspaces during metadata-only discovery, creation and reconciliation, preserving missing-directory recovery behavior.
- Count workspace rows rather than their drag wrapper buttons in grouped-project browser checks.

## Maintenance review

Updated the checkout-discovery inventory to distinguish ordinary checkouts from linked worktrees without bringing back status scans or upstream calculations. Real Git regression coverage exercises shared local workspace creation, placement repair and unavailable recovery after directory removal. The grouped-project selector follows exact row identities; its saved failing trace showed two rows counted as four buttons. README overview and onboarding are unchanged. No merge or installation is included.
