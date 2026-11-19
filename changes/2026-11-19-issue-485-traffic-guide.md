### Improvements

- Add bounded, client-scoped full-frame repeat fingerprints and sampled content-repeat estimates for provider snapshots and timeline traffic, with unknown coverage, input budgets and one disable constant.
- Document daily capture across process epochs, observation limits and the nontrivial log volume of capped diagnostic output.

### Fixes

- Classify direct sockets by their HTTP attachment context so traffic observation supports existing socket adapters and test doubles without a concrete WebSocket constructor.

## Maintenance review

Updated outbound traffic accounting in the customization inventory and development guide. Repeat estimates do not prove semantic equality, successful receipt or avoidable network bytes. README overview and onboarding are unchanged; live diagnostic acceptance remains open.
