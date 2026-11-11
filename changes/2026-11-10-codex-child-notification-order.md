### Fixes

- Preserve the order of Codex child starts and completions when history discovers their route. A child can keep running after the parent turn finishes.

## Maintenance review

Codex registers historical child routes on its notification queue and drains older notifications before processing newer ones. Pending child notifications retain their existing limits and clear when the provider transport ends.
