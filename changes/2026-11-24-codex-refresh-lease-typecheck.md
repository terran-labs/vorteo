### Maintenance

- Fixed the server build for the Host Codex refresh lease from the previous change: the lease and the agent manager each refer to the other at startup, which the `tsc` build could not infer, so the lease now has an explicit type. No behavior change (#563).

## Maintenance review

Type annotation only in the daemon bootstrap; no inventory entry changes. README overview and onboarding are unchanged. Not published.
