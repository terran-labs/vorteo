### Fixes

- Keep Codex child lifecycle notifications live while reading history. Child model updates no longer report lifecycle status.

## Maintenance review

Codex replay collects its own child events. Native child starts and completions continue to reach restart accounting during attach and history reads. The README overview and onboarding are unaffected.
