### Fixes

- Preserve Codex child lifecycle observations when history reconstructs a stale launch card. Ordinary child progress cannot settle or reopen the child turn.

## Maintenance review

Codex tracks native child turn status separately from replay routes and presentation updates. Native completion and interruption still settle the child. The observations expire with the provider transport.
