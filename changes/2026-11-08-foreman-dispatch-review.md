### Changes

- Foreman dispatch: waiting plans never block each other (the oldest overlapping issue goes first), planning-off issues get the same overlap check from a Foreman-posted file list, a worker stops before touching a file outside its plan until the Foreman clears the wider plan, and only the Foreman checks for a pause before sending a go.

## Maintenance review

Review fixes for the Foreman dispatch rules: no deadlock between waiting plans, overlap clearance for planning-off and widened plans, and one consistent pause check. Charter and docs only. README overview and onboarding are unchanged.
