### Fixes

- The Codex switch check now compares login sessions rather than current refresh tokens, so Dev holding a stale copy of the Host's sign-in is still treated as the Host's own and held while it is replaced. Dev makes the decision inside the write from fingerprints the coordinator sends with each delivery, and the separate comparison request and its flag are gone (#658).

## Maintenance review

Review of PR #661: the `fingerprint` operation, `sessions` titles and `adoption.sameGrant` are replaced, before any release, by the `session-check` operation and `adoption.sessionCheck`. Both carry two HMAC-SHA256 fingerprints of the Host ID token's `sub` with `sid` and with `auth_time` under a single-use nonce, and sign-ins count as separate only when both are present on both sides and both differ. The refresh-token fingerprint helpers are deleted. The providers guide, protocol notes and the adopted legacy Codex inventory entry are updated. README overview and onboarding are unchanged. Not published.
