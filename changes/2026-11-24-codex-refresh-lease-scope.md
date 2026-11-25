### Maintenance

- Narrowed the Host Codex refresh lease from the previous change before release: an idle loaded Host session no longer blocks coordinator refreshes, which would have left Dev's projection to expire. The lease now refuses only while a session starts or runs a turn, and the coordinator leaves the token's last ten minutes to a loaded session. Codex starts before the lease, and a refresh is stopped before the lease ends (#563).

## Maintenance review

Corrects the unreleased legacy Codex adoption fragment and [providers](../docs/providers.md#host-owned-codex-sign-in-for-installations) for the narrower lease, its residual window and the unleased probes. The inventory entry is updated. README overview and onboarding are unchanged. Not published.
