### Fixes

- Discard orphan Codex child terminal and progress notifications at root completion so a reused child route cannot inherit a false completion. Preserve genuine child starts and their later notifications across the root boundary.

## Maintenance review

The restart child-liveness inventory now distinguishes orphan notification cleanup from live child work. This corrects the buffer lifetime introduced by the incident routing repair, with regressions for foreign terminals, actual root completion and both child start formats. README overview and onboarding are unchanged. Source only; independent review and live acceptance remain separate.
