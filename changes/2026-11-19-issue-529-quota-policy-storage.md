### Maintenance

- Daemons can store an optional quota policy: per-account pool membership and the share of quota each priority must leave unused. Nothing enforces it yet; launches, account choice, switches and pauses behave as before. Daemons that store it advertise `quotaPolicy`.
- Added a pure floor evaluator that reports whether an account is above or below its floor for a priority, unmeasured or limited. Nothing calls it yet.

## Maintenance review

Issue #529, slice 6 of #518. Added the Quota policy floors entry under Incomplete integrations. The optional `quotaPolicy` key is on the mutable daemon config and its patch, with the `quotaPolicy` feature flag; priority names and percentages stay permissive on the wire and the daemon checks values when it accepts a patch. A patch that omits the key leaves a stored policy alone, a new policy replaces the old one whole, and `null` clears it. The installation coordinator projects only named keys, so a settings sync preserves a stored policy, which also means each environment keeps its own; shared ownership is still undecided. The evaluator uses the Factory account-choice freshness and lowest-window rules, so a reading older than 5 minutes is unmeasured. Tests extend the protocol wire compatibility suite and the daemon config store suite, and add one evaluator case table. README overview and onboarding are unchanged. Not installed.
