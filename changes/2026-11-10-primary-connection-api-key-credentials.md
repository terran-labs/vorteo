### Fixes

- Claude and Codex connections that sign in with an API key, token, gateway or cloud provider are no longer treated as having no credentials, so a primary connection of that kind still launches.

## Maintenance review

Addressed the third review of the primary connection. Usage fetchers receive each provider's configured environment for this check. The inventory entry records the rule. README is unchanged.
