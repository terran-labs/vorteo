### Fixes

- Skip stall reviews for role threads of a Factory project the owner has paused or drained.
- Count a review as progress only when it starts a new background watcher, not when one was already running.

## Maintenance review

Follow-up to the stall review cost guards after a second independent review. The scan reads paused and drained Factory projects once per pass and skips threads whose `vorteo.factory-role` label names one; a failed read skips every Factory role thread for that pass. The runtime probe now answers live, none or unknown, so a watcher that predates a review no longer keeps the ladder alive, and a restarted provider no longer logs a negative cost. The existing review scan test covers a paused and an unpaused project. The agent lifecycle guide is updated; README overview and onboarding are unchanged.
