### Maintenance

- Moved the Host Codex refresh lease from the previous change out of the generic server bootstrap: the installation account consumers now create it from a provider-neutral session activity callback and return a neutral start hold to the agent manager. The bootstrap names no provider again, as its architecture test requires, and the circular type inference that broke the `tsc` server build is gone. No behavior change (#563).

## Maintenance review

Wiring only, in the daemon bootstrap and the account consumer module; no inventory entry changes. README overview and onboarding are unchanged. Not published.
